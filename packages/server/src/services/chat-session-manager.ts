import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
	type CommentAttachment,
	DEFAULT_TEAM_ID,
	PROVIDER_RUNTIME_ADAPTERS,
	type WsChatServerMessage,
	WsMessageType,
	wsRoom,
} from '@hezo/shared';
import { trackBackground } from '../lib/background';
import { loadChatMessageAttachments } from '../lib/chat-attachments';
import { getMaxChatHistorySize } from '../lib/system-meta';
import { logger } from '../logger';
import { signChatSessionJwt } from '../middleware/auth';
import {
	buildRuntimeInvocation,
	type EgressEnvDescriptor,
	getContainerPromptPath,
	getHostPromptPath,
	type RunnerDeps,
} from './agent-runner';
import {
	type AgentChatParser,
	type AgentRunUsage,
	createAgentChatParser,
} from './agent-stream-parser';
import { getProviderCredentialAndModel } from './ai-provider-keys';
import { getChatMemory, loadActiveWindow, markCompacted, selectFlush } from './chat-memory';
import { formatContainerConnectivityMessage } from './container-connectivity-preflight';
import { CONNECTIVITY_STALE_MS, shouldAbortForConnectivity } from './container-connectivity-status';
import type { ContainerLogStreamer } from './container-logs';
import { type ContainerRunUser, resolveContainerRunUser } from './container-user';
import { type ContainerDeps, ensureProjectContainerRunning } from './containers';
import { getAgentSystemPrompt } from './documents';
import { applyEffortToRuntime, type EffortRuntimeApplication } from './effort';
import { resolveRuntimeForTask } from './runtime-resolver';
import type { BridgeRunnerArgs } from './ssh-agent';
import { resolveSystemPrompt } from './template-resolver';
import { getRunSocketPath } from './workspace';
import type { WebSocketManager } from './ws';

const log = logger.child('chat-session');

/** Container working directory for the (repo-free) chat session. */
const CHAT_WORKING_DIR = '/workspace';
/** How often to verify the live session's container is still healthy. */
const HEALTH_INTERVAL_MS = Number(process.env.HEZO_CHAT_HEALTH_INTERVAL_MS ?? 10_000);

const CHAT_GUIDE = `# Live Chat

You are in a real-time chat with the operator — the human running this Hezo instance — through the web app. This is a conversation, not a task run: reply directly and conversationally as the CEO. You hold cross-team privileges here, so you can read from and act across every project in the org: \`list_projects\` returns every project across the org, and the project roster already in your context is rebuilt each turn. Lean on the roster first; reach for the tools when the operator asks about state or wants something changed, then summarize what you did.

Because you roam across every project here, there is **no per-project "Project State" block in your context** — its open-ticket count in the roster is a summary only. To report a project's live status (its actual tickets and their statuses, or its roster), call \`list_tasks\` / \`list_agents\` with that project's slug as the \`project\` argument. Never tell the operator a project is empty off the roster count alone — check with the tools first.

Because this chat is human-facing, refer to projects, tickets, teams, docs, and teammates by their bare slug, identifier, or name (e.g. the project todo6, ticket TO-1, prd.md, @@captain) — never paste raw UUIDs. Tools accept the same slugs and identifiers you use with the operator, so you never need a UUID. Write entity references bare, never wrapped in backticks: bare references render as clickable links in the chat, while backticked ones render as inert code and break the link. Keep replies focused and skip ceremony.

## Long-term memory

Your context carries a **Long-term memory** block (below the guide, above the conversation) — your durable notes across this chat, maintained automatically. The recent conversation is kept verbatim in a rolling window; when it grows past its size cap the whole window is summarized into this long-term memory and the older messages drop out of the window, so the gist of past exchanges survives even after the raw messages scroll away.

You don't need a "remember" instruction from the operator and there's no manual save step for ordinary chat — the system compacts the window into memory for you. When a compaction is due you'll be handed the window and asked to fold its durable points into memory with \`update_chat_memory\`; you may also call that tool yourself any time you want to record something standing. Keep memory short and curated — **durable, standing knowledge only** (operator preferences, decisions, the gist of off-project threads), never live data you can re-fetch each turn (project/ticket/comment state, rosters, counts). That is rebuilt into your context every turn; copying it into memory only goes stale.

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
 * CHAT_WINDOW_RETAIN_MESSAGES, which governs the mirror-mode compaction tail.
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

Do **NOT** record live data you can re-fetch each turn — project/ticket/comment state, rosters, counts. That goes stale; the tools are the source of truth.

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
	releaseEgress: () => Promise<void>;
	releaseSsh: () => Promise<void>;
}

interface CurrentTurn {
	assistantMessageId: string;
	abort: AbortController;
	promise: Promise<void>;
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
	// seam that keeps mirroring channel-agnostic (a new channel touches no manager code).
	private channelHooks: ChannelHooks | null = null;

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
		}, HEALTH_INTERVAL_MS);
	}

	async stop(): Promise<void> {
		if (this.healthTimer) {
			clearInterval(this.healthTimer);
			this.healthTimer = null;
		}
		await this.shutdown();
	}

	/**
	 * Mark sessions left `starting`/`running` by a previous process as crashed —
	 * their in-container process (if any) is orphaned and the in-memory state is
	 * gone. Frees the singleton index so a fresh session can start.
	 */
	async reconcileOnStartup(): Promise<void> {
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
		/** Conversation mode when creating (default mirror). Existing rows keep their kind. */
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
	}): Promise<{ userMessageId: string; assistantMessageId: string; conversationId: string }> {
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
			authorLabel?: string | null;
			injectedContext?: string;
		},
		ctx: ConversationContext,
	): Promise<{ userMessageId: string; assistantMessageId: string; conversationId: string }> {
		const session = await this.ensureSession();
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

		// An in-flight reply in this thread: mirror threads interrupt it (abort, keep
		// the partial as `interrupted`) so only the latest turn streams to the
		// operator. Coworker threads QUEUE instead — in a group channel two quick
		// mentions are two people expecting two answers, and an aborted partial would
		// silently post nothing to the platform (only completed replies deliver).
		if (convo.current) {
			if (!isCoworker) convo.current.abort.abort('interrupted');
			await convo.current.promise.catch(() => undefined);
		}

		const userMessageId = await this.insertMessage({
			conversationId,
			role: ChatMessageRole.User,
			channel,
			status: ChatMessageStatus.Complete,
			content: input.text,
			authorUserId: input.authorUserId ?? null,
			authorLabel: input.authorLabel ?? null,
			completed: true,
		});
		// Link any uploaded files to the user message, then resolve their metadata so
		// the sent bubble streams in with its attachment chips already attached.
		const attachmentIds = input.attachmentIds ?? [];
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
		await this.touchConversation(conversationId);
		// Every thread is visible in the web view (coworker threads read-only), so
		// every turn broadcasts — the web renders the stored conversation live.
		this.broadcastStart(
			conversationId,
			userMessageId,
			ChatMessageRole.User,
			channel,
			input.text,
			userAttachments,
		);

		const assistantMessageId = await this.insertMessage({
			conversationId,
			role: ChatMessageRole.Assistant,
			channel,
			status: ChatMessageStatus.Streaming,
			content: '',
			authorMemberId: session.ceoMemberId,
			sessionId: session.sessionId,
			completed: false,
		});
		this.broadcastStart(conversationId, assistantMessageId, ChatMessageRole.Assistant, channel, '');

		const abort = new AbortController();
		const promise = this.runTurn(session, ctx, assistantMessageId, abort, input.injectedContext);
		convo.current = { assistantMessageId, abort, promise };
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

		return { userMessageId, assistantMessageId, conversationId };
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
	async getConversation(conversationId: string): Promise<{
		id: string;
		channel: ChatChannel;
		external_thread_id: string | null;
		kind: ChatConversationKind;
		title: string | null;
		closed_at: string | null;
	} | null> {
		const r = await this.deps.db.query<{
			id: string;
			channel: ChatChannel;
			external_thread_id: string | null;
			kind: ChatConversationKind;
			title: string | null;
			closed_at: string | null;
		}>(
			`SELECT id, channel, external_thread_id, kind, title, closed_at
			 FROM chat_conversations WHERE id = $1`,
			[conversationId],
		);
		return r.rows[0] ?? null;
	}

	/**
	 * List conversations (open by default), newest activity first — every kind:
	 * the web view is the hub that sees all threads. `channel` (the thread's home
	 * surface) and `kind` drive the switcher's badges, grouping, and the
	 * read-only treatment of coworker threads.
	 */
	async listConversations(opts?: { includeClosed?: boolean }): Promise<
		Array<{
			id: string;
			channel: ChatChannel;
			external_thread_id: string | null;
			kind: ChatConversationKind;
			title: string | null;
			last_activity_at: string;
			closed_at: string | null;
		}>
	> {
		const ceoMemberId = await this.resolveCeoMemberId();
		const r = await this.deps.db.query<{
			id: string;
			channel: ChatChannel;
			external_thread_id: string | null;
			kind: ChatConversationKind;
			title: string | null;
			last_activity_at: string;
			closed_at: string | null;
		}>(
			`SELECT id, channel, external_thread_id, kind, title, last_activity_at, closed_at
			 FROM chat_conversations
			 WHERE member_id = $1 ${opts?.includeClosed ? '' : 'AND closed_at IS NULL'}
			 ORDER BY last_activity_at DESC, created_at DESC`,
			[ceoMemberId],
		);
		return r.rows;
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
		const rt = this.convos.get(conversationId);
		if (rt?.current) {
			rt.current.abort.abort('closed');
			await rt.current.promise.catch(() => undefined);
		}
		if (rt?.compactionAbort) {
			rt.compactionAbort.abort('closed');
			await rt.compaction?.catch(() => undefined);
		}
		if (rt?.titlingAbort) {
			rt.titlingAbort.abort('closed');
			await rt.titling?.catch(() => undefined);
		}
		this.convos.delete(conversationId);
		await this.deps.db.query(`UPDATE chat_conversations SET closed_at = now() WHERE id = $1`, [
			conversationId,
		]);
		if (this.channelHooks && convo.channel !== ChatChannel.Web && convo.external_thread_id) {
			await this.channelHooks
				.closeThread(convo.channel, convo.external_thread_id)
				.catch((e) => log.error(`close ${convo.channel} thread failed`, e));
		}
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
		if (this.live) return this.live;
		if (this.ensuring) return this.ensuring;
		this.ensuring = this.startSession().finally(() => {
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
			egressCAPath: this.deps.egressCAPath ?? null,
		};
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

		const proj = await db.query<{
			id: string;
			container_id: string | null;
			container_status: string | null;
		}>(
			`SELECT id, container_id, container_status FROM projects
			 WHERE team_id = $1 AND is_internal = true`,
			[DEFAULT_TEAM_ID],
		);
		const project = proj.rows[0];
		if (!project) throw new Error('HQ project not found');
		// The CEO chat is available app-wide from first load, before any project is
		// created, so the HQ container may never have been provisioned. Bring it up
		// on demand rather than failing the turn.
		const containerId =
			project.container_status === 'running' && project.container_id
				? project.container_id
				: await ensureProjectContainerRunning(this.buildContainerDeps(), project.id);

		// Detect the HQ container's run-user once for this session; reused on every
		// turn's exec, the ssh socket owner, and the per-turn config-dir chown.
		const runUser = await resolveContainerRunUser(this.deps.docker, containerId);

		const override = await db.query<{ provider: AiProvider | null; model: string | null }>(
			`SELECT model_override_provider AS provider, model_override_model AS model
			 FROM member_agents WHERE id = $1`,
			[ceoMemberId],
		);
		let provider = override.rows[0]?.provider ?? null;
		let runtimeType: AgentRuntime;
		if (provider) {
			runtimeType = PROVIDER_RUNTIME_ADAPTERS[provider].runtime;
		} else {
			const resolved = await resolveRuntimeForTask(db, null);
			if (!resolved) throw new Error('No AI provider credentials configured');
			provider = resolved.provider;
			runtimeType = resolved.runtime;
		}

		const credential = await getProviderCredentialAndModel(
			db,
			this.deps.masterKeyManager,
			provider,
		);
		if (!credential) throw new Error(`No ${provider} credential configured`);
		const modelOverride = override.rows[0]?.model ?? credential.defaultModel ?? null;

		// Reclaim any DB rows left live by a crash without an in-memory session, so
		// the singleton insert below doesn't collide.
		await db.query(
			`UPDATE chat_sessions SET status = $1, stopped_at = now()
			 WHERE member_id = $2 AND status IN ($3, $4)`,
			[
				ChatSessionStatus.Crashed,
				ceoMemberId,
				ChatSessionStatus.Starting,
				ChatSessionStatus.Running,
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

		let releaseSsh = async (): Promise<void> => undefined;
		let releaseEgress = async (): Promise<void> => undefined;
		try {
			const label = `chat`;

			// Warm ssh bridge (commit signing / git over ssh), allocated once.
			let sshSocketContainerPath: string | null = null;
			let bridge: BridgeRunnerArgs | null = null;
			const sshAgentServer = this.deps.sshAgentServer;
			if (sshAgentServer) {
				const socketHostPath = getRunSocketPath(this.deps.dataDir, sessionId);
				const allocated = await sshAgentServer.allocateRunSocket(
					sessionId,
					{ teamId: DEFAULT_TEAM_ID, agentId: ceoMemberId, label },
					socketHostPath,
				);
				sshSocketContainerPath = `/run/hezo/${sessionId}.sock`;
				bridge = {
					socketPath: sshSocketContainerPath,
					socketUser: runUser.name,
					tokenHex: allocated.tokenHex,
					hostName: 'host.docker.internal',
					hostPort: allocated.tcpHostPort,
				};
				releaseSsh = () => sshAgentServer.releaseRunSocket(sessionId);
			}

			// Warm egress proxy (secret substitution), allocated once.
			let egress: EgressEnvDescriptor | null = null;
			const egressProxy = this.deps.egressProxy;
			if (egressProxy && this.deps.egressCAPath) {
				// Abort with operator guidance when the proxy is known-unreachable from
				// containers, rather than launching the CEO into a black-hole proxy that
				// would silently fall through to direct egress. The throw is caught below,
				// which releases the ssh bridge and records the session error. Fail open on
				// ok/skipped/unknown (and when no status holder is wired).
				const connectivityStatus = this.deps.connectivityStatus;
				const connectivityProbe = this.deps.connectivityProbe;
				if (connectivityStatus && connectivityProbe) {
					// Re-confirm a BAD cached outcome before blocking (maxAge 0): the probe
					// auto-rebinds against the live bind host, so a stale/race-poisoned
					// loopback result self-heals instead of blocking until restart.
					const cached = connectivityStatus.get().status;
					const maxAge = shouldAbortForConnectivity(cached) ? 0 : CONNECTIVITY_STALE_MS;
					const status = await connectivityStatus.ensureFresh(connectivityProbe, maxAge);
					if (shouldAbortForConnectivity(status)) {
						const guidance = formatContainerConnectivityMessage(status, {
							serverPort: this.deps.serverPort,
							containerBindHost: connectivityStatus.get().bindHost,
						});
						throw new Error(
							`Egress proxy unreachable from agent containers — cannot start CEO chat.\n\n${guidance}`,
						);
					}
				}
				const allocated = await egressProxy.allocateRunProxy(sessionId, {
					teamId: DEFAULT_TEAM_ID,
					agentId: ceoMemberId,
					projectId: project.id,
					label,
				});
				egress = {
					host: allocated.proxyHost,
					port: allocated.proxyPort,
					containerCAPath: '/usr/local/share/ca-certificates/hezo-egress.crt',
					token: allocated.token,
				};
				releaseEgress = () => egressProxy.releaseRunProxy(sessionId);
			}

			const agentJwt = await signChatSessionJwt(
				this.deps.masterKeyManager,
				ceoMemberId,
				DEFAULT_TEAM_ID,
				sessionId,
				project.id,
			);

			// Max thinking — the CEO chat runs at the highest reasoning effort.
			const effortApplication: EffortRuntimeApplication = applyEffortToRuntime(
				runtimeType,
				AgentEffort.Max,
			);

			const invocation = await buildRuntimeInvocation({
				deps: this.deps,
				runTeamId: DEFAULT_TEAM_ID,
				projectId: project.id,
				provider,
				credential,
				runtimeType,
				agentJwt,
				agentId: ceoMemberId,
				resourceId: sessionId,
				containerId,
				runUser,
				promptContainerPath: getContainerPromptPath(sessionId),
				effort: AgentEffort.Max,
				effortApplication,
				modelOverride,
				sshSocketContainerPath,
				bridge,
				egress,
			});

			await db.query(`UPDATE chat_sessions SET status = $1 WHERE id = $2`, [
				ChatSessionStatus.Running,
				sessionId,
			]);

			this.live = {
				sessionId,
				ceoMemberId,
				projectId: project.id,
				containerId,
				runUser,
				runtimeType,
				env: invocation.env,
				execCmd: invocation.execCmd,
				promptDirective: effortApplication.promptDirective ?? null,
				releaseEgress,
				releaseSsh,
			};
			log.info(`CEO chat session started (runtime=${runtimeType})`, { session: sessionId });
			return this.live;
		} catch (err) {
			await releaseSsh().catch(() => undefined);
			await releaseEgress().catch(() => undefined);
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
	): { hostPath: string; env: string[] } {
		const key = slot
			? `${session.sessionId}-${conversationId}-${slot}`
			: `${session.sessionId}-${conversationId}`;
		const hostPath = getHostPromptPath(this.deps.dataDir, DEFAULT_TEAM_ID, session.projectId, key);
		const containerPath = getContainerPromptPath(key);
		const env = session.env.map((e) =>
			e.startsWith('HEZO_PROMPT_FILE=') ? `HEZO_PROMPT_FILE=${containerPath}` : e,
		);
		return { hostPath, env };
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
		const { hostPath, env } = this.turnPrompt(session, conversationId);
		// Per-exec scope marker: session-level HEZO_HEARTBEAT_RUN_ID is shared by
		// every exec of this session (turns in other conversations, compaction,
		// titling), so an interrupt must kill by a marker unique to THIS exec or it
		// would murder a sibling conversation's live reply.
		const execScopeId = randomUUID();
		env.push(`HEZO_EXEC_SCOPE_ID=${execScopeId}`);
		const accumulated = { text: '' };
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
			mkdirSync(dirname(hostPath), { recursive: true });
			writeFileSync(hostPath, prompt);

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
				}
			};

			const execId = await this.deps.docker.execCreate(session.containerId, {
				Cmd: session.execCmd,
				Env: env,
				WorkingDir: CHAT_WORKING_DIR,
				User: session.runUser.name,
				AttachStdout: true,
				AttachStderr: true,
			});
			await this.deps.docker.execStart(execId, {
				signal: abort.signal,
				onChunk: (chunk) => {
					if (chunk.stream === 'stdout') handle(parser.onStdout(chunk.text));
				},
			});
			handle(parser.flush());
			await finalize(ChatMessageStatus.Complete, parser.getUsage());
		} catch (err) {
			if (abort.signal.aborted) {
				// Aborting only tears down the attach stream — reap the abandoned
				// in-container CLI by this exec's own scope marker.
				this.killAbandonedExec(session, execScopeId);
				await finalize(ChatMessageStatus.Interrupted, null);
			} else {
				log.error('CEO chat turn failed', err);
				await finalize(ChatMessageStatus.Failed, null, (err as Error).message);
			}
		} finally {
			rmSync(hostPath, { force: true });
			if (convo.current?.assistantMessageId === assistantMessageId) convo.current = null;
		}
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

	private async composePrompt(
		session: LiveSession,
		conversationId: string,
		opts: { kind: ChatConversationKind; injectedContext?: string },
	): Promise<string> {
		const isCoworker = opts.kind === ChatConversationKind.Coworker;
		const stored = await getAgentSystemPrompt(this.deps.db, DEFAULT_TEAM_ID, session.ceoMemberId);
		const resolved = await resolveSystemPrompt(this.deps.db, stored, {
			teamId: DEFAULT_TEAM_ID,
			projectId: session.projectId,
			agentId: session.ceoMemberId,
			dataDir: this.deps.dataDir,
			mode: 'runtime',
			crossTeam: true,
			// Embed the full bundled docs so the CEO can answer setup/usage questions
			// in live chat; headless CEO runs get only the live-docs pointer.
			embedDocs: true,
		});

		// The operator's long-term chat memory stays out of coworker prompts: it
		// belongs to the private assistant chat, not to a group channel of third
		// parties (and coworker windows never compact into it).
		const memory = isCoworker ? null : await getChatMemory(this.deps.db, session.ceoMemberId);

		// The full active (non-compacted) window IS the short-term memory — for
		// mirror threads its size is bounded by compaction. Coworker threads never
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
			log.error('CEO chat compaction failed', e);
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
		const { hostPath, env } = this.turnPrompt(session, conversationId);
		const execScopeId = randomUUID();
		env.push(`HEZO_EXEC_SCOPE_ID=${execScopeId}`);
		mkdirSync(dirname(hostPath), { recursive: true });
		writeFileSync(hostPath, prompt);
		try {
			const execId = await this.deps.docker.execCreate(session.containerId, {
				Cmd: session.execCmd,
				Env: env,
				WorkingDir: CHAT_WORKING_DIR,
				User: session.runUser.name,
				AttachStdout: true,
				AttachStderr: true,
			});
			// Drain output; the reply text is irrelevant — the memory write is the
			// real product, landed via the update_chat_memory MCP tool.
			await this.deps.docker.execStart(execId, { signal: abort.signal, onChunk: () => undefined });
		} catch (e) {
			// A new user turn preempts compaction — that's a clean stop, not a
			// failure; nothing is evicted and it retries later.
			if (abort.signal.aborted) {
				this.killAbandonedExec(session, execScopeId);
				return;
			}
			throw e;
		} finally {
			rmSync(hostPath, { force: true });
		}
		if (abort.signal.aborted) return;

		// Gate eviction on the agent having written memory this run (any
		// update_chat_memory call bumps updated_at). If it didn't, leave the window
		// intact — the next reply re-triggers compaction.
		const after = await getChatMemory(this.deps.db, session.ceoMemberId);
		const advanced = after !== null && (before === null || after.updated_at !== before);
		if (advanced) {
			await markCompacted(this.deps.db, flush.evictIds);
			// Tell the mirrored chatbox(es) for this thread to drop the evicted
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
			if (!abort.signal.aborted) log.error('CEO chat auto-title failed', e);
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
	 * the mirrored chatbox(es) to refetch the thread list. No `chat_message`, no
	 * broadcast of a reply — the operator sees only the switcher label update. The
	 * exec's tokens are not separately priced (matches `runCompaction`).
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
		const { hostPath, env } = this.turnPrompt(session, conversationId, 'title');
		const execScopeId = randomUUID();
		env.push(`HEZO_EXEC_SCOPE_ID=${execScopeId}`);
		mkdirSync(dirname(hostPath), { recursive: true });
		writeFileSync(hostPath, prompt);

		const parser = createAgentChatParser(session.runtimeType);
		let text = '';
		try {
			const execId = await this.deps.docker.execCreate(session.containerId, {
				Cmd: session.execCmd,
				Env: env,
				WorkingDir: CHAT_WORKING_DIR,
				User: session.runUser.name,
				AttachStdout: true,
				AttachStderr: true,
			});
			await this.deps.docker.execStart(execId, {
				signal: abort.signal,
				onChunk: (chunk) => {
					if (chunk.stream === 'stdout') {
						for (const ev of parser.onStdout(chunk.text)) if (ev.text) text += ev.text;
					}
				},
			});
			for (const ev of parser.flush()) if (ev.text) text += ev.text;
		} catch (e) {
			// A new user turn preempts title generation — a clean stop, retried later.
			if (abort.signal.aborted) {
				this.killAbandonedExec(session, execScopeId);
				return;
			}
			throw e;
		} finally {
			rmSync(hostPath, { force: true });
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

	private async checkHealth(): Promise<void> {
		if (!this.live) return;
		const proj = await this.deps.db.query<{
			container_id: string | null;
			container_status: string | null;
		}>(`SELECT container_id, container_status FROM projects WHERE id = $1`, [this.live.projectId]);
		const row = proj.rows[0];
		if (!row || row.container_status !== 'running' || row.container_id !== this.live.containerId) {
			log.warn('HQ container unavailable; tearing down CEO chat session');
			await this.teardown(ChatSessionStatus.Stopped);
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
		// Session-wide reap: every exec of this session (and its children) carries
		// HEZO_HEARTBEAT_RUN_ID=<sessionId>, and by teardown they have all been
		// aborted — nothing live shares the marker, so the broad kill is safe here
		// (unlike per-turn interrupts, which must use the per-exec scope id).
		// Bounded + best-effort: a stopped/gone container just fails the exec.
		await this.deps.docker
			.killProcessesByEnvMarker(live.containerId, 'HEZO_HEARTBEAT_RUN_ID', live.sessionId)
			.catch(() => undefined);
		await live.releaseSsh().catch(() => undefined);
		await live.releaseEgress().catch(() => undefined);
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
		completed: boolean;
	}): Promise<string> {
		const r = await this.deps.db.query<{ id: string }>(
			`INSERT INTO chat_messages
			   (conversation_id, role, channel, status, content, author_user_id, author_member_id, author_label, session_id, completed_at)
			 VALUES ($1, $2::chat_message_role, $3::chat_channel, $4::chat_message_status, $5, $6, $7, $8, $9, ${input.completed ? 'now()' : 'NULL'})
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
		});
	}

	private broadcastStart(
		conversationId: string,
		messageId: string,
		role: ChatMessageRole,
		channel: ChatChannel,
		content: string,
		attachments?: CommentAttachment[],
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
		});
	}

	private broadcastDelta(conversationId: string, messageId: string, text: string): void {
		this.broadcastChat(conversationId, {
			type: WsMessageType.ChatMessageDelta,
			conversationId,
			messageId,
			text,
		});
	}

	/**
	 * Fan a chat event out to the thread's own room (the open chatbox for that
	 * conversation) and the global signal room (the conversation list, for activity
	 * badges). The web client subscribes to the per-conversation room for the thread
	 * it's viewing and to the global room for the list.
	 */
	private broadcastChat(conversationId: string, message: WsChatServerMessage): void {
		this.deps.wsManager.broadcast(wsRoom.chatConversation(conversationId), { ...message });
		this.deps.wsManager.broadcast(wsRoom.chat(), { ...message });
	}
}

function roleLabel(role: string): string {
	if (role === ChatMessageRole.User) return 'Operator';
	if (role === ChatMessageRole.Assistant) return 'CEO';
	return 'System';
}

/**
 * One transcript line for a windowed message, appending a bare-reference list of
 * any attached files (`assets/<library-path>`) so the CEO can open them from the
 * HQ asset library. An attachment-only message (empty text) still gets its files.
 * A message carrying an external sender label (coworker/group turns) is labelled
 * with the sender's name ("Alice: …") instead of the generic role label.
 */
function chatTranscriptLine(msg: {
	role: string;
	content: string;
	authorLabel?: string | null;
	attachmentNames: string[];
}): string {
	const label = msg.authorLabel?.trim() ? msg.authorLabel.trim() : roleLabel(msg.role);
	const base = `${label}: ${msg.content}`;
	if (msg.attachmentNames.length === 0) return base;
	const refs = `[Attached files: ${msg.attachmentNames.map((n) => `assets/${n}`).join(', ')}]`;
	return msg.content ? `${base}\n${refs}` : `${base}${refs}`;
}
