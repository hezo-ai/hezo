import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
	AgentEffort,
	type AgentRuntime,
	type AiProvider,
	CEO_AGENT_SLUG,
	CHAT_WINDOW_RETAIN_MESSAGES,
	ChatChannel,
	ChatConversationKind,
	ChatMessageRole,
	ChatMessageStatus,
	ChatSessionStatus,
	ChatSystemMessageKind,
	type CommentAttachment,
	credentialSerializesRuns,
	DEFAULT_TEAM_ID,
	effectiveRuntime,
	PROVIDER_RUNTIME_ADAPTERS,
	RUNTIME_SYSTEM_PROMPT_FILE,
	type WsChatServerMessage,
	WsMessageType,
	wsRoom,
} from '@hezo/shared';
import { runtimeConfig } from '../config/runtime';
import type { DomainEventBus } from '../events/bus';
import { trackBackground } from '../lib/background';
import { broadcastRowChange } from '../lib/broadcast';
import { loadChatMessageAttachments } from '../lib/chat-attachments';
import { KeyedLockTimeoutError } from '../lib/keyed-lock';
import { withTransaction } from '../lib/sql';
import { getMaxChatHistorySize } from '../lib/system-meta';
import { logger } from '../logger';
import { signChatSessionJwt } from '../middleware/auth';
import {
	acquireCredentialLock,
	assertPromptDeliverable,
	buildRuntimeInvocation,
	CAPACITY_PARK_MAX_MS,
	CREDENTIAL_WAIT_CAP_MS,
	type CredentialLockHolder,
	credentialLockHolder,
	credentialWaitNotice,
	describeCredentialHolder,
	type EgressEnvDescriptor,
	getContainerPromptPath,
	getPromptRelPath,
	type RunnerDeps,
	recoverOffStreamRunUsage,
	type SubscriptionMount,
} from './agent-runner';
import {
	type AgentChatParser,
	type AgentRunUsage,
	createAgentChatParser,
} from './agent-stream-parser';
import {
	type AiProviderCredentialAndModel,
	getProviderCredentialAndModel,
	selectProviderConfig,
} from './ai-provider-keys';
import { checkOverBudget, type OverBudgetBlock, recordRunCost } from './budget';
import {
	buildConversationTaskDescription,
	chatTranscriptLine,
	getChatMemory,
	loadActiveWindow,
	markCompacted,
	selectFlush,
	type WindowMessage,
} from './chat-memory';
import { detectNoWakeExits, formatNoWakeExitWarning } from './comment-wakeups';
import { loadConnectorDescriptors } from './connectors/connections';
import { reportConnectorRunRejection } from './connectors/run-rejection';
import type { ContainerLogStreamer } from './container-logs';
import { type ContainerRunUser, resolveContainerRunUser } from './container-user';
import {
	acquireRunContainer,
	type ContainerDeps,
	PoolCapacityError,
	PoolHoursExhaustedError,
} from './containers';
import { getAgentSystemPrompt } from './documents';
import type { EffortRuntimeApplication } from './effort';
import type { ConnectorRunRejection } from './egress';
import { applyEffortToRuntime } from './runtime-adapters';
import {
	persistRotatedSubscriptionAuth,
	type RuntimeHomeMount,
	refreshSubscriptionMount,
} from './runtime-home';
import { resolveRuntimeForTask } from './runtime-resolver';
import { dockerSandboxHandle } from './sandbox/handle';
import { setPoolMemberChatReservation } from './sandbox/pool-db';
import { type RunTunnel, startRunTunnel } from './sandbox/tunnel/run-tunnel';
import { buildTunnelHostPolicy } from './sandbox/tunnel/split-routing';
import type { BridgeRunnerArgs } from './ssh-agent';
import { type CreateTaskCaller, createTask, type TaskRow } from './tasks';
import { resolveSystemPrompt } from './template-resolver';
import { CONTAINER_WORKSPACE_ROOT, getRunSocketPath } from './workspace';
import type { WebSocketManager } from './ws';

const log = logger.child('chat-session');

/** Container working directory for the (repo-free) chat session. */
const CHAT_WORKING_DIR = '/workspace';

/**
 * How long streaming deltas batch before one frame goes out per in-flight
 * message. Short enough that typing still reads live (a token stream repaints
 * ~7x a second), long enough to collapse the per-line frame bursts some
 * runtimes emit into an order of magnitude fewer sends.
 */
const DELTA_FLUSH_MS = 150;

/**
 * How the chat names itself as a credential holder. No link: a chat turn has no
 * page of its own for a waiting run to point at.
 */
const CHAT_CREDENTIAL_HOLDER: CredentialLockHolder = { label: 'the CEO chat', link: null };

/**
 * How often a capacity-parked chat turn retries the acquire. The runner's
 * cadence, for the runner's reason: nothing is event-driven on container
 * release, so polling is the only signal, and the pass that frees capacity runs
 * on the job manager's 5s clock.
 */
const CHAT_CAPACITY_POLL_MS = 5_000;

/**
 * The turn was refused before it ran: a spend budget is exhausted. Rendered as
 * the budget-exceeded system row; the chat resumes when the window rolls over
 * or the operator raises the figure.
 */
export function chatBudgetExceededNotice(block: OverBudgetBlock): string {
	const scope = block.scope === 'agent' ? 'This agent has' : 'This project has';
	return (
		`${scope} spent its ${block.period} budget, so chat is paused. ` +
		'It resumes when the window rolls over, or when the budget is raised on the Budget page.'
	);
}

/** The hours half of the same refusal - decision-level twin of the spend notice. */
export const CHAT_HOURS_EXHAUSTED_NOTICE =
	'This chat cannot start a container: the instance has spent its monthly container-hours ' +
	'allowance. It resumes when the month turns, or when the allowance is raised on the Budget page.';

/** The turn is parked on the instance memory budget; said in the thread at once. */
export const CHAT_CAPACITY_WAIT_NOTICE =
	'Waiting for capacity: every container the memory budget allows is in use. ' +
	'This turn starts as soon as one frees.';

/**
 * A chat exec gave up waiting for the provider credential. The message names
 * the holder the way a run log does, so the operator can go and look at it.
 */
export class ChatCredentialBusyError extends Error {
	constructor(holder: CredentialLockHolder | null) {
		super(
			`${holder ? describeCredentialHolder(holder) : 'Another execution'} is still using this provider credential; ` +
				'this subscription runs one agent at a time.',
		);
		this.name = 'ChatCredentialBusyError';
	}
}

const CHAT_GUIDE = `# Live Chat

You are in a real-time chat with the operator — the human running this Hezo instance — through the web app. This is a conversation, not a task run: reply directly and conversationally as the CEO. You hold cross-team privileges here, so you can read from and act across every project in the org: \`list_projects\` returns every project across the org, and the project roster already in your context is rebuilt each turn. Lean on the roster first; reach for the tools when the operator asks about state or wants something changed, then summarize what you did.

Because you roam across every project here, there is **no per-project "Project State" block in your context** — its open-task count in the roster is a summary only. To report a project's live status (its actual tasks and their statuses, or its roster), call \`list_tasks\` / \`list_agents\` with that project's slug as the \`project\` argument. Never tell the operator a project is empty off the roster count alone — check with the tools first.

Because this chat is human-facing, refer to projects, tasks, teams, docs, and teammates by their bare slug, identifier, or name (e.g. the project todo6, task TO-1, prd.md, @@captain) — never paste raw UUIDs. Tools accept the same slugs and identifiers you use with the operator, so you never need a UUID. Write entity references bare, never wrapped in backticks: bare references render as clickable links in the chat, while backticked ones render as inert code and break the link. Keep replies focused and skip ceremony.

## Long-term memory

Your context carries a **Long-term memory** block (below the guide, above the conversation) — your durable notes across this chat, maintained automatically. The recent conversation is kept verbatim in a rolling window; when it grows past its size cap the whole window is summarized into this long-term memory and the older messages drop out of the window, so the gist of past exchanges survives even after the raw messages scroll away.

You don't need a "remember" instruction from the operator and there's no manual save step for ordinary chat — the system compacts the window into memory for you. When a compaction is due you'll be handed the window and asked to fold its durable points into memory with \`update_chat_memory\`; you may also call that tool yourself any time you want to record something standing. Keep memory short and curated — **durable, standing knowledge only** (operator preferences, decisions, the gist of off-project threads), never live data you can re-fetch each turn (project/task/comment state, rosters, counts). That is rebuilt into your context every turn; copying it into memory only goes stale.

## Producing files for the operator

When the operator asks you to produce a file directly in this chat — an HTML demo or mockup, an SVG diagram, a plain-text export — save it to an **assets library** with \`write_project_asset\`, then reference it **bare** as \`assets/<filename>\` in your reply so it renders as a link the operator can open (HTML opens interactively in a new tab). The library takes text-based files (.html, .svg, .txt); re-saving the same filename overwrites it, so the reference stays stable as you iterate.

**Save it to the project the work belongs to.** If the conversation is about a specific project — or you're doing something for one — pass that project's slug, so the deliverable lives with its project (the same goes for any markdown you write with \`write_project_doc\`). Only when the work is **not** tied to any project — ad-hoc research, a one-off demo, instance-level help — save it to **hq** (project: hq). When unsure which project something belongs to, ask the operator rather than defaulting to hq.

Do **NOT** write the file loose into the workspace (e.g. \`/workspace/demo.html\`) and hand the operator that path — \`/workspace\` lives inside the agent container, not on their machine, so they cannot open it and the file is invisible to them. The asset library is the only durable, operator-reachable home for files you produce here. For a binary deliverable the library can't author (a generated image or PDF), say so rather than pointing at a container path.`;

/**
 * Guide for group/coworker-mode turns — the CEO @-mentioned inside an external
 * group channel it was invited to (a Slack channel, later a WhatsApp group).
 * Replaces CHAT_GUIDE for `kind='coworker'` conversations: multi-party framing,
 * ephemeral fetched context, replies posted into the platform thread. No
 * long-term-memory section — that memory belongs to the operator's assistant
 * chat, and coworker windows never compact into it.
 */
const GROUP_CHAT_GUIDE = `# Group Channel Chat

You were @-mentioned in an external group channel (e.g. a Slack channel) that you — the Hezo CEO — joined as a coworker. This is a **multi-party conversation between humans**; you are one participant, not a private assistant. Your reply is posted into the channel thread where you were mentioned, visible to everyone there.

- Transcript lines are labelled with each sender's name. Address people by name when it helps, and pay attention to who asked what.
- A **Channel context** section (when present, above the conversation) is the surrounding channel history fetched live from the platform for THIS reply only. It is ephemeral — not part of your stored conversation — so treat it as background reading: use it to understand what the humans were discussing, but don't assume you'll see it again next turn.
- The **Conversation so far** section contains only the exchanges that directly involved you in this thread (mentions of you and your replies).
- People will often discuss something among themselves and then mention you to act on it — "make a plan from our chat", "document this", "create tasks for what we agreed". Read the channel context, then do the work with your tools and report back in the thread.
- You hold the same cross-team privileges as everywhere: \`list_projects\`, \`list_tasks\`, \`create_task\`, \`write_project_doc\`, and the rest all work here. Refer to projects, tasks, teams, and docs by bare slug/identifier — never raw UUIDs.
- Keep replies chat-app-sized: concise, plain markdown (the platform's formatting is limited), no ceremony. For substantial output (a plan, a document), write it with \`write_project_doc\`/\`write_project_asset\` into the right project and reply with a short summary naming where it landed.
- Your replies always post into the external channel thread; the operator can also read this conversation (read-only) from the Hezo web chatbox. If someone asks for something that needs the operator's private attention, say so and suggest they raise it with the operator directly.`;

/**
 * Hard cap on how many window messages a coworker-mode prompt replays. Coworker
 * conversations never compact (compaction would fold group chatter into the
 * operator's shared long-term memory), so this cap bounds the prompt instead —
 * older mention exchanges simply age out of the replayed window. Companion to
 * CHAT_WINDOW_RETAIN_MESSAGES, which governs the assistant-mode compaction tail.
 */
const COWORKER_WINDOW_MAX_MESSAGES = 40;

/**
 * Render the long-term memory data block injected into every turn. The curation
 * rules live in CHAT_GUIDE; this is just the current contents (or a placeholder
 * when empty so the agent knows the facility exists).
 */
export function formatLongTermMemoryBlock(content: string): string {
	const trimmed = content.trim();
	const body = trimmed === '' ? '_(nothing recorded yet)_' : trimmed;
	return `## Long-term memory\n\nMaintained automatically across this chat — see the guidance above. Update it with update_chat_memory.\n\n${body}`;
}

/**
 * Prompt for a headless compaction run. The agent gets its current long-term
 * memory and the full active window, and must rewrite memory (via
 * `update_chat_memory`) to fold in the window's durable points — not reply to
 * the operator. The window's raw messages are about to be evicted, so anything
 * worth keeping has to land in memory now.
 */
export function buildCompactionPrompt(currentMemory: string, windowTranscript: string): string {
	const mem = currentMemory.trim() === '' ? '_(empty)_' : currentMemory.trim();
	return `# Compact your chat memory

This is a maintenance step, not a reply to the operator. The recent conversation window below has grown past its size cap and is about to be trimmed — all but the last few messages will be dropped from the live chat. Before that happens, update your **long-term memory** so nothing durable is lost.

Call the \`update_chat_memory\` tool with the FULL revised memory markdown (it replaces the stored memory wholesale — there is no append). Merge the window's durable points into the existing memory below; keep it short, curated, and free of stale or duplicate entries.

Record **durable, standing knowledge only**:
- Operator preferences, guidelines, defaults, tone, and recurring decisions.
- A rough running gist of any substantial off-project thread (ad-hoc research, advice, a one-off you built for the operator) — a line or two per topic, not a transcript. These chats are stored nowhere else, so capture the gist or it is lost.

Do **NOT** record live data you can re-fetch each turn — project/task/comment state, rosters, counts. That goes stale; the tools are the source of truth.

Do not reply to the operator and do not produce any other output — just call update_chat_memory once with the merged result, then stop.

## Current long-term memory

${mem}

## Conversation window to fold in

${windowTranscript}`;
}

/** Longest title we keep — anything past this is truncated when persisting. */
const MAX_CHAT_TITLE_LENGTH = 60;

/**
 * Prompt for a headless auto-title run. The agent gets the conversation so far and
 * must return ONLY a short topic title as plain text (no tools, no reply to the
 * operator). Its stdout is captured and stored as the thread title. Deliberately
 * omits the CEO system prompt — the file is the whole input, exactly like compaction.
 */
export function buildTitlePrompt(windowTranscript: string): string {
	return `# Name this conversation

This is a maintenance step, not a reply to the operator. Read the conversation below and produce a short, specific title that captures its topic.

Rules:
- 3–6 words, Title Case.
- Output ONLY the title text — no quotes, no surrounding punctuation, no markdown, no preamble or explanation.
- Do NOT call any tools and do NOT reply to the operator. Just print the title and stop.

## Conversation

${windowTranscript}`;
}

/**
 * Reduce a raw title-generation output to a stored title: first non-empty line,
 * stripped of surrounding quotes/backticks, whitespace collapsed, capped in length.
 * Returns null when nothing usable remains (leave the thread untitled, retry later).
 */
export function sanitizeChatTitle(raw: string): string | null {
	const firstLine = raw
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	if (!firstLine) return null;
	const cleaned = firstLine
		.replace(/^['"`*_#\s]+/, '')
		.replace(/['"`*_\s]+$/, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!cleaned) return null;
	return cleaned.length > MAX_CHAT_TITLE_LENGTH
		? cleaned.slice(0, MAX_CHAT_TITLE_LENGTH).trim()
		: cleaned;
}

export interface CeoSessionDeps extends RunnerDeps {
	wsManager: WebSocketManager;
	containerLogStreamer?: ContainerLogStreamer;
}

interface LiveSession {
	sessionId: string;
	ceoMemberId: string;
	projectId: string;
	containerId: string;
	runUser: ContainerRunUser;
	runtimeType: AgentRuntime;
	env: string[];
	execCmd: string[];
	promptDirective: string | null;
	/** See {@link HostSideAllocation.subscriptionMount}. */
	subscriptionMount: SubscriptionMount | null;
	/** See {@link HostSideAllocation.homeMount}. */
	homeMount: RuntimeHomeMount | null;
	releaseEgress: () => Promise<void>;
	releaseSsh: () => Promise<void>;
	/** Tears down the session's tunnel. Idempotent; see {@link HostSideAllocation}. */
	closeTunnel: () => void;
	/** What resume needs to rebuild the host-side half; see {@link HostSideInputs}. */
	invocationInputs: HostSideInputs;
}

/**
 * Everything the host-side half of a session start needs, captured once so
 * resume can re-run it without re-resolving the CEO, the runtime and the
 * provider credential.
 */
interface HostSideInputs {
	ceoMemberId: string;
	projectId: string;
	provider: AiProvider;
	credential: AiProviderCredentialAndModel;
	runtimeType: AgentRuntime;
	modelOverride: string | null;
}

/**
 * Which provider, on which CLI, from which credential row, at which model - the
 * whole choice a session's turns are built from, minus the secret. Resolved
 * without the master key so it can also be re-answered on a locked instance.
 */
interface InvocationSelection {
	provider: AiProvider;
	runtimeType: AgentRuntime;
	configId: string;
	modelOverride: string | null;
	/**
	 * The CLI the credential read must match, or null on the agent-override path
	 * where the credential's own runtime decides. Carried so the caller hands
	 * `getProviderCredentialAndModel` exactly what this selection was made with.
	 */
	requiredRuntime: AgentRuntime | null;
}

/**
 * The identity of what a session's turns run on. Session start bakes all four
 * into the container env, the exec command and the runtime config files, so a
 * change to any of them reaches the chat only by starting a new session.
 *
 * Non-secret by construction: the credential is named by its row id, never by
 * any part of its value.
 */
function invocationFingerprint(
	provider: AiProvider,
	runtimeType: AgentRuntime,
	configId: string,
	modelOverride: string | null,
): string {
	return `${provider}|${runtimeType}|${configId}|${modelOverride ?? ''}`;
}

/**
 * The half of a session that lives on the Hezo side and does **not** survive its
 * container being suspended: the ssh agent socket and egress proxy allocations
 * (whose ports change), the session JWT, and the exec command and env built
 * around them. Start and resume both produce one of these, which is why it is a
 * shape rather than an inline block in `startSession`.
 */
interface HostSideAllocation {
	env: string[];
	execCmd: string[];
	promptDirective: string | null;
	/**
	 * The subscription file this session's CLI reads, when it has one. Kept
	 * because a rotating credential has to be read back out of the container
	 * after every exec that could have rewritten it.
	 */
	subscriptionMount: SubscriptionMount | null;
	/**
	 * The per-session runtime home mount, when the runtime has one. Kept so a
	 * turn can recover off-stream usage from the files some CLIs write there
	 * (and scrub them - they can carry the provider credential).
	 */
	homeMount: RuntimeHomeMount | null;
	releaseEgress: () => Promise<void>;
	releaseSsh: () => Promise<void>;
	/**
	 * The session's tunnel goes with the rest of this half, because everything it
	 * points at does: its targets are the ssh and egress allocations above, whose
	 * ports are gone after a suspend. Leaving it open would also keep the
	 * container active on a backend that bills for that.
	 */
	closeTunnel: () => void;
}

interface CurrentTurn {
	assistantMessageId: string;
	abort: AbortController;
	promise: Promise<void>;
	/** The turn's scope, so a session-wide event can be posted into the thread it concerns. */
	ctx: ConversationContext;
}

/**
 * Per-turn scope, resolved once per send. `channel`/`externalThreadId` are the
 * TURN's origin — the surface the triggering message came from — not a property
 * of the conversation: replies are delivered where they were asked (a web-sent
 * turn into a Telegram-origin thread streams to web only; a Telegram-sent turn
 * answers in Telegram). The warm container is shared across all conversations.
 */
export interface ConversationContext {
	conversationId: string;
	/** Surface this turn arrived from; delivery target when not web. */
	channel: ChatChannel;
	/** Platform thread id the turn arrived from (Telegram "<chat>:<topic>", …); null for web. */
	externalThreadId: string | null;
	/**
	 * The conversation's kind. `assistant` = the operator's own thread (web, app
	 * DM, designated-supergroup topic). `coworker` = a team-channel thread —
	 * queue-not-interrupt, no compaction/auto-title/memory, read-only from web.
	 */
	kind: ChatConversationKind;
}

/**
 * Per-conversation turn bookkeeping. The warm session (`LiveSession`) is shared;
 * this is what must be per-thread so two conversations can run concurrently while
 * two messages in the *same* thread still serialize + interrupt.
 */
interface ConversationRuntime {
	conversationId: string;
	turnLock: Promise<unknown>;
	current: CurrentTurn | null;
	compaction: Promise<void> | null;
	compactionAbort: AbortController | null;
	// In-flight auto-title run for this thread (runs in parallel with the reply,
	// off its own prompt file). Tracked so a second one never runs concurrently and
	// so a new turn / close can preempt it.
	titling: Promise<void> | null;
	titlingAbort: AbortController | null;
}

/**
 * Registry-wide channel hooks. Every call names a `ChatChannel` enum value; the
 * registry resolves the adapter, so the manager stays channel-agnostic. Both are
 * best-effort at the call site. There is no thread creation or mirroring — a
 * conversation's one external surface is where inbound turns arrive from and
 * where their replies are delivered.
 */
export interface ChannelHooks {
	/** Post a message to a channel's platform thread. */
	deliver: (
		channel: ChatChannel,
		externalThreadId: string,
		content: string,
		status: ChatMessageStatus,
	) => Promise<void>;
	/** Close/archive a channel's platform thread. */
	closeThread: (channel: ChatChannel, externalThreadId: string) => Promise<void>;
}

/**
 * Owns the single persistent CEO chat session. Unlike a one-shot task run, the
 * session keeps warm resources (egress proxy, ssh socket, MCP token, runtime
 * config) for the HQ container and runs each turn as a one-shot exec with the
 * conversation history composed into the prompt — uniform across every runtime,
 * no held-open process. A new message interrupts an in-flight reply and starts
 * a fresh turn whose prompt already includes the prior message.
 */
export class ChatSessionManager {
	private live: LiveSession | null = null;
	/**
	 * The live session is parked on a stopped-but-intact container: its row is
	 * still live and still owns the container, but its host-side allocations have
	 * been released, so no turn may exec until {@link resumeSession} rebuilds them.
	 */
	private suspended = false;
	private ensuring: Promise<LiveSession> | null = null;
	private healthTimer: ReturnType<typeof setInterval> | null = null;
	// Per-conversation turn bookkeeping (lock + in-flight turn + compaction). Keyed
	// by conversationId. Two conversations run concurrently; the per-conversation
	// lock serializes sends within a thread so the interrupt guard aborts the prior
	// turn and only the latest one streams.
	private convos = new Map<string, ConversationRuntime>();
	// Long-term memory (`chat_memories`) is keyed by the CEO member, so it is shared
	// across every thread. Compaction rewrites the whole row, so all threads'
	// compactions serialize here to avoid clobbering each other's memory write.
	private memberCompactionLock: Promise<unknown> = Promise.resolve();
	// Registry-wide channel hooks, set by the channel layer at wiring time. The
	// manager reaches every channel generically through these — it only ever names
	// the `ChatChannel` enum value; the registry resolves the adapter. This is the
	// seam that keeps delivery and close channel-agnostic (a new channel touches no manager code).
	private channelHooks: ChannelHooks | null = null;
	// Pending coalesced delta text per streaming message, flushed on one shared
	// short timer (see broadcastDelta). Bounded by construction: entries only
	// exist between a delta arriving and the next flush, at most one per
	// in-flight assistant message.
	private deltaBuffers = new Map<string, { conversationId: string; text: string }>();
	private deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly deps: CeoSessionDeps) {}

	/** Register the registry-wide channel hooks (called once at wiring time). */
	setChannelHooks(hooks: ChannelHooks): void {
		this.channelHooks = hooks;
	}

	/** Introspection (tests): is any thread's background compaction still in flight? */
	hasInflightCompaction(): boolean {
		for (const c of this.convos.values()) if (c.compaction) return true;
		return false;
	}

	private getConvoRuntime(conversationId: string): ConversationRuntime {
		let rt = this.convos.get(conversationId);
		if (!rt) {
			rt = {
				conversationId,
				turnLock: Promise.resolve(),
				current: null,
				compaction: null,
				compactionAbort: null,
				titling: null,
				titlingAbort: null,
			};
			this.convos.set(conversationId, rt);
		}
		return rt;
	}

	start(): void {
		if (this.healthTimer) return;
		this.healthTimer = setInterval(() => {
			trackBackground(this.checkHealth().catch((e) => log.error('health check failed', e)));
		}, runtimeConfig().chat.healthIntervalMs);
	}

	async stop(): Promise<void> {
		if (this.healthTimer) {
			clearInterval(this.healthTimer);
			this.healthTimer = null;
		}
		this.flushDeltas();
		await this.shutdown();
	}

	/**
	 * Mark sessions left `starting`/`running` by a previous process as crashed —
	 * their in-container process (if any) is orphaned and the in-memory state is
	 * gone. Frees the singleton index so a fresh session can start.
	 *
	 * Three statements and nothing else, so like the job manager's own DB repair
	 * it runs at boot regardless of lock state - an instance that comes up locked
	 * would otherwise serve a session that reads as live and can never answer.
	 */
	async reconcileDatabaseOnStartup(): Promise<void> {
		await this.deps.db.query(
			`UPDATE chat_sessions SET status = $1, stopped_at = now()
			 WHERE status IN ($2, $3)`,
			[ChatSessionStatus.Crashed, ChatSessionStatus.Starting, ChatSessionStatus.Running],
		);
		// No CEO turn survives a process restart, so any message left in a non-terminal
		// state (streaming/pending) is orphaned — its run is gone. Empty ones are pure
		// "thinking" placeholders with nothing to show: delete them so they don't reload
		// as perpetual dots. Non-empty ones kept a partial reply: mark them interrupted.
		await this.deps.db.query(
			`DELETE FROM chat_messages WHERE status IN ($1, $2) AND content = ''`,
			[ChatMessageStatus.Streaming, ChatMessageStatus.Pending],
		);
		await this.deps.db.query(`UPDATE chat_messages SET status = $1 WHERE status IN ($2, $3)`, [
			ChatMessageStatus.Interrupted,
			ChatMessageStatus.Streaming,
			ChatMessageStatus.Pending,
		]);
	}

	/**
	 * Send a user turn to a conversation. Resolves the conversation (web default,
	 * an explicit thread, or an external thread), persists the user message,
	 * interrupts any in-flight reply *for that thread*, creates the streaming
	 * assistant row, and kicks the turn in the background. Returns the two message
	 * ids so the client can correlate streamed deltas.
	 */
	async sendTurn(input: {
		text: string;
		channel?: ChatChannel;
		conversationId?: string;
		externalThreadId?: string | null;
		authorUserId?: string | null;
		attachmentIds?: string[];
		/**
		 * Ordered batch of user messages to post as this turn's input. Each becomes
		 * its own message row (own bubble, own timestamp, own attachments) and then
		 * ONE reply answers all of them — what the web chatbox's message queue
		 * flushes when a reply finishes. Sending them as N separate turns instead
		 * would produce N replies, the first of which answers stale context.
		 * Supersedes `text`/`attachmentIds` when non-empty.
		 */
		messages?: Array<{ text: string; attachmentIds?: string[] }>;
		/** Conversation mode when creating (default assistant). Existing rows keep their kind. */
		kind?: ChatConversationKind;
		/** External sender display label for multi-party (coworker) transcripts. */
		authorLabel?: string | null;
		/**
		 * Ephemeral context (e.g. fetched Slack channel history) composed into THIS
		 * turn's prompt only — never persisted as a chat message, so it doesn't ride
		 * the window or compaction.
		 */
		injectedContext?: string;
		/** Title when creating the conversation (coworker threads are titled at birth). */
		title?: string;
	}): Promise<{
		userMessageId: string;
		userMessageIds: string[];
		assistantMessageId: string;
		conversationId: string;
	}> {
		const ctx = await this.resolveConversationForInput(input);
		const convo = this.getConvoRuntime(ctx.conversationId);
		// Serialize turns *within this conversation*: chain on the prior send so two
		// overlapping requests to the same thread run sequentially (the second only
		// after the first has set `current`), letting the interrupt guard abort the
		// prior turn instead of racing it. Different threads run concurrently.
		const run = convo.turnLock.then(
			() => this.runSendTurn(input, ctx),
			() => this.runSendTurn(input, ctx),
		);
		convo.turnLock = run.catch(() => undefined);
		return run;
	}

	private async runSendTurn(
		input: {
			text: string;
			authorUserId?: string | null;
			attachmentIds?: string[];
			messages?: Array<{ text: string; attachmentIds?: string[] }>;
			authorLabel?: string | null;
			injectedContext?: string;
		},
		ctx: ConversationContext,
	): Promise<{
		userMessageId: string;
		userMessageIds: string[];
		assistantMessageId: string;
		conversationId: string;
	}> {
		const { conversationId, channel } = ctx;
		const isCoworker = ctx.kind === ChatConversationKind.Coworker;
		const convo = this.getConvoRuntime(conversationId);

		// A user turn preempts any in-flight background compaction for this thread so
		// its prompt file and container exec are free, and so the new message is part
		// of the window the next compaction summarizes.
		if (convo.compactionAbort) {
			convo.compactionAbort.abort('interrupted');
			await convo.compaction?.catch(() => undefined);
		}

		// Preempt an in-flight auto-title run too: this turn re-kicks titling from the
		// richer window below (if the thread is still untitled), so drop the stale one
		// and free its exec. Awaited so `convo.titling` is cleared before the re-kick.
		if (convo.titlingAbort) {
			convo.titlingAbort.abort('interrupted');
			await convo.titling?.catch(() => undefined);
		}

		// An in-flight reply in this thread: assistant threads interrupt it (abort, keep
		// the partial as `interrupted`) so only the latest turn streams to the
		// operator. Coworker threads QUEUE instead — in a group channel two quick
		// mentions are two people expecting two answers, and an aborted partial would
		// silently post nothing to the platform (only completed replies deliver).
		if (convo.current) {
			if (!isCoworker) convo.current.abort.abort('interrupted');
			await convo.current.promise.catch(() => undefined);
		}

		// The operator's message is persisted BEFORE anything that can refuse the
		// turn - the budget gate, the container acquire - so a refusal never eats
		// what they typed: the message stands in the thread and the refusal appears
		// under it as a system row.
		const userMessageIds = await this.persistUserBatch(input, ctx);
		const userMessageId = userMessageIds[userMessageIds.length - 1];
		await this.touchConversation(conversationId);

		// Pre-turn spend gate: chat is metered like any run, so an exhausted agent
		// or project budget refuses the turn up front rather than billing past it.
		const gate = await this.checkChatBudget();
		if (gate) {
			const noticeId = await this.postSystemMessage(
				ctx,
				ChatSystemMessageKind.BudgetExceeded,
				chatBudgetExceededNotice(gate),
			);
			return { userMessageId, userMessageIds, assistantMessageId: noticeId, conversationId };
		}

		// The session (and with it the container acquire) can refuse for two
		// capacity-shaped reasons, told apart because they clear on different
		// clocks: exhausted hours wait for the calendar or the operator (refuse
		// now, like the budget gate), while a full memory budget clears when any
		// container frees (park the turn and keep trying in the background - the
		// send itself never hard-fails on it).
		let session: LiveSession | null = null;
		try {
			session = await this.ensureSession();
		} catch (e) {
			if (e instanceof PoolHoursExhaustedError) {
				const noticeId = await this.postSystemMessage(
					ctx,
					ChatSystemMessageKind.BudgetExceeded,
					CHAT_HOURS_EXHAUSTED_NOTICE,
				);
				return { userMessageId, userMessageIds, assistantMessageId: noticeId, conversationId };
			}
			if (!(e instanceof PoolCapacityError)) throw e;
		}

		const assistantMessageId = await this.insertMessage({
			conversationId,
			role: ChatMessageRole.Assistant,
			channel,
			status: ChatMessageStatus.Streaming,
			content: '',
			authorMemberId: session?.ceoMemberId ?? (await this.resolveCeoMemberId()),
			sessionId: session?.sessionId ?? null,
			completed: false,
		});
		this.broadcastStart(conversationId, assistantMessageId, ChatMessageRole.Assistant, channel, '');

		const abort = new AbortController();
		const promise = session
			? this.runTurn(session, ctx, assistantMessageId, abort, input.injectedContext)
			: this.runTurnAfterCapacityWait(ctx, assistantMessageId, abort, input.injectedContext);
		convo.current = { assistantMessageId, abort, promise, ctx };
		// Title the thread as early as possible: kick off title generation from the
		// first user message *in parallel* with the reply (off its own prompt file, so
		// the two execs never collide), so the switcher/rail label flips from "New
		// thread" while the CEO is still typing instead of only after the reply settles.
		// Compaction still waits for the reply — it rewrites the window this turn feeds.
		// Coworker threads skip both: they're titled at creation and never compact
		// (compaction would fold group chatter into the operator's shared memory —
		// COWORKER_WINDOW_MAX_MESSAGES bounds their prompt instead).
		if (!isCoworker) {
			trackBackground(this.maybeAutoTitle(ctx));
			trackBackground(promise.then(() => this.maybeCompact(ctx)));
		}

		return { userMessageId, userMessageIds, assistantMessageId, conversationId };
	}

	/**
	 * Persist one turn's user messages (a single message or a flushed queue
	 * batch), link their attachments, and broadcast each bubble. Each message is
	 * its own row and its own bubble; a single reply answers all of them.
	 */
	private async persistUserBatch(
		input: {
			text: string;
			authorUserId?: string | null;
			attachmentIds?: string[];
			messages?: Array<{ text: string; attachmentIds?: string[] }>;
			authorLabel?: string | null;
		},
		ctx: ConversationContext,
	): Promise<string[]> {
		const { conversationId, channel } = ctx;
		const batch =
			input.messages && input.messages.length > 0
				? input.messages
				: [{ text: input.text, attachmentIds: input.attachmentIds }];
		const userMessageIds: string[] = [];
		for (const message of batch) {
			const userMessageId = await this.insertMessage({
				conversationId,
				role: ChatMessageRole.User,
				channel,
				status: ChatMessageStatus.Complete,
				content: message.text,
				authorUserId: input.authorUserId ?? null,
				authorLabel: input.authorLabel ?? null,
				completed: true,
			});
			userMessageIds.push(userMessageId);
			// Link any uploaded files to the user message, then resolve their metadata so
			// the sent bubble streams in with its attachment chips already attached.
			const attachmentIds = message.attachmentIds ?? [];
			let userAttachments: CommentAttachment[] = [];
			if (attachmentIds.length > 0) {
				await this.deps.db.query(
					`INSERT INTO chat_message_attachments (chat_message_id, asset_id)
					 SELECT $1::uuid, asset FROM UNNEST($2::uuid[]) AS asset`,
					[userMessageId, attachmentIds],
				);
				userAttachments =
					(
						await loadChatMessageAttachments(
							this.deps.db,
							[userMessageId],
							this.deps.masterKeyManager,
						)
					).get(userMessageId) ?? [];
			}
			// Every thread is visible in the web view (coworker threads read-only), so
			// every turn broadcasts — the web renders the stored conversation live.
			this.broadcastStart(
				conversationId,
				userMessageId,
				ChatMessageRole.User,
				channel,
				message.text,
				userAttachments,
			);
		}
		return userMessageIds;
	}

	/**
	 * The chat's pre-turn spend gate. Fail-open on an infrastructure error: a
	 * broken check must not brick the operator's control surface, and the run
	 * path's own gates still stand.
	 */
	private async checkChatBudget(): Promise<OverBudgetBlock | null> {
		try {
			const ceoMemberId = await this.resolveCeoMemberId();
			const projectId = await this.resolveHqProjectId();
			return await checkOverBudget(this.deps.db, ceoMemberId, projectId);
		} catch (e) {
			log.warn(`chat budget check failed; allowing the turn: ${String(e)}`);
			return null;
		}
	}

	/**
	 * A turn parked on the instance memory budget: say so in the thread once,
	 * then retry the acquire on the runner's cadence until a container frees, the
	 * park deadline passes, or the operator interrupts. Runs in the background -
	 * the send already returned - so the person watches the parked state in the
	 * thread rather than a hanging request.
	 */
	private async runTurnAfterCapacityWait(
		ctx: ConversationContext,
		assistantMessageId: string,
		abort: AbortController,
		injectedContext?: string,
	): Promise<void> {
		const convo = this.getConvoRuntime(ctx.conversationId);
		const fail = async (error: string): Promise<void> => {
			await this.finalizeMessage(
				ctx.conversationId,
				assistantMessageId,
				ChatMessageStatus.Failed,
				'',
				null,
				error,
			);
		};
		try {
			await this.postSystemMessage(
				ctx,
				ChatSystemMessageKind.CapacityWait,
				CHAT_CAPACITY_WAIT_NOTICE,
			);
			const pollMs = this.deps.capacityPark?.pollMs ?? CHAT_CAPACITY_POLL_MS;
			const deadline = Date.now() + (this.deps.capacityPark?.maxMs ?? CAPACITY_PARK_MAX_MS);
			while (true) {
				if (abort.signal.aborted) {
					await this.finalizeMessage(
						ctx.conversationId,
						assistantMessageId,
						ChatMessageStatus.Interrupted,
						'',
						null,
					);
					return;
				}
				let session: LiveSession;
				try {
					session = await this.ensureSession();
				} catch (e) {
					if (e instanceof PoolHoursExhaustedError) {
						// The wait crossed into a spent allowance - a different clock, so a
						// different message, and no amount of freed memory ends it.
						await this.postSystemMessage(
							ctx,
							ChatSystemMessageKind.BudgetExceeded,
							CHAT_HOURS_EXHAUSTED_NOTICE,
						);
						await fail(e.message);
						return;
					}
					if (!(e instanceof PoolCapacityError)) {
						await fail((e as Error).message);
						return;
					}
					if (Date.now() >= deadline) {
						await fail('No container capacity freed up in time. Send again to retry.');
						return;
					}
					await new Promise((resolve) => setTimeout(resolve, pollMs));
					continue;
				}
				await this.runTurn(session, ctx, assistantMessageId, abort, injectedContext);
				return;
			}
		} finally {
			if (convo.current?.assistantMessageId === assistantMessageId) convo.current = null;
		}
	}

	/**
	 * One chat exec's spend, recorded exactly as a run's is - a `cost_entries`
	 * row under the session's member and project, broadcast so the Budget page
	 * refreshes. Best-effort: a bookkeeping failure must not fail the reply the
	 * operator already has.
	 */
	private async recordChatSpend(
		session: LiveSession,
		usage: AgentRunUsage | null,
		description: string,
	): Promise<void> {
		if (!usage || usage.costCents <= 0) return;
		try {
			const entry = await recordRunCost(this.deps.db, {
				memberId: session.ceoMemberId,
				taskId: null,
				projectId: session.projectId,
				amountCents: usage.costCents,
				description,
				aiProviderConfigId: session.invocationInputs.credential.configId,
				provider: session.invocationInputs.provider,
			});
			if (entry) {
				broadcastRowChange(
					this.deps.wsManager,
					wsRoom.team(DEFAULT_TEAM_ID),
					'cost_entries',
					'INSERT',
					entry,
				);
			}
		} catch (e) {
			log.error('failed to record chat spend', e);
		}
	}

	/** Tear the live session down; the next turn re-allocates a fresh one. */
	async restart(): Promise<void> {
		await this.abortAllCurrent('restart');
		await this.teardown(ChatSessionStatus.Stopped);
	}

	/** Abort every in-flight turn (and parallel auto-title run) across all
	 * conversations and await them, so no exec outlives a restart/shutdown. */
	private async abortAllCurrent(reason: string): Promise<void> {
		const inflight: Promise<unknown>[] = [];
		for (const convo of this.convos.values()) {
			if (convo.current) {
				convo.current.abort.abort(reason);
				inflight.push(convo.current.promise.catch(() => undefined));
			}
			if (convo.titlingAbort) {
				convo.titlingAbort.abort(reason);
				inflight.push(convo.titling?.catch(() => undefined) ?? Promise.resolve());
			}
		}
		await Promise.all(inflight);
	}

	/**
	 * Resolve the default web conversation (the earliest open web thread), creating
	 * it on first use. Back-compat entry point for the web chatbox's default thread.
	 */
	async getConversationId(): Promise<string> {
		const ceoMemberId = await this.resolveCeoMemberId();
		const projectId = await this.resolveHqProjectId();
		const resolved = await this.resolveOrCreateConversation({
			ceoMemberId,
			projectId,
			channel: ChatChannel.Web,
			externalThreadId: null,
		});
		return resolved.id;
	}

	/** Resolve the conversation for an inbound turn (explicit id, or resolve/create). */
	private async resolveConversationForInput(input: {
		channel?: ChatChannel;
		conversationId?: string;
		externalThreadId?: string | null;
		kind?: ChatConversationKind;
		title?: string;
	}): Promise<ConversationContext> {
		if (input.conversationId) {
			const convo = await this.getConversation(input.conversationId);
			if (!convo) throw new Error('conversation not found');
			if (convo.closed_at) throw new Error('conversation is closed');
			// The TURN's origin is the caller's surface (web for explicit-id sends),
			// not the conversation's home — reply-where-asked keys off this.
			return {
				conversationId: convo.id,
				channel: input.channel ?? ChatChannel.Web,
				externalThreadId:
					input.channel && input.channel !== ChatChannel.Web ? convo.external_thread_id : null,
				kind: convo.kind,
			};
		}
		const channel = input.channel ?? ChatChannel.Web;
		const externalThreadId = input.externalThreadId ?? null;
		const ceoMemberId = await this.resolveCeoMemberId();
		const projectId = await this.resolveHqProjectId();
		const resolved = await this.resolveOrCreateConversation({
			ceoMemberId,
			projectId,
			channel,
			externalThreadId,
			kind: input.kind,
			title: input.title,
		});
		// The row's kind wins over the requested one: an existing thread keeps the
		// kind it was born with, whatever a later caller passes.
		return { conversationId: resolved.id, channel, externalThreadId, kind: resolved.kind };
	}

	/**
	 * Resolve an OPEN conversation by its home surface. The conversation row's own
	 * (channel, external_thread_id) is the routing key — there are no bindings and
	 * no mirroring; each external thread maps to exactly one open conversation
	 * (unique-per-open enforced by idx_chat_conversations_external).
	 */
	private async findConversationByOrigin(
		channel: ChatChannel,
		externalThreadId: string,
	): Promise<{ id: string; kind: ChatConversationKind } | null> {
		const r = await this.deps.db.query<{ id: string; kind: ChatConversationKind }>(
			`SELECT id, kind FROM chat_conversations
			 WHERE channel = $1::chat_channel AND external_thread_id = $2 AND closed_at IS NULL`,
			[channel, externalThreadId],
		);
		return r.rows[0] ?? null;
	}

	/**
	 * Resolve an open conversation for a turn, creating it if none. A closed
	 * thread never resolves — the next inbound message on the same external
	 * surface starts a fresh conversation. For web (externalThreadId=null) the
	 * earliest open web thread is the default.
	 */
	private async resolveOrCreateConversation(opts: {
		ceoMemberId: string;
		projectId: string;
		channel: ChatChannel;
		externalThreadId: string | null;
		kind?: ChatConversationKind;
		title?: string;
	}): Promise<{ id: string; kind: ChatConversationKind }> {
		const { ceoMemberId, projectId, channel, externalThreadId, title } = opts;
		const kind = opts.kind ?? ChatConversationKind.Assistant;
		if (externalThreadId != null) {
			const existing = await this.findConversationByOrigin(channel, externalThreadId);
			if (existing) return existing;
			// Coworker threads are titled at creation (from the platform channel name)
			// because they skip auto-title; assistant threads stay NULL and auto-title.
			const created = await this.deps.db.query<{ id: string }>(
				`INSERT INTO chat_conversations (member_id, team_id, project_id, channel, external_thread_id, kind, title)
				 VALUES ($1, $2, $3, $4::chat_channel, $5, $6::chat_conversation_kind, $7) RETURNING id`,
				[ceoMemberId, DEFAULT_TEAM_ID, projectId, channel, externalThreadId, kind, title ?? null],
			);
			return { id: created.rows[0].id, kind };
		}
		const existing = await this.deps.db.query<{ id: string }>(
			`SELECT id FROM chat_conversations
			 WHERE member_id = $1 AND channel = 'web'
			   AND external_thread_id IS NULL AND closed_at IS NULL
			 ORDER BY created_at ASC LIMIT 1`,
			[ceoMemberId],
		);
		if (existing.rows[0]) return { id: existing.rows[0].id, kind: ChatConversationKind.Assistant };
		// Store the default web thread untitled (NULL), not a hardcoded "Main": the
		// frontend renders NULL as the "New thread" placeholder, and the CEO auto-titles
		// it from the conversation on the first exchange (maybeAutoTitle).
		const created = await this.deps.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel, title)
			 VALUES ($1, $2, $3, 'web', $4) RETURNING id`,
			[ceoMemberId, DEFAULT_TEAM_ID, projectId, title ?? null],
		);
		return { id: created.rows[0].id, kind: ChatConversationKind.Assistant };
	}

	/**
	 * Deliver a completed reply to the surface the turn came from. Web turns need
	 * nothing (the reply streamed over WebSocket); external turns post back into
	 * their platform thread. Best-effort — a delivery failure never fails the turn.
	 */
	private async deliverReplyToOrigin(ctx: ConversationContext, content: string): Promise<void> {
		if (!this.channelHooks || content.trim() === '') return;
		if (ctx.channel === ChatChannel.Web || !ctx.externalThreadId) return;
		await this.channelHooks
			.deliver(ctx.channel, ctx.externalThreadId, content, ChatMessageStatus.Complete)
			.catch((e) => log.error(`reply delivery to ${ctx.channel} failed`, e));
	}

	/** Fetch a conversation row (identity + lifecycle), or null if it doesn't exist. */
	async getConversation(conversationId: string): Promise<ConversationSummary | null> {
		const r = await this.deps.db.query<ConversationRow>(
			`SELECT ${CONVERSATION_COLUMNS}
			 FROM chat_conversations c
			 ${CONVERTED_TASK_JOIN}
			 WHERE c.id = $1`,
			[conversationId],
		);
		return r.rows[0] ? toConversationSummary(r.rows[0]) : null;
	}

	/**
	 * List conversations, newest activity first — every kind: the web view is the
	 * hub that sees all threads. `channel` (the thread's home surface) and `kind`
	 * drive the switcher's badges, grouping, and the read-only treatment of
	 * coworker threads. The default listing is "open OR converted": a thread
	 * converted into a task stays visible as a read-only record (its meta message
	 * links the task), while ordinarily-closed threads drop out.
	 */
	async listConversations(opts?: { includeClosed?: boolean }): Promise<ConversationSummary[]> {
		const ceoMemberId = await this.resolveCeoMemberId();
		const r = await this.deps.db.query<ConversationRow>(
			`SELECT ${CONVERSATION_COLUMNS}, c.last_activity_at
			 FROM chat_conversations c
			 ${CONVERTED_TASK_JOIN}
			 WHERE c.member_id = $1 ${
					opts?.includeClosed ? '' : 'AND (c.closed_at IS NULL OR c.converted_task_id IS NOT NULL)'
				}
			 ORDER BY c.last_activity_at DESC, c.created_at DESC`,
			[ceoMemberId],
		);
		return r.rows.map(toConversationSummary);
	}

	/** Create a fresh web conversation thread (the new-thread button). */
	async createWebConversation(title?: string): Promise<string> {
		const ceoMemberId = await this.resolveCeoMemberId();
		const projectId = await this.resolveHqProjectId();
		const created = await this.deps.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel, title)
			 VALUES ($1, $2, $3, 'web', $4) RETURNING id`,
			[ceoMemberId, DEFAULT_TEAM_ID, projectId, title ?? null],
		);
		return created.rows[0].id;
	}

	/**
	 * Close a conversation: mark it closed, abort + evict its in-flight turn, and
	 * close the platform thread on its home surface when the adapter supports it
	 * (a Telegram topic archives; a DM has nothing to close). A closed thread
	 * never resolves inbound again — the next message on that surface starts a
	 * fresh conversation. Idempotent.
	 */
	async closeConversation(conversationId: string): Promise<void> {
		const convo = await this.getConversation(conversationId);
		if (!convo || convo.closed_at) return;
		await this.abortConversationRuntime(conversationId, 'closed');
		const closed = await this.deps.db.query<{ closed_at: string }>(
			`UPDATE chat_conversations SET closed_at = now() WHERE id = $1 RETURNING closed_at`,
			[conversationId],
		);
		this.broadcastChat(conversationId, {
			type: WsMessageType.ChatConversationUpdated,
			conversationId,
			closedAt: closed.rows[0]?.closed_at ?? new Date().toISOString(),
		});
		if (this.channelHooks && convo.channel !== ChatChannel.Web && convo.external_thread_id) {
			await this.channelHooks
				.closeThread(convo.channel, convo.external_thread_id)
				.catch((e) => log.error(`close ${convo.channel} thread failed`, e));
		}
	}

	/**
	 * Abort a conversation's in-flight work (reply turn, compaction, titling) and
	 * evict its runtime. Shared by close and convert-to-task — both need the
	 * thread quiescent (a partial reply settles as `interrupted`) before they
	 * mark the row.
	 */
	private async abortConversationRuntime(conversationId: string, reason: string): Promise<void> {
		const rt = this.convos.get(conversationId);
		if (rt?.current) {
			rt.current.abort.abort(reason);
			await rt.current.promise.catch(() => undefined);
		}
		if (rt?.compactionAbort) {
			rt.compactionAbort.abort(reason);
			await rt.compaction?.catch(() => undefined);
		}
		if (rt?.titlingAbort) {
			rt.titlingAbort.abort(reason);
			await rt.titling?.catch(() => undefined);
		}
		this.convos.delete(conversationId);
	}

	/**
	 * Convert an open web assistant conversation into a task: the active window's
	 * transcript becomes the task description, the CEO is assigned (waking it in
	 * the target project's team — the run-team split), a system-role meta message
	 * records the task in the thread, and the conversation closes but stays
	 * listed (converted threads remain in the switcher as a read-only record).
	 *
	 * Ordering is failure-safe: the task is created first and the close commits
	 * atomically with the meta message, so a failure can leave a task without a
	 * closed thread (visible, retryable — a second convert of a still-open thread
	 * is legal) but never a closed thread pointing at nothing.
	 */
	async convertConversationToTask(input: {
		conversationId: string;
		/** Target project (resolved UUID) and its backing team. */
		projectId: string;
		projectTeamId: string;
		title?: string;
		caller: CreateTaskCaller;
		events?: DomainEventBus;
	}): Promise<{ task: TaskRow; conversation: ConversationSummary }> {
		const convo = await this.getConversation(input.conversationId);
		if (!convo) throw new ChatConvertError('NOT_FOUND', 'conversation not found');
		if (convo.kind === ChatConversationKind.Coworker) {
			throw new ChatConvertError(
				'READ_ONLY',
				'Team-channel conversations cannot be converted from the web view',
			);
		}
		// External assistant DMs are excluded for now — relax this guard (and close
		// the platform thread via channelHooks.closeThread) to support them.
		if (convo.channel !== ChatChannel.Web) {
			throw new ChatConvertError('INVALID_REQUEST', 'Only web conversations can be converted');
		}
		if (convo.converted_task_id) {
			throw new ChatConvertError('ALREADY_CONVERTED', 'Conversation was already converted');
		}
		if (convo.closed_at) throw new ChatConvertError('CLOSED', 'Conversation is closed');

		// Quiesce first so a partial reply settles as `interrupted` and makes the
		// transcript; the cost of a later failure is that interrupt, nothing more.
		await this.abortConversationRuntime(input.conversationId, 'converted');

		const window = await loadActiveWindow(this.deps.db, input.conversationId);
		if (window.length === 0) {
			throw new ChatConvertError('INVALID_REQUEST', 'Conversation has no messages to convert');
		}
		const compacted = await this.deps.db.query<{ count: number }>(
			`SELECT COUNT(*)::int AS count FROM chat_messages
			 WHERE conversation_id = $1 AND compacted_at IS NOT NULL`,
			[input.conversationId],
		);
		const description = buildConversationTaskDescription({
			messages: window,
			compactedCount: compacted.rows[0]?.count ?? 0,
		});
		const title =
			input.title?.trim() || convo.title?.trim() || firstUserLine(window) || 'Chat conversation';

		// The CEO must be assigned by id: slug resolution is scoped to the target
		// team and the CEO lives in HQ (same pattern as marketplace team setup).
		const ceoMemberId = await this.resolveCeoMemberId();
		const task = await createTask(
			this.deps.db,
			input.projectTeamId,
			{
				project_id: input.projectId,
				title,
				description,
				assignee_id: ceoMemberId,
			},
			input.caller,
			this.deps.wsManager,
			input.events,
		);

		// Meta message + close commit together: the thread never reads as closed
		// without its pointer, and never carries the pointer while still open.
		const messageContent = `Conversation converted to task ${task.identifier}: ${title}`;
		let messageId = '';
		await withTransaction(this.deps.db, async () => {
			messageId = await this.insertMessage({
				conversationId: input.conversationId,
				role: ChatMessageRole.System,
				channel: ChatChannel.Web,
				status: ChatMessageStatus.Complete,
				content: messageContent,
				systemKind: ChatSystemMessageKind.ConvertedTask,
				completed: true,
			});
			await this.deps.db.query(
				`UPDATE chat_conversations
				 SET converted_task_id = $2, closed_at = now(), last_activity_at = now()
				 WHERE id = $1`,
				[input.conversationId, task.id],
			);
		});

		this.broadcastStart(
			input.conversationId,
			messageId,
			ChatMessageRole.System,
			ChatChannel.Web,
			messageContent,
			undefined,
			ChatSystemMessageKind.ConvertedTask,
		);
		this.broadcastChat(input.conversationId, {
			type: WsMessageType.ChatConversationUpdated,
			conversationId: input.conversationId,
			closedAt: new Date().toISOString(),
			convertedTaskId: task.id as string,
		});

		const conversation = await this.getConversation(input.conversationId);
		if (!conversation) throw new ChatConvertError('NOT_FOUND', 'conversation not found');
		return { task, conversation };
	}

	/** Close the conversation living on an external thread (inbound topic-closed). */
	async closeConversationByExternalThread(
		channel: ChatChannel,
		externalThreadId: string,
	): Promise<void> {
		const found = await this.findConversationByOrigin(channel, externalThreadId);
		if (found) await this.closeConversation(found.id);
	}

	/** Bump a conversation's last-activity timestamp (drives list ordering). */
	private async touchConversation(conversationId: string): Promise<void> {
		await this.deps.db
			.query(`UPDATE chat_conversations SET last_activity_at = now() WHERE id = $1`, [
				conversationId,
			])
			.catch(() => undefined);
	}

	private async ensureSession(): Promise<LiveSession> {
		// Re-check the provider choice before reusing a session, suspended or not:
		// the operator can move the instance default (or put a model override on the
		// CEO) at any point between two turns, and a session cannot pick that up in
		// place - its env and exec command were built from the old one. A start
		// already in flight resolves fresh on its own, so skip the probe then.
		const existing = this.live;
		if (existing && !this.ensuring && (await this.invocationMovedOn(existing))) {
			// In-flight turns go with it: they are executing against the credential the
			// operator just replaced.
			await this.restart();
		}
		if (this.live && !this.suspended) return this.live;
		if (this.ensuring) return this.ensuring;
		// A parked session resumes into its own container and keeps its row; only a
		// session that never existed (or whose container was replaced) starts fresh.
		const begin = this.live && this.suspended ? this.resumeSession() : this.startSession();
		this.ensuring = begin.finally(() => {
			this.ensuring = null;
		});
		return this.ensuring;
	}

	private buildContainerDeps(): ContainerDeps {
		return {
			db: this.deps.db,
			docker: this.deps.docker,
			dataDir: this.deps.dataDir,
			wsManager: this.deps.wsManager,
			masterKeyManager: this.deps.masterKeyManager,
			logs: this.deps.logs,
			containerLogStreamer: this.deps.containerLogStreamer,
			sshAgentServer: this.deps.sshAgentServer,
			egressProxy: this.deps.egressProxy ?? null,
			egressCAPath: this.deps.egressCAPath ?? null,
		};
	}

	/**
	 * Resolve what this chat should run on right now: the agent's own model
	 * override if it has one, else the instance-wide default credential.
	 *
	 * Same precedence as the agent runner, and the only copy of it on this side -
	 * session start and the staleness check below both read it here, so the
	 * selection a live session is compared against can never be resolved by a
	 * different rule from the one that started it.
	 */
	private async resolveInvocationSelection(ceoMemberId: string): Promise<InvocationSelection> {
		const { db } = this.deps;
		const override = await db.query<{ provider: AiProvider | null; model: string | null }>(
			`SELECT model_override_provider AS provider, model_override_model AS model
			 FROM member_agents WHERE id = $1`,
			[ceoMemberId],
		);
		let provider = override.rows[0]?.provider ?? null;
		let runtimeType: AgentRuntime;
		// An override names only a provider, so its CLI comes from the credential
		// below; the resolved path already picked a credential and constrains the
		// lookup to one that matches.
		let requiredRuntime: AgentRuntime | null = null;
		if (provider) {
			runtimeType = PROVIDER_RUNTIME_ADAPTERS[provider].runtime;
		} else {
			const resolved = await resolveRuntimeForTask(db, null);
			if (!resolved.ok) throw new Error(resolved.reason);
			provider = resolved.provider;
			runtimeType = resolved.runtime;
			requiredRuntime = resolved.runtime;
		}

		const config = await selectProviderConfig(db, provider, requiredRuntime);
		if (!config) throw new Error(`No ${provider} credential configured`);
		if (!requiredRuntime) {
			runtimeType = effectiveRuntime(provider, config.runtime) ?? runtimeType;
		}
		return {
			provider,
			runtimeType,
			configId: config.configId,
			modelOverride: override.rows[0]?.model ?? config.defaultModel ?? null,
			requiredRuntime,
		};
	}

	/**
	 * Has the instance moved on from what this live session was started with?
	 *
	 * A chat session outlives many turns, and everything about its provider - the
	 * CLI binary in its exec command, the credential in its env, the model flag -
	 * was fixed when the session started. An agent following the instance default
	 * would otherwise keep running on whichever credential happened to be the
	 * default that day, for as long as the session lived.
	 */
	private async invocationMovedOn(live: LiveSession): Promise<boolean> {
		let selection: InvocationSelection;
		try {
			selection = await this.resolveInvocationSelection(live.ceoMemberId);
		} catch (e) {
			// The question could not be answered - no verified credential right now, or
			// the database refused. A working session is not torn down over an
			// unanswered question: this turn runs on what it has and the next asks
			// again.
			log.warn(`could not re-check the CEO chat's AI provider: ${String(e)}`);
			return false;
		}
		const inputs = live.invocationInputs;
		const before = invocationFingerprint(
			inputs.provider,
			inputs.runtimeType,
			inputs.credential.configId,
			inputs.modelOverride,
		);
		const now = invocationFingerprint(
			selection.provider,
			selection.runtimeType,
			selection.configId,
			selection.modelOverride,
		);
		if (before === now) return false;
		log.info(`CEO chat AI provider changed (${before} -> ${now}); starting a fresh session`);
		return true;
	}

	private async startSession(): Promise<LiveSession> {
		const { db } = this.deps;

		const ceo = await db.query<{ id: string }>(
			`SELECT m.id FROM members m
			 JOIN member_agents ma ON ma.id = m.id
			 WHERE ma.slug = $1 AND m.team_id = $2`,
			[CEO_AGENT_SLUG, DEFAULT_TEAM_ID],
		);
		const ceoMemberId = ceo.rows[0]?.id;
		if (!ceoMemberId) throw new Error('CEO agent not found in HQ team');

		const proj = await db.query<{ id: string }>(
			`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
			[DEFAULT_TEAM_ID],
		);
		const project = proj.rows[0];
		if (!project) throw new Error('HQ project not found');
		// Through the pool, with the chat workload - which reuses the container this
		// chat already pinned, else takes an idle one, else resumes or creates.
		//
		// It used to read `projects.container_id` and lazily start it. That names
		// the project's most recently provisioned or resumed container, which under
		// a pool may be one currently serving a task run: the chat then pinned a
		// busy container and executed its turns on it, two workloads sharing one
		// memory cap - the shared-fate failure the pool exists to remove, arrived at
		// from the one direction the pool was not guarding. The CEO chat is also
		// available app-wide from first load, before any project exists, so the
		// create rung is a normal path here rather than an edge case.
		const acquired = await acquireRunContainer(this.buildContainerDeps(), project.id, null, 'chat');
		const containerId = acquired.containerId;

		// Detect the HQ container's run-user once for this session; reused on every
		// turn's exec, the ssh socket owner, and the per-turn config-dir chown.
		const runUser = await resolveContainerRunUser(this.deps.docker, containerId);

		const { provider, runtimeType, modelOverride, requiredRuntime } =
			await this.resolveInvocationSelection(ceoMemberId);
		const credential = await getProviderCredentialAndModel(
			db,
			this.deps.masterKeyManager,
			provider,
			requiredRuntime,
		);
		if (!credential) throw new Error(`No ${provider} credential configured`);

		// Reclaim any DB rows left live by a crash without an in-memory session, so
		// the singleton insert below doesn't collide. `suspended` counts as live -
		// the singleton index treats every non-terminal status that way - so a
		// process restart while a session was suspended must reclaim it too.
		await db.query(
			`UPDATE chat_sessions SET status = $1, stopped_at = now()
			 WHERE member_id = $2 AND status IN ($3, $4, $5)`,
			[
				ChatSessionStatus.Crashed,
				ceoMemberId,
				ChatSessionStatus.Starting,
				ChatSessionStatus.Running,
				ChatSessionStatus.Suspended,
			],
		);

		const inserted = await db.query<{ id: string }>(
			`INSERT INTO chat_sessions (member_id, team_id, project_id, container_id, runtime_type, status)
			 VALUES ($1, $2, $3, $4, $5::agent_runtime, $6)
			 RETURNING id`,
			[
				ceoMemberId,
				DEFAULT_TEAM_ID,
				project.id,
				containerId,
				runtimeType,
				ChatSessionStatus.Starting,
			],
		);
		const sessionId = inserted.rows[0].id;

		try {
			const inputs: HostSideInputs = {
				ceoMemberId,
				projectId: project.id,
				provider,
				credential,
				runtimeType,
				modelOverride,
			};
			const allocation = await this.allocateHostSide(sessionId, containerId, runUser, inputs);

			await db.query(`UPDATE chat_sessions SET status = $1 WHERE id = $2`, [
				ChatSessionStatus.Running,
				sessionId,
			]);
			// The pin is established by the acquire above, not here - `acquireRunContainer`
			// with the chat workload is the one place a container becomes the chat's,
			// so it is also the one place that can guarantee the container it pins is
			// not already serving a run.

			this.live = {
				sessionId,
				ceoMemberId,
				projectId: project.id,
				containerId,
				runUser,
				runtimeType,
				invocationInputs: inputs,
				...allocation,
			};
			log.info(`CEO chat session started (runtime=${runtimeType})`, { session: sessionId });
			return this.live;
		} catch (err) {
			await db
				.query(
					`UPDATE chat_sessions SET status = $1, error = $2, stopped_at = now() WHERE id = $3`,
					[ChatSessionStatus.Crashed, (err as Error).message, sessionId],
				)
				.catch(() => undefined);
			throw err;
		}
	}

	/**
	 * Allocate the half of a session that lives on the Hezo side: the ssh agent
	 * socket, the egress proxy, the session JWT, and the exec command and env built
	 * around them.
	 *
	 * Extracted because **resume needs exactly this and nothing else**. A suspended
	 * container keeps its filesystem, and a chat session holds no long-lived process
	 * (each turn is its own exec; continuity is in the database) - but these
	 * allocations live on the Hezo side and are released at suspend, and their ports
	 * change. Two copies of this sequence is what the second-call-site rule exists to
	 * prevent, and a drifted copy here would mean a resumed chat silently losing
	 * commit signing or secret substitution.
	 *
	 * Releases whatever it managed to allocate before rethrowing, so a partial
	 * failure never strands a socket or a proxy port.
	 */
	private async allocateHostSide(
		sessionId: string,
		containerId: string,
		runUser: ContainerRunUser,
		inputs: HostSideInputs,
	): Promise<HostSideAllocation> {
		let releaseSsh = async (): Promise<void> => undefined;
		let releaseEgress = async (): Promise<void> => undefined;
		let tunnel: RunTunnel | null = null;
		try {
			const label = `chat`;

			// Warm ssh bridge (commit signing / git over ssh), allocated once.
			let sshSocketContainerPath: string | null = null;
			let sshHostTcpPort = 0;
			let sshTokenHex: string | null = null;
			const sshAgentServer = this.deps.sshAgentServer;
			if (sshAgentServer) {
				const socketHostPath = getRunSocketPath(this.deps.dataDir, sessionId);
				const allocated = await sshAgentServer.allocateRunSocket(
					sessionId,
					{ teamId: DEFAULT_TEAM_ID, agentId: inputs.ceoMemberId, label },
					socketHostPath,
				);
				sshSocketContainerPath = `/run/hezo/${sessionId}.sock`;
				sshHostTcpPort = allocated.tcpHostPort;
				sshTokenHex = allocated.tokenHex;
				releaseSsh = () => sshAgentServer.releaseRunSocket(sessionId);
			}

			// Warm egress proxy (secret substitution), allocated once.
			let egressHost: { host: string; port: number; token: string | null } | null = null;
			const egressProxy = this.deps.egressProxy;
			if (egressProxy && this.deps.egressCAPath) {
				const allocated = await egressProxy.allocateRunProxy(sessionId, {
					teamId: DEFAULT_TEAM_ID,
					agentId: inputs.ceoMemberId,
					projectId: inputs.projectId,
					label,
					onConnectorRejection: (event) => this.onConnectorRejection(event, inputs, sessionId),
				});
				egressHost = {
					host: allocated.proxyHost,
					port: allocated.proxyPort,
					token: allocated.token,
				};
				releaseEgress = () => egressProxy.releaseRunProxy(sessionId);
			}

			// The chat reaches Hezo exactly as an agent run does - one tunnel, its
			// own allocated loopback ports, torn down with the session. A session
			// outlives many turns, so this is the longest-lived tunnel there is;
			// suspend closes it and resume opens a fresh one, because the host-side
			// ports it points at are reallocated too.
			// Resolved once and used twice: the tunnel's split-routing policy needs
			// the connector hosts (their method allowlist is enforced at the proxy,
			// so one routed direct would skip it) and the runtime invocation needs
			// the descriptors themselves. Two loads a moment apart could disagree.
			const connectorDescriptors = await loadConnectorDescriptors(this.deps.db, inputs.projectId);

			tunnel = await startRunTunnel({
				engine: this.deps.docker,
				containerId,
				runUser,
				files: this.deps.docker.files(containerId, CONTAINER_WORKSPACE_ROOT),
				configRelPath: join('.hezo', 'tunnel', `${sessionId}.json`),
				configContainerPath: `${CONTAINER_WORKSPACE_ROOT}/.hezo/tunnel/${sessionId}.json`,
				addresses: {
					mcp: { host: '127.0.0.1', port: this.deps.serverPort },
					ssh: { host: '127.0.0.1', port: sshHostTcpPort },
					proxy: egressHost
						? { host: egressHost.host, port: egressHost.port }
						: { host: '127.0.0.1', port: 0 },
				},
				// Connector hosts belong in the policy even though a chat turn builds no
				// MCP descriptors of its own: the policy governs what this *container*
				// proxies, and the per-connector method allowlist is enforced at the
				// proxy, so a connector host routed direct from here would skip it.
				policy: await buildTunnelHostPolicy(this.deps.db, connectorDescriptors),
			});
			// A session outlives many turns, so this is the tunnel most exposed to an
			// idle drop - and a chat that has lost its tunnel cannot reach Hezo at
			// all, so every later turn would answer from the model alone with none of
			// its tools. Tear the session down instead; the next turn rebuilds it with
			// a fresh tunnel and fresh host-side ports.
			tunnel.onClosed((why) => {
				log.warn(`CEO chat session ${sessionId} lost its tunnel (${why}); tearing it down`);
				trackBackground(
					this.teardown(ChatSessionStatus.Crashed).catch((e) =>
						log.error('tearing down the chat session after tunnel loss failed', e),
					),
				);
			});
			const endpoints = tunnel.endpoints;

			const bridge: BridgeRunnerArgs | null =
				sshSocketContainerPath && sshTokenHex
					? {
							socketPath: sshSocketContainerPath,
							socketUser: runUser.name,
							tokenHex: sshTokenHex,
							hostName: endpoints.sshHost,
							hostPort: endpoints.sshPort,
						}
					: null;

			const egress: EgressEnvDescriptor | null = egressHost
				? {
						host: endpoints.proxyHost,
						port: endpoints.proxyPort,
						containerCAPath: '/usr/local/share/ca-certificates/hezo-egress.crt',
						token: egressHost.token,
					}
				: null;

			const agentJwt = await signChatSessionJwt(
				this.deps.masterKeyManager,
				inputs.ceoMemberId,
				DEFAULT_TEAM_ID,
				sessionId,
				inputs.projectId,
				{ crossProject: true, crossTeam: true },
			);

			// Max thinking — the CEO chat runs at the highest reasoning effort.
			const effortApplication: EffortRuntimeApplication = applyEffortToRuntime(
				inputs.runtimeType,
				AgentEffort.Max,
			);

			const invocation = await buildRuntimeInvocation({
				endpoints,
				connectorDescriptors,
				deps: this.deps,
				runTeamId: DEFAULT_TEAM_ID,
				projectId: inputs.projectId,
				provider: inputs.provider,
				credential: inputs.credential,
				runtimeType: inputs.runtimeType,
				agentJwt,
				agentId: inputs.ceoMemberId,
				resourceId: sessionId,
				containerId,
				runUser,
				promptContainerPath: getContainerPromptPath(sessionId),
				// Written to the runtime's instructions file rather than repeated in
				// every turn's prompt, for the runtimes that need it (see
				// RUNTIME_SYSTEM_PROMPT_FILE). Null everywhere else, where the turn
				// prompt carries it as before.
				systemPrompt: RUNTIME_SYSTEM_PROMPT_FILE[inputs.runtimeType]
					? await this.resolveCeoSystemPrompt(inputs.ceoMemberId, inputs.projectId)
					: null,
				effort: AgentEffort.Max,
				effortApplication,
				modelOverride: inputs.modelOverride,
				sshSocketContainerPath,
				bridge,
				egress,
				// No completeness judge on a chat turn. The judge rules on whether an
				// agent is abandoning TASK work, and it reads only the run's final
				// message: here there is no task, and the final message is the reply
				// already streamed to the operator - so every rule it could fire on is
				// inapplicable or false, while a block spends a whole extra turn
				// chasing a create_comment on a task that does not exist. The thing a
				// chat turn genuinely can strand - a handoff in a comment it posted on
				// some project's task - is caught structurally instead, by
				// create_comment's wake receipt and the no-wake exit check in runTurn.
				stopJudge: false,
			});

			return {
				env: invocation.env,
				execCmd: invocation.execCmd,
				promptDirective: effortApplication.promptDirective ?? null,
				subscriptionMount: invocation.subscriptionMount,
				homeMount: invocation.homeMount,
				releaseEgress,
				releaseSsh,
				closeTunnel: () => tunnel?.close(),
			};
		} catch (err) {
			tunnel?.close();
			await releaseSsh().catch(() => undefined);
			await releaseEgress().catch(() => undefined);
			throw err;
		}
	}

	/**
	 * Per-turn prompt file paths + the exec env pointing at them. The container
	 * reads its prompt from `HEZO_PROMPT_FILE`; keying the file by conversation lets
	 * concurrent threads exec without overwriting each other's prompt (same-thread
	 * turns serialize via the per-conversation lock, so one file per thread is safe).
	 * Pass a `slot` suffix for a side exec that must run alongside the reply — the
	 * auto-title run uses its own file so it never overwrites the reply's prompt.
	 */
	private turnPrompt(
		session: LiveSession,
		conversationId: string,
		slot?: string,
	): {
		write: (prompt: string) => Promise<void>;
		remove: () => Promise<void>;
		env: string[];
		cmd: string[];
	} {
		const key = slot
			? `${session.sessionId}-${conversationId}-${slot}`
			: `${session.sessionId}-${conversationId}`;
		const containerPath = getContainerPromptPath(key);
		const env = session.env.map((e) =>
			e.startsWith('HEZO_PROMPT_FILE=') ? `HEZO_PROMPT_FILE=${containerPath}` : e,
		);
		// A 'file'-delivery runtime carries the prompt path in ARGV too
		// (`--prompt-file <path>`), because the CLI opens the file itself. `execCmd`
		// is built once per session against the session-keyed path, so without this
		// swap every turn would point the CLI at a file nothing ever writes.
		const sessionPath = getContainerPromptPath(session.sessionId);
		const cmd = session.execCmd.map((a) => (a === sessionPath ? containerPath : a));
		// Written through the seam, not to a host path. The exec reads
		// `HEZO_PROMPT_FILE` from *inside* the container, and that only lined up
		// with a host write because the workspace is a bind mount on Docker. On a
		// managed backend there is no such path, so every chat turn would have read
		// an empty prompt while the write reported success - the failure the
		// `SandboxFiles` seam exists to remove. `runAgent` moved the identical
		// write over already; this one was missed.
		const files = this.deps.docker.files(session.containerId, CONTAINER_WORKSPACE_ROOT);
		const relPath = getPromptRelPath(key);
		return {
			write: (prompt: string) => files.write(relPath, prompt),
			// Scrubbed the same way it was written: a host `rmSync` against a managed
			// backend would no-op while looking like it worked, leaving the prompt in
			// the container for the rest of its life.
			remove: () => files.remove(relPath),
			env,
			cmd,
		};
	}

	private async runTurn(
		session: LiveSession,
		ctx: ConversationContext,
		assistantMessageId: string,
		abort: AbortController,
		injectedContext?: string,
	): Promise<void> {
		const { conversationId } = ctx;
		const convo = this.getConvoRuntime(conversationId);
		// The session's proxy outlives every turn, and a connector refusal is
		// reported once per proxy - so each turn starts with a clean slate, or a
		// connector that stayed broken would be reported on the first turn only.
		this.deps.egressProxy?.resetConnectorRejections(session.sessionId);
		const {
			write: writePrompt,
			remove: removePrompt,
			env,
			cmd: execCmd,
		} = this.turnPrompt(session, conversationId);
		// Per-exec scope marker: session-level HEZO_HEARTBEAT_RUN_ID is shared by
		// every exec of this session (turns in other conversations, compaction,
		// titling), so an interrupt must kill by a marker unique to THIS exec or it
		// would murder a sibling conversation's live reply.
		const execScopeId = randomUUID();
		env.push(`HEZO_EXEC_SCOPE_ID=${execScopeId}`);
		const accumulated = { text: '' };
		// Grok and Kimi Code emit no usage on their streams; recover it from the
		// file each writes into the session's home mount, then scrub that file
		// (both can carry the provider credential). Called on every turn end -
		// including interrupted and failed ones, where the usage is discarded but
		// the scrub still matters. Scrubbing per turn also keeps the next turn's
		// parse from re-billing this one's records. Null for every other runtime.
		const recoverUsage = async (): Promise<AgentRunUsage | null> => {
			if (!session.homeMount) return null;
			const pricingSvc = this.deps.pricing;
			return recoverOffStreamRunUsage(
				session.runtimeType,
				this.deps.docker.files(session.containerId, session.homeMount.containerDir),
				pricingSvc ? (model, tokens) => pricingSvc.costCents(model, tokens) : undefined,
				(msg) => log.error(`CEO chat turn usage recovery: ${msg}`),
			).catch(() => null);
		};
		let finalized = false;
		const finalize = async (
			status: ChatMessageStatus,
			usage: AgentRunUsage | null,
			error?: string,
		) => {
			if (finalized) return;
			finalized = true;
			await this.finalizeMessage(
				conversationId,
				assistantMessageId,
				status,
				accumulated.text,
				usage,
				error,
			);
			// Reply-where-asked: a completed reply posts back to the surface the turn
			// came from (web turns already streamed over WebSocket). An
			// interrupted/failed partial is never delivered to a platform.
			if (status === ChatMessageStatus.Complete) {
				await this.deliverReplyToOrigin(ctx, accumulated.text);
			}
		};

		try {
			const prompt = await this.composePrompt(session, conversationId, {
				kind: ctx.kind,
				injectedContext,
			});
			// Before the write, so a prompt this runtime physically cannot receive
			// fails the turn by name instead of dying as `Argument list too long` in
			// the exec's shell. The catch below finalizes the assistant message with
			// the error, so the operator sees it in the chatbox.
			assertPromptDeliverable(session.runtimeType, prompt);
			await writePrompt(prompt);

			const pricing = this.deps.pricing;
			const parser = createAgentChatParser(
				session.runtimeType,
				pricing ? (model, tokens) => pricing.costCents(model, tokens) : undefined,
			);
			const handle = (events: ReturnType<AgentChatParser['onStdout']>) => {
				for (const ev of events) {
					if (ev.text) {
						accumulated.text += ev.text;
						this.broadcastDelta(conversationId, assistantMessageId, ev.text);
					}
					// Progress, not conversation: broadcast but never accumulated into the
					// message, so it reaches the open chatbox and nothing else. Without it
					// a turn that keeps working after its last text block - tools called
					// after the reply is written, or the runtime's own teardown - shows the
					// operator nothing but dots.
					if (ev.toolActivity) {
						this.broadcastChat(conversationId, {
							type: WsMessageType.ChatMessageToolActivity,
							conversationId,
							messageId: assistantMessageId,
							tool: ev.toolActivity,
						});
					}
				}
			};

			await this.withCredentialLock(
				session,
				abort.signal,
				() =>
					dockerSandboxHandle(this.deps.docker, session.containerId, session.runUser).exec({
						cmd: execCmd,
						env,
						workingDir: CHAT_WORKING_DIR,
						signal: abort.signal,
						onChunk: (chunk) => {
							if (chunk.stream === 'stdout') handle(parser.onStdout(chunk.text));
						},
					}),
				{ onWaiting: (holder) => this.postCredentialWait(ctx, holder) },
			);
			handle(parser.flush());
			const usage = parser.getUsage() ?? (await recoverUsage());
			await finalize(ChatMessageStatus.Complete, usage);
			// Chat is metered: the turn's spend lands in cost_entries like a run's,
			// after the reply has settled so the operator is never kept waiting on it.
			await this.recordChatSpend(session, usage, 'Chat turn');
			await this.checkNoWakeExit(session, ctx, assistantMessageId);
		} catch (err) {
			if (abort.signal.aborted) {
				// Aborting only tears down the attach stream — reap the abandoned
				// in-container CLI by this exec's own scope marker.
				this.killAbandonedExec(session, execScopeId);
				// Usage on an interrupted turn is discarded, but the recovery's scrub
				// side effect still removes the credential-bearing log.
				await recoverUsage();
				await finalize(ChatMessageStatus.Interrupted, null);
			} else {
				// A credential still held elsewhere is the instance being busy, not
				// the chat breaking; the operator reads the reason in the thread.
				if (err instanceof ChatCredentialBusyError)
					log.warn(`CEO chat turn gave up: ${err.message}`);
				else log.error('CEO chat turn failed', err);
				// Discarded usage, kept scrub - same as the interrupted arm.
				await recoverUsage();
				await finalize(ChatMessageStatus.Failed, null, (err as Error).message);
			}
		} finally {
			await removePrompt();
			if (convo.current?.assistantMessageId === assistantMessageId) convo.current = null;
		}
	}

	/**
	 * The no-wake exit check for a chat turn: did this turn post a comment on some
	 * project's task that names a teammate, notifies nobody, and leaves the task
	 * open? That is a stranded handoff whatever words carried it, and in the chat
	 * nothing else looks for it - the runner's net and its own exit check are on
	 * the task-run path, which a chat turn never takes.
	 *
	 * Only the turn's COMMENTS are judged, never its reply: on a task run the final
	 * message is delivered to nobody, which is what makes a handoff left there
	 * stranded, but here the reply IS the delivery - it streamed to the operator.
	 * That difference is also why this replaces the completeness judge rather than
	 * joining it (see `stopJudge` at the invocation).
	 *
	 * The turn's comments are identified by author and time rather than by run id:
	 * a chat session authenticates against `chat_sessions`, so it has no run id and
	 * its comments carry NULL there. A comment from a sibling conversation's turn
	 * running concurrently can therefore be attributed here too - it is the same
	 * agent either way, so the cost is a duplicate warning, never a wrong one.
	 *
	 * Reported as a system message rather than a log line, because unlike a run
	 * this has two readers who can act: the operator sees it in the thread, and the
	 * CEO reads it back in the next turn's window and can post the mention it
	 * missed. Warn-only, like the runner's: no wake is fabricated from it.
	 */
	private async checkNoWakeExit(
		session: LiveSession,
		ctx: ConversationContext,
		assistantMessageId: string,
	): Promise<void> {
		try {
			const posted = await this.deps.db.query<{
				task_id: string;
				content: unknown;
				parent_comment_id: string | null;
			}>(
				`SELECT task_id, content, parent_comment_id FROM task_comments
				 WHERE author_member_id = $1 AND created_by_run_id IS NULL AND content_type = 'text'
				   AND created_at >= (SELECT created_at FROM chat_messages WHERE id = $2)`,
				[session.ceoMemberId, assistantMessageId],
			);
			if (posted.rows.length === 0) return;
			// No `runId`: a chat turn is not a run, so the structural-wake credit a
			// task run gets is unavailable here. A turn that files a task for a
			// teammate and then names them passively is still warned about. Known,
			// and the cost is a warning the operator can disregard rather than a
			// handoff nobody hears about.
			const findings = await detectNoWakeExits(this.deps.db, {
				selfMemberId: session.ceoMemberId,
				comments: posted.rows,
			});
			for (const finding of findings) {
				await this.postSystemMessage(
					ctx,
					ChatSystemMessageKind.HandoffNotDelivered,
					formatNoWakeExitWarning(finding, 'This chat turn'),
				);
			}
		} catch (e) {
			log.error('CEO chat no-wake exit check failed', e);
		}
	}

	/**
	 * A hosted connector refused a request a turn of this session made. Same two
	 * phases as a task run's log gets - the observed fact now, Hezo's re-check
	 * verdict when it lands - posted as system messages into every conversation
	 * with a turn in flight, since the session's proxy cannot tell which one the
	 * request served. That imprecision is the same one the no-wake check accepts,
	 * and its cost is a warning in a sibling thread rather than none anywhere.
	 */
	private onConnectorRejection(
		event: ConnectorRunRejection,
		inputs: HostSideInputs,
		sessionId: string,
	): void {
		// Resolved now, not when the verdict lands: the re-check can outlast the
		// turn that provoked it, and the verdict belongs in the thread that saw the
		// refusal, whether or not it is still mid-turn by then.
		const targets = [...this.convos.values()]
			.map((convo) => convo.current?.ctx)
			.filter((ctx): ctx is ConversationContext => ctx !== undefined);
		trackBackground(
			(async () => {
				// The project's team, whose room the Connectors page listens on; the
				// session itself is scoped to HQ.
				const project = await this.deps.db.query<{ team_id: string }>(
					'SELECT team_id FROM projects WHERE id = $1',
					[inputs.projectId],
				);
				const post = (line: string) => this.postConnectorWarning(line, targets);
				await reportConnectorRunRejection(
					{
						db: this.deps.db,
						masterKeyManager: this.deps.masterKeyManager,
						wsManager: this.deps.wsManager,
					},
					event,
					{
						runtime: inputs.runtimeType,
						runId: sessionId,
						label: 'chat',
						teamId: project.rows[0]?.team_id ?? DEFAULT_TEAM_ID,
						projectId: inputs.projectId,
					},
					{ observed: post, verdict: post },
				);
			})().catch((e) => log.error('CEO chat connector rejection report failed', e)),
		);
	}

	/** One warning row per target thread; logged when there is none to post into. */
	private async postConnectorWarning(
		content: string,
		targets: readonly ConversationContext[],
	): Promise<void> {
		if (targets.length === 0) {
			log.warn(`CEO chat: ${content}`);
			return;
		}
		for (const ctx of targets) {
			await this.postSystemMessage(ctx, ChatSystemMessageKind.ConnectorRefused, content);
		}
	}

	/**
	 * The turn is parked behind whoever holds the provider credential. Said in
	 * the thread at once, in the words a waiting run's log uses, so the operator
	 * knows what the silence is and where to look - and can stop the turn rather
	 * than wait, if they would rather.
	 */
	private async postCredentialWait(
		ctx: ConversationContext,
		holder: CredentialLockHolder,
	): Promise<void> {
		await this.postSystemMessage(
			ctx,
			ChatSystemMessageKind.CredentialWait,
			credentialWaitNotice(holder),
		);
	}

	/** A complete system row in one thread: stored, then announced to its open chatboxes. */
	private async postSystemMessage(
		ctx: ConversationContext,
		kind: ChatSystemMessageKind,
		content: string,
	): Promise<string> {
		const messageId = await this.insertMessage({
			conversationId: ctx.conversationId,
			role: ChatMessageRole.System,
			channel: ctx.channel,
			status: ChatMessageStatus.Complete,
			content,
			systemKind: kind,
			completed: true,
		});
		this.broadcastStart(
			ctx.conversationId,
			messageId,
			ChatMessageRole.System,
			ctx.channel,
			content,
			undefined,
			kind,
		);
		return messageId;
	}

	/**
	 * Best-effort fire-and-forget kill of one abandoned chat exec's process tree
	 * by its per-exec scope marker. Docker can't signal an exec'd process, so an
	 * interrupted/preempted exec would otherwise keep running in the HQ container.
	 */
	private killAbandonedExec(session: LiveSession, execScopeId: string): void {
		trackBackground(
			this.deps.docker
				.killProcessesByEnvMarker(session.containerId, 'HEZO_EXEC_SCOPE_ID', execScopeId)
				.catch(() => undefined),
		);
	}

	/**
	 * The CEO's resolved system prompt for a live chat session.
	 *
	 * Shared by `composePrompt` and, for a runtime whose system prompt travels in
	 * an instructions file (RUNTIME_SYSTEM_PROMPT_FILE), the session-start
	 * invocation that writes that file.
	 */
	private async resolveCeoSystemPrompt(ceoMemberId: string, projectId: string): Promise<string> {
		const stored = await getAgentSystemPrompt(this.deps.db, DEFAULT_TEAM_ID, ceoMemberId);
		return resolveSystemPrompt(this.deps.db, stored, {
			teamId: DEFAULT_TEAM_ID,
			projectId,
			agentId: ceoMemberId,
			dataDir: this.deps.dataDir,
			mode: 'runtime',
			crossTeam: true,
			// Embed the full bundled docs so the CEO can answer setup/usage questions
			// in live chat; headless CEO runs get only the live-docs pointer.
			embedDocs: true,
		});
	}

	private async composePrompt(
		session: LiveSession,
		conversationId: string,
		opts: { kind: ChatConversationKind; injectedContext?: string },
	): Promise<string> {
		const isCoworker = opts.kind === ChatConversationKind.Coworker;
		// Omitted here when the runtime reads it from an instructions file written at
		// session start instead - repeating it in the turn would put it right back in
		// the argv element the file exists to keep small. It is therefore resolved
		// once per session rather than per turn on those runtimes, so a mid-session
		// change to project state reaches the CEO on the next resume rather than the
		// next turn; the alternative is re-uploading ~120 KB into the container on
		// every reply.
		const resolved = RUNTIME_SYSTEM_PROMPT_FILE[session.runtimeType]
			? ''
			: await this.resolveCeoSystemPrompt(session.ceoMemberId, session.projectId);

		// The operator's long-term chat memory stays out of coworker prompts: it
		// belongs to the private assistant chat, not to a group channel of third
		// parties (and coworker windows never compact into it).
		const memory = isCoworker ? null : await getChatMemory(this.deps.db, session.ceoMemberId);

		// The full active (non-compacted) window IS the short-term memory — for
		// assistant threads its size is bounded by compaction. Coworker threads never
		// compact, so their replayed window is capped here instead.
		let window = await loadActiveWindow(this.deps.db, conversationId);
		if (isCoworker && window.length > COWORKER_WINDOW_MAX_MESSAGES) {
			window = window.slice(-COWORKER_WINDOW_MAX_MESSAGES);
		}
		const transcript = window.map(chatTranscriptLine).join('\n\n');

		return [
			resolved,
			session.promptDirective ?? '',
			isCoworker ? GROUP_CHAT_GUIDE : CHAT_GUIDE,
			isCoworker ? '' : formatLongTermMemoryBlock(memory?.content ?? ''),
			// Ephemeral, per-turn context (e.g. fetched Slack channel history). Never
			// persisted as a chat message, so it can't ride the window or compaction.
			opts.injectedContext ?? '',
			'## Conversation so far',
			transcript,
			isCoworker
				? 'Reply to the latest message that mentioned you, as the CEO.'
				: 'Reply to the latest operator message as the CEO.',
		]
			.filter((s) => s.trim() !== '')
			.join('\n\n');
	}

	/**
	 * Compact a thread's active window if it has grown past the byte cap. Runs in
	 * the background after a reply settles; skipped when a newer turn is in flight in
	 * this thread (it retries later) or a compaction is already running for it.
	 * Serialized across threads via `memberCompactionLock` because long-term memory
	 * is shared per CEO member and each compaction rewrites the whole row.
	 */
	private async maybeCompact(ctx: ConversationContext): Promise<void> {
		// Coworker threads never compact — compaction rewrites the CEO's shared
		// long-term memory, which belongs to the operator's assistant chat. Their
		// window is bounded by COWORKER_WINDOW_MAX_MESSAGES at prompt time instead.
		if (ctx.kind === ChatConversationKind.Coworker) return;
		const session = this.live;
		if (!session) return;
		const convo = this.getConvoRuntime(ctx.conversationId);
		if (convo.current || convo.compaction) return;
		const abort = new AbortController();
		convo.compactionAbort = abort;
		// Serialize this thread's compaction behind any other thread's compaction so
		// two threads never rewrite the shared memory row concurrently.
		const run = this.memberCompactionLock
			.catch(() => undefined)
			.then(() => this.runCompaction(session, ctx.conversationId, abort));
		convo.compaction = run;
		this.memberCompactionLock = run.catch(() => undefined);
		try {
			await run;
		} catch (e) {
			// Compaction retries on the next reply, so a credential held elsewhere is
			// a delay to note, not a failure to alarm on.
			if (e instanceof ChatCredentialBusyError)
				log.warn(`CEO chat compaction deferred: ${e.message}`);
			else log.error('CEO chat compaction failed', e);
		} finally {
			if (convo.compactionAbort === abort) convo.compactionAbort = null;
			if (convo.compaction === run) convo.compaction = null;
		}
	}

	/**
	 * Headless compaction run: hand the agent the whole active window and have it
	 * fold the durable points into long-term memory via `update_chat_memory`, then
	 * evict all but the latest few messages. No `chat_message`, no broadcast — the
	 * operator sees nothing. Eviction is gated on the agent actually advancing its
	 * memory this run, so a no-op (or aborted) run loses nothing.
	 */
	private async runCompaction(
		session: LiveSession,
		conversationId: string,
		abort: AbortController,
	): Promise<void> {
		const window = await loadActiveWindow(this.deps.db, conversationId);
		const maxBytes = await getMaxChatHistorySize(this.deps.db);
		const flush = selectFlush(
			window.map((m) => ({
				id: m.id,
				bytes: Buffer.byteLength(m.content, 'utf8'),
				line: chatTranscriptLine(m),
			})),
			maxBytes,
			CHAT_WINDOW_RETAIN_MESSAGES,
		);
		if (!flush.overCap || flush.evictIds.length === 0) return;

		const memory = await getChatMemory(this.deps.db, session.ceoMemberId);
		const before = memory?.updated_at ?? null;
		const prompt = buildCompactionPrompt(memory?.content ?? '', flush.windowTranscript);
		// This prompt is the whole over-cap window, so on an arg-mode runtime it is
		// the one chat exec that can realistically pass MAX_ARG_STRLEN. Failing here
		// leaves the window intact, exactly as an aborted compaction does, and says
		// why in the log instead of dying as `Argument list too long` in the exec.
		assertPromptDeliverable(session.runtimeType, prompt);
		const {
			write: writePrompt,
			remove: removePrompt,
			env,
			cmd: execCmd,
		} = this.turnPrompt(session, conversationId);
		const execScopeId = randomUUID();
		env.push(`HEZO_EXEC_SCOPE_ID=${execScopeId}`);
		await writePrompt(prompt);
		// The reply text is irrelevant - the memory write is the real product,
		// landed via the update_chat_memory MCP tool - but the exec still bills:
		// the parser is here for its usage, and chat is metered.
		const pricing = this.deps.pricing;
		const parser = createAgentChatParser(
			session.runtimeType,
			pricing ? (model, tokens) => pricing.costCents(model, tokens) : undefined,
		);
		try {
			await this.withCredentialLock(session, abort.signal, () =>
				dockerSandboxHandle(this.deps.docker, session.containerId, session.runUser).exec({
					cmd: execCmd,
					env,
					workingDir: CHAT_WORKING_DIR,
					signal: abort.signal,
					onChunk: (chunk) => {
						if (chunk.stream === 'stdout') parser.onStdout(chunk.text);
					},
				}),
			);
			parser.flush();
			await this.recordChatSpend(session, parser.getUsage(), 'Chat memory compaction');
		} catch (e) {
			// A new user turn preempts compaction — that's a clean stop, not a
			// failure; nothing is evicted and it retries later.
			if (abort.signal.aborted) {
				this.killAbandonedExec(session, execScopeId);
				return;
			}
			throw e;
		} finally {
			await removePrompt();
		}
		if (abort.signal.aborted) return;

		// Gate eviction on the agent having written memory this run (any
		// update_chat_memory call bumps updated_at). If it didn't, leave the window
		// intact — the next reply re-triggers compaction.
		const after = await getChatMemory(this.deps.db, session.ceoMemberId);
		const advanced = after !== null && (before === null || after.updated_at !== before);
		if (advanced) {
			await markCompacted(this.deps.db, flush.evictIds);
			// Tell the open chatbox(es) for this thread to drop the evicted
			// messages and show the "chat compacted" marker — the conversation refetch
			// returns just the tail.
			this.broadcastChat(conversationId, {
				type: WsMessageType.ChatCompacted,
				conversationId,
			});
		} else {
			log.warn('CEO compaction did not update long-term memory; window left intact', {
				session: session.sessionId,
			});
		}
	}

	/**
	 * Auto-title a thread from its first message as early as possible, if it's still
	 * untitled — kicked off in parallel with the reply so the label updates on-the-go
	 * rather than only after the reply settles. Best-effort: skipped when a title run
	 * is already in flight for this thread (one at a time; a new turn re-kicks). A
	 * generated title flips the thread from the "New thread" placeholder to a
	 * meaningful name; a failure leaves it untitled and the next turn retries.
	 */
	private async maybeAutoTitle(ctx: ConversationContext): Promise<void> {
		// Coworker threads are titled at creation (from the platform channel) and
		// never appear in the web switcher — no auto-title exec for them.
		if (ctx.kind === ChatConversationKind.Coworker) return;
		const session = this.live;
		if (!session) return;
		const convo = this.getConvoRuntime(ctx.conversationId);
		// One title run per thread at a time; the reply may still be streaming (that's
		// the point — title in parallel), so only a concurrent title run is a conflict.
		if (convo.titling) return;
		// Only untitled threads get auto-titled; a set title (manual or already
		// generated) is never overwritten.
		const existing = await this.getConversation(ctx.conversationId);
		if (!existing || existing.closed_at || existing.title != null) return;
		const abort = new AbortController();
		convo.titlingAbort = abort;
		const run = this.runTitleGeneration(session, ctx.conversationId, abort).catch((e) => {
			if (abort.signal.aborted) return;
			// Titling is retried from the next message, so the same holds here.
			if (e instanceof ChatCredentialBusyError)
				log.warn(`CEO chat auto-title deferred: ${e.message}`);
			else log.error('CEO chat auto-title failed', e);
		});
		convo.titling = run;
		try {
			await run;
		} finally {
			if (convo.titlingAbort === abort) convo.titlingAbort = null;
			if (convo.titling === run) convo.titling = null;
		}
	}

	/**
	 * Headless title run: hand the agent the active window and capture its stdout as a
	 * short title, then persist it (only while the thread is still untitled) and tell
	 * the open chatbox(es) to refetch the thread list. No `chat_message`, no
	 * broadcast of a reply — the operator sees only the switcher label update. The
	 * exec's tokens bill to cost_entries like every chat exec (matches `runCompaction`).
	 */
	private async runTitleGeneration(
		session: LiveSession,
		conversationId: string,
		abort: AbortController,
	): Promise<void> {
		const window = await loadActiveWindow(this.deps.db, conversationId);
		// Title from the first operator message — it's enough to name the topic, and
		// titling from it (rather than waiting for a settled assistant reply) is what
		// lets the label update while the reply is still streaming. An empty window
		// (attachment-only opener with no text, or nothing persisted yet) is skipped so
		// a later turn with real text titles the thread.
		if (!window.some((m) => m.role === ChatMessageRole.User && m.content.trim() !== '')) {
			return;
		}
		const prompt = buildTitlePrompt(window.map(chatTranscriptLine).join('\n\n'));
		// A dedicated prompt file (the `title` slot) so this exec can run concurrently
		// with the reply's exec without either overwriting the other's prompt.
		const {
			write: writePrompt,
			remove: removePrompt,
			env,
			cmd: execCmd,
		} = this.turnPrompt(session, conversationId, 'title');
		const execScopeId = randomUUID();
		env.push(`HEZO_EXEC_SCOPE_ID=${execScopeId}`);
		await writePrompt(prompt);

		const pricing = this.deps.pricing;
		const parser = createAgentChatParser(
			session.runtimeType,
			pricing ? (model, tokens) => pricing.costCents(model, tokens) : undefined,
		);
		let text = '';
		try {
			await this.withCredentialLock(session, abort.signal, () =>
				dockerSandboxHandle(this.deps.docker, session.containerId, session.runUser).exec({
					cmd: execCmd,
					env,
					workingDir: CHAT_WORKING_DIR,
					signal: abort.signal,
					onChunk: (chunk) => {
						if (chunk.stream === 'stdout') {
							for (const ev of parser.onStdout(chunk.text)) if (ev.text) text += ev.text;
						}
					},
				}),
			);
			for (const ev of parser.flush()) if (ev.text) text += ev.text;
			await this.recordChatSpend(session, parser.getUsage(), 'Chat auto-title');
		} catch (e) {
			// A new user turn preempts title generation — a clean stop, retried later.
			if (abort.signal.aborted) {
				this.killAbandonedExec(session, execScopeId);
				return;
			}
			throw e;
		} finally {
			await removePrompt();
		}
		if (abort.signal.aborted) return;

		const title = sanitizeChatTitle(text);
		if (!title) return;
		// Persist only while still untitled, so a concurrent path (or a manual title)
		// is never clobbered; RETURNING confirms we actually set it before broadcasting.
		const updated = await this.deps.db.query<{ id: string }>(
			`UPDATE chat_conversations SET title = $1 WHERE id = $2 AND title IS NULL RETURNING id`,
			[title, conversationId],
		);
		if (updated.rows.length === 0) return;
		this.broadcastChat(conversationId, {
			type: WsMessageType.ChatConversationUpdated,
			conversationId,
			title,
		});
	}

	/**
	 * Two different things can happen to the chat's container, and conflating them
	 * is what used to end a session for no reason.
	 *
	 * **A different container** (id changed, or the project has none) means the
	 * filesystem this session was working in is gone. Nothing can be resumed into
	 * it, so the session is torn down exactly as before.
	 *
	 * **The same container, stopped** is a suspend: the filesystem is intact and
	 * the session holds no long-lived process, so nothing it needs was lost. It is
	 * parked rather than ended - the row stays live, its id keeps anchoring the
	 * message history, and the next turn resumes into it. This is what makes a
	 * managed backend usable, since it suspends sandboxes on its own idle timer;
	 * tearing down there would end the operator's session every quiet period.
	 */
	private async checkHealth(): Promise<void> {
		const live = this.live;
		if (!live || this.suspended) return;
		// The session's container is a pool member pinned by the chat workload
		// (`reserved_for_chat`), so its member row is the authoritative health
		// record. `projects.container_id` names the project's most recently
		// provisioned container - task provisioning rewrites it - so keying health
		// off it tore this session down whenever HQ served an ordinary task run.
		const member = await this.deps.db.query<{
			state: string;
			reserved_for_chat: boolean;
		}>(
			`SELECT state, reserved_for_chat FROM container_pool_members
			  WHERE container_id = $1 AND project_id = $2`,
			[live.containerId, live.projectId],
		);
		const row = member.rows[0];
		if (!row || !row.reserved_for_chat || row.state === 'error') {
			log.warn('HQ chat container replaced or gone; tearing down CEO chat session');
			await this.teardown(ChatSessionStatus.Stopped);
			return;
		}
		if (row.state === 'suspended') {
			await this.suspend();
		}
	}

	/**
	 * Park ahead of a container the idle pass is about to take down.
	 *
	 * `checkHealth` already parks a session whose container it *finds* stopped,
	 * but it polls - so the idle pass won the race every time and the session
	 * learned about the suspension from its tunnel dying instead. That is the
	 * unrequested-death path: it logged "closed unexpectedly", ended the session
	 * as `crashed` rather than parking it as `suspended` (so the next message
	 * started a fresh conversation instead of resuming), and the provider's PTY
	 * DELETE arrived after the sandbox had begun stopping and 400'd, leaking the
	 * session on the provider.
	 *
	 * Called with the container still up, this closes the tunnel deliberately -
	 * which `RunTunnel` does not report as a death - so the teardown is orderly
	 * and the PTY delete lands on a reachable sandbox.
	 *
	 * A no-op unless a live, unparked session is pinned to exactly this container:
	 * the idle pass calls it for every container it retires, most of which the
	 * assistant has nothing to do with.
	 */
	async parkForContainerSuspend(containerId: string): Promise<void> {
		const live = this.live;
		if (!live || this.suspended || live.containerId !== containerId) return;
		await this.suspend();
	}

	/**
	 * Run one CLI exec holding this session's provider credential, keeping the
	 * mounted token in step with the store and storing back whatever the CLI
	 * rotated into it.
	 *
	 * Two separable concerns:
	 *
	 * 1. **Rotation handling (active for Codex).** A chat turn drives the same
	 *    coding CLI a task run does, so on a rotating subscription it consumes and
	 *    rewrites the single-use refresh token. Before the exec the mounted file is
	 *    brought up to date with the store (a task run may have advanced it since
	 *    this session mounted it); after the exec the value the CLI left is read
	 *    back. The read-back is compare-and-set, so a chat turn and a task run can
	 *    rotate the same credential in parallel without one clobbering the other -
	 *    this is why no lock is needed for it.
	 *
	 * 2. **Serialisation (dormant).** If a credential opts into serialising its
	 *    runs ({@link credentialSerializesRuns} - empty today), the whole exec is
	 *    held under the per-credential lock, taken with priority and the run's own
	 *    ceiling: a person is behind this exec, so it queues ahead of runs merely
	 *    parked on the lock and waits on the holder alone, which keeps `onWaiting`'s
	 *    "waiting for X" notice true for the whole wait. No credential does this
	 *    now, so this branch is exercised only through a test rule.
	 */
	private async withCredentialLock<T>(
		session: LiveSession,
		signal: AbortSignal,
		fn: () => Promise<T>,
		opts: { onWaiting?: (holder: CredentialLockHolder) => Promise<void> } = {},
	): Promise<T> {
		const { provider, runtimeType } = session.invocationInputs;
		const { configId, authMethod } = session.invocationInputs.credential;

		// Sync the mount from the store, run, then read the rotation back (CAS).
		// No-op for a non-rotating mount. Independent of serialisation.
		const withRotationHandling = async (): Promise<T> => {
			if (!session.subscriptionMount?.rotates) return fn();
			const value = await refreshSubscriptionMount({
				db: this.deps.db,
				masterKeyManager: this.deps.masterKeyManager,
				engine: this.deps.docker,
				containerId: session.containerId,
				runUser: session.runUser,
				credential: session.invocationInputs.credential,
				mount: session.subscriptionMount,
			});
			this.rememberCredentialValue(session, value);
			try {
				return await fn();
			} finally {
				const rotated = await persistRotatedSubscriptionAuth({
					db: this.deps.db,
					masterKeyManager: this.deps.masterKeyManager,
					engine: this.deps.docker,
					containerId: session.containerId,
					provider,
					credential: session.invocationInputs.credential,
					mount: session.subscriptionMount,
					onNotice: (text: string) => log.warn(text, { session: session.sessionId }),
				});
				if (rotated !== null) this.rememberCredentialValue(session, rotated);
			}
		};

		if (!credentialSerializesRuns(provider, runtimeType, authMethod)) {
			return withRotationHandling();
		}

		const holder = credentialLockHolder(configId);
		let release: (() => void) | null = null;
		try {
			// Enqueued before the notice goes out, so "waiting" is already true when
			// it is read - and a holder that finishes during the notice's own write
			// hands the lock straight to this waiter rather than to whoever asked next.
			const acquiring = acquireCredentialLock(configId, {
				signal,
				// The same test-only override the runner honours for its waits.
				timeoutMs: this.deps.capacityPark?.maxMs ?? CREDENTIAL_WAIT_CAP_MS,
				owner: CHAT_CREDENTIAL_HOLDER,
				priority: true,
			});
			if (holder && opts.onWaiting) {
				// A courtesy, never a reason to abandon a wait that is already queued.
				await opts.onWaiting(holder).catch((e: unknown) => {
					log.warn('CEO chat could not post its credential-wait notice', e);
				});
			}
			release = await acquiring;
		} catch (e) {
			if (e instanceof KeyedLockTimeoutError) {
				throw new ChatCredentialBusyError(credentialLockHolder(configId) ?? holder);
			}
			throw e;
		}
		try {
			// Read-back runs before the release, so the next holder reads what this
			// exec left.
			return await withRotationHandling();
		} finally {
			release();
		}
	}

	/**
	 * Keep the session's snapshot of the credential at the value the store holds,
	 * so the next exec's comparison against the store starts from the truth and
	 * rewrites the mounted file only when the value has really moved.
	 */
	private rememberCredentialValue(session: LiveSession, value: string): void {
		const { credential } = session.invocationInputs;
		if (credential.value === value) return;
		session.invocationInputs = {
			...session.invocationInputs,
			credential: { ...credential, value },
		};
	}

	/**
	 * Park the session on its stopped-but-intact container: release the host-side
	 * allocations (their ports do not survive) and record `suspended`, keeping the
	 * row live so it still owns its container and still blocks a second session.
	 *
	 * No marker kill here, unlike teardown - the container is stopped, so there is
	 * no process tree to reap, and an exec against it would only fail.
	 */
	private async suspend(): Promise<void> {
		const live = this.live;
		if (!live || this.suspended) return;
		this.suspended = true;
		log.info('HQ container suspended; parking CEO chat session', { session: live.sessionId });
		live.closeTunnel();
		await live.releaseSsh().catch(() => undefined);
		await live.releaseEgress().catch(() => undefined);
		await this.deps.db
			.query(`UPDATE chat_sessions SET status = $1 WHERE id = $2`, [
				ChatSessionStatus.Suspended,
				live.sessionId,
			])
			.catch(() => undefined);
	}

	/**
	 * Resume a parked session into its container: start the container again and
	 * re-run the host-side half against the **same** session row, so the id that
	 * anchors this session's messages survives.
	 *
	 * The acquire is scoped to the **chat workload**, so it comes back with the
	 * container this session pinned - resumed if it was suspended - rather than
	 * whichever one the project happens to name. That distinction only appeared
	 * with the pool: asking `ensureProjectContainerRunning` returned the project's
	 * most recently provisioned or resumed container, so once task runs had moved
	 * it on, a perfectly healthy parked session read as "the container was
	 * replaced" and was torn down. Getting a genuinely different id back still
	 * means the pinned container is gone (the pin was dropped as stale), and
	 * starting fresh is right then - the filesystem this conversation was built
	 * against no longer exists.
	 */
	private async resumeSession(): Promise<LiveSession> {
		const live = this.live;
		if (!live) throw new Error('no session to resume');
		const acquired = await acquireRunContainer(
			this.buildContainerDeps(),
			live.projectId,
			null,
			'chat',
		);
		const containerId = acquired.containerId;
		if (containerId !== live.containerId) {
			log.warn('HQ container was replaced while suspended; starting a fresh CEO chat session');
			await this.teardown(ChatSessionStatus.Stopped);
			return this.startSession();
		}

		try {
			// Replaying the stored inputs is correct only because `ensureSession` has
			// already confirmed the instance still resolves to them; a moved default
			// tears the session down there and never reaches this path.
			const allocation = await this.allocateHostSide(
				live.sessionId,
				containerId,
				live.runUser,
				live.invocationInputs,
			);
			await this.deps.db.query(`UPDATE chat_sessions SET status = $1 WHERE id = $2`, [
				ChatSessionStatus.Running,
				live.sessionId,
			]);
			this.live = { ...live, ...allocation };
			this.suspended = false;
			log.info('CEO chat session resumed', { session: live.sessionId });
			return this.live;
		} catch (err) {
			// The session cannot serve a turn without its host-side half, and leaving
			// it parked would retry the same failure on every message. End it so the
			// next turn starts cleanly and the error is recorded once.
			await this.deps.db
				.query(
					`UPDATE chat_sessions SET status = $1, error = $2, stopped_at = now() WHERE id = $3`,
					[ChatSessionStatus.Crashed, (err as Error).message, live.sessionId],
				)
				.catch(() => undefined);
			this.live = null;
			this.suspended = false;
			throw err;
		}
	}

	private async shutdown(): Promise<void> {
		await this.abortAllCurrent('shutdown');
		await this.teardown(ChatSessionStatus.Stopped);
	}

	private async teardown(status: ChatSessionStatus): Promise<void> {
		const live = this.live;
		if (!live) return;
		this.live = null;
		this.suspended = false;
		// Session-wide reap: every exec of this session (and its children) carries
		// HEZO_HEARTBEAT_RUN_ID=<sessionId>, and by teardown they have all been
		// aborted — nothing live shares the marker, so the broad kill is safe here
		// (unlike per-turn interrupts, which must use the per-exec scope id).
		// Bounded + best-effort: a stopped/gone container just fails the exec.
		await this.deps.docker
			.killProcessesByEnvMarker(live.containerId, 'HEZO_HEARTBEAT_RUN_ID', live.sessionId)
			.catch(() => undefined);
		live.closeTunnel();
		await live.releaseSsh().catch(() => undefined);
		await live.releaseEgress().catch(() => undefined);
		// Hand the container back to the pool. Suspend deliberately does NOT do this:
		// a parked session still owns its container and resumes into it.
		await setPoolMemberChatReservation(this.deps.db, live.containerId, false).catch(
			() => undefined,
		);
		await this.deps.db
			.query(`UPDATE chat_sessions SET status = $1, stopped_at = now() WHERE id = $2`, [
				status,
				live.sessionId,
			])
			.catch(() => undefined);
	}

	private async resolveCeoMemberId(): Promise<string> {
		const r = await this.deps.db.query<{ id: string }>(
			`SELECT m.id FROM members m
			 JOIN member_agents ma ON ma.id = m.id
			 WHERE ma.slug = $1 AND m.team_id = $2`,
			[CEO_AGENT_SLUG, DEFAULT_TEAM_ID],
		);
		const id = r.rows[0]?.id;
		if (!id) throw new Error('CEO agent not found in HQ team');
		return id;
	}

	/** The HQ (is_internal) project — the scope a CEO chat conversation belongs to. */
	private async resolveHqProjectId(): Promise<string> {
		const r = await this.deps.db.query<{ id: string }>(
			`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
			[DEFAULT_TEAM_ID],
		);
		const id = r.rows[0]?.id;
		if (!id) throw new Error('HQ project not found');
		return id;
	}

	private async insertMessage(input: {
		conversationId: string;
		role: ChatMessageRole;
		channel: ChatChannel;
		status: ChatMessageStatus;
		content: string;
		authorUserId?: string | null;
		authorMemberId?: string | null;
		authorLabel?: string | null;
		sessionId?: string | null;
		/** Required for a `system` row; the chatbox renders each kind differently. */
		systemKind?: ChatSystemMessageKind | null;
		completed: boolean;
	}): Promise<string> {
		const r = await this.deps.db.query<{ id: string }>(
			`INSERT INTO chat_messages
			   (conversation_id, role, channel, status, content, author_user_id, author_member_id, author_label, session_id, system_kind, completed_at)
			 VALUES ($1, $2::chat_message_role, $3::chat_channel, $4::chat_message_status, $5, $6, $7, $8, $9, $10, ${input.completed ? 'now()' : 'NULL'})
			 RETURNING id`,
			[
				input.conversationId,
				input.role,
				input.channel,
				input.status,
				input.content,
				input.authorUserId ?? null,
				input.authorMemberId ?? null,
				input.authorLabel ?? null,
				input.sessionId ?? null,
				input.systemKind ?? null,
			],
		);
		return r.rows[0].id;
	}

	private async finalizeMessage(
		conversationId: string,
		messageId: string,
		status: ChatMessageStatus,
		content: string,
		usage: AgentRunUsage | null,
		error?: string,
	): Promise<void> {
		await this.deps.db.query(
			`UPDATE chat_messages
			 SET status = $2::chat_message_status, content = $3, input_tokens = $4, output_tokens = $5,
			     cost_cents = $6, error = $7, completed_at = now()
			 WHERE id = $1`,
			[
				messageId,
				status,
				content,
				usage?.inputTokens ?? 0,
				usage?.outputTokens ?? 0,
				usage?.costCents ?? 0,
				error ?? null,
			],
		);
		if (this.live) {
			await this.deps.db
				.query(`UPDATE chat_sessions SET last_activity_at = now() WHERE id = $1`, [
					this.live.sessionId,
				])
				.catch(() => undefined);
		}
		await this.touchConversation(conversationId);
		this.broadcastChat(conversationId, {
			type: WsMessageType.ChatMessageComplete,
			conversationId,
			messageId,
			status,
			content,
			inputTokens: usage?.inputTokens ?? 0,
			outputTokens: usage?.outputTokens ?? 0,
			costCents: usage?.costCents ?? 0,
			error: error ?? null,
		});
	}

	private broadcastStart(
		conversationId: string,
		messageId: string,
		role: ChatMessageRole,
		channel: ChatChannel,
		content: string,
		attachments?: CommentAttachment[],
		systemKind?: ChatSystemMessageKind,
	): void {
		this.broadcastChat(conversationId, {
			type: WsMessageType.ChatMessageStart,
			conversationId,
			messageId,
			role,
			channel,
			content,
			createdAt: new Date().toISOString(),
			...(attachments && attachments.length > 0 ? { attachments } : {}),
			...(systemKind ? { systemKind } : {}),
		});
	}

	/**
	 * Streaming deltas coalesce on a short timer and go ONLY to the thread's own
	 * room. Some runtimes emit per-line frames, so raw fan-out multiplied frames
	 * nobody rendered - the list surfaces on the global room show no delta text,
	 * and the open thread repaints just as live from a 150ms batch. The timer is
	 * shared across messages; each flush sends one frame per in-flight message.
	 */
	private broadcastDelta(conversationId: string, messageId: string, text: string): void {
		const buf = this.deltaBuffers.get(messageId);
		if (buf) buf.text += text;
		else this.deltaBuffers.set(messageId, { conversationId, text });
		if (this.deltaFlushTimer === null) {
			this.deltaFlushTimer = setTimeout(() => this.flushDeltas(), DELTA_FLUSH_MS);
		}
	}

	private flushDeltas(): void {
		if (this.deltaFlushTimer !== null) {
			clearTimeout(this.deltaFlushTimer);
			this.deltaFlushTimer = null;
		}
		if (this.deltaBuffers.size === 0) return;
		for (const [messageId, buf] of this.deltaBuffers) {
			this.deps.wsManager.broadcast(wsRoom.chatConversation(buf.conversationId), {
				type: WsMessageType.ChatMessageDelta,
				conversationId: buf.conversationId,
				messageId,
				text: buf.text,
			});
		}
		this.deltaBuffers.clear();
	}

	/**
	 * Fan a chat event out to the thread's own room (the open chatbox for that
	 * conversation) and the global signal room (the conversation list, for activity
	 * badges). The web client subscribes to the per-conversation room for the thread
	 * it's viewing and to the global room for the list. Streaming deltas do NOT come
	 * through here - they coalesce in {@link broadcastDelta} and reach only the
	 * per-conversation room; flushing them first keeps ordering (a Complete must
	 * never overtake the text it completes).
	 */
	private broadcastChat(conversationId: string, message: WsChatServerMessage): void {
		this.flushDeltas();
		this.deps.wsManager.broadcast(wsRoom.chatConversation(conversationId), { ...message });
		this.deps.wsManager.broadcast(wsRoom.chat(), { ...message });
	}
}

/** The task a converted conversation became, for switcher/meta-message links. */
export interface ConvertedTaskRef {
	id: string;
	identifier: string;
	title: string;
	project_slug: string;
}

/** A conversation as served to the web (thread switcher and single reads). */
export interface ConversationSummary {
	id: string;
	channel: ChatChannel;
	external_thread_id: string | null;
	kind: ChatConversationKind;
	title: string | null;
	closed_at: string | null;
	/** Present on listings (drives ordering); omitted on single reads. */
	last_activity_at?: string;
	converted_task_id: string | null;
	/** Joined reference; null when not converted or the task was deleted. */
	converted_task: ConvertedTaskRef | null;
}

export type ChatConvertErrorCode =
	| 'NOT_FOUND'
	| 'READ_ONLY'
	| 'CLOSED'
	| 'ALREADY_CONVERTED'
	| 'INVALID_REQUEST';

/** Typed failure for convert-to-task, mapped to a 4xx by the route. */
export class ChatConvertError extends Error {
	readonly code: ChatConvertErrorCode;
	constructor(code: ChatConvertErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = 'ChatConvertError';
	}
}

// Conversation projection shared by getConversation/listConversations: the row
// plus the converted-task reference (identifier/title/project slug) joined in,
// so the switcher and the meta message can link the task without extra reads.
const CONVERSATION_COLUMNS = `c.id, c.channel, c.external_thread_id, c.kind, c.title, c.closed_at,
	c.converted_task_id, t.identifier AS converted_task_identifier, t.title AS converted_task_title,
	p.slug AS converted_task_project_slug`;
const CONVERTED_TASK_JOIN = `LEFT JOIN tasks t ON t.id = c.converted_task_id
	 LEFT JOIN projects p ON p.id = t.project_id`;

interface ConversationRow {
	id: string;
	channel: ChatChannel;
	external_thread_id: string | null;
	kind: ChatConversationKind;
	title: string | null;
	closed_at: string | null;
	last_activity_at?: string;
	converted_task_id: string | null;
	converted_task_identifier: string | null;
	converted_task_title: string | null;
	converted_task_project_slug: string | null;
}

function toConversationSummary(row: ConversationRow): ConversationSummary {
	const { converted_task_identifier, converted_task_title, converted_task_project_slug, ...rest } =
		row;
	const converted_task: ConvertedTaskRef | null =
		row.converted_task_id && converted_task_identifier && converted_task_project_slug
			? {
					id: row.converted_task_id,
					identifier: converted_task_identifier,
					title: converted_task_title ?? '',
					project_slug: converted_task_project_slug,
				}
			: null;
	return { ...rest, converted_task };
}

/** Default task title fallback: the first user message, trimmed to one line. */
function firstUserLine(window: WindowMessage[]): string | null {
	const first = window.find((m) => m.role === ChatMessageRole.User && m.content.trim() !== '');
	if (!first) return null;
	const line = first.content.trim().split('\n')[0];
	return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
