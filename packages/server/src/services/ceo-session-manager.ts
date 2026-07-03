import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
	AgentEffort,
	type AgentRuntime,
	type AiProvider,
	CEO_AGENT_SLUG,
	CeoChannel,
	CeoMessageRole,
	CeoMessageStatus,
	CeoSessionStatus,
	CHAT_WINDOW_RETAIN_MESSAGES,
	DEFAULT_TEAM_ID,
	PROVIDER_RUNTIME_ADAPTERS,
	WsMessageType,
	wsRoom,
} from '@hezo/shared';
import { trackBackground } from '../lib/background';
import { getMaxChatHistorySize } from '../lib/system-meta';
import { logger } from '../logger';
import { signCeoSessionJwt } from '../middleware/auth';
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

const log = logger.child('ceo-session');

/** Container working directory for the (repo-free) chat session. */
const CHAT_WORKING_DIR = '/workspace';
/** How often to verify the live session's container is still healthy. */
const HEALTH_INTERVAL_MS = Number(process.env.HEZO_CEO_HEALTH_INTERVAL_MS ?? 10_000);

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

export interface CeoSessionDeps extends RunnerDeps {
	wsManager: WebSocketManager;
	containerLogStreamer?: ContainerLogStreamer;
}

interface LiveSession {
	sessionId: string;
	conversationId: string;
	ceoMemberId: string;
	projectId: string;
	containerId: string;
	runUser: ContainerRunUser;
	runtimeType: AgentRuntime;
	env: string[];
	execCmd: string[];
	promptHostPath: string;
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
 * Owns the single persistent CEO chat session. Unlike a one-shot task run, the
 * session keeps warm resources (egress proxy, ssh socket, MCP token, runtime
 * config) for the HQ container and runs each turn as a one-shot exec with the
 * conversation history composed into the prompt — uniform across every runtime,
 * no held-open process. A new message interrupts an in-flight reply and starts
 * a fresh turn whose prompt already includes the prior message.
 */
export class CeoSessionManager {
	private live: LiveSession | null = null;
	private current: CurrentTurn | null = null;
	private ensuring: Promise<LiveSession> | null = null;
	private healthTimer: ReturnType<typeof setInterval> | null = null;
	// Serializes `sendTurn` so concurrent sends (e.g. an impatient double-click while
	// the boot egress check is still warming up) can't each clear the gate together
	// and spawn their own session/turn. With sends serialized, the interrupt guard in
	// `sendTurn` correctly aborts the prior turn and only the latest one streams.
	private turnLock: Promise<unknown> = Promise.resolve();
	// An in-flight background compaction run (a headless exec that has the agent
	// fold the window into long-term memory). A new user turn preempts it.
	private compaction: Promise<void> | null = null;
	private compactionAbort: AbortController | null = null;

	constructor(private readonly deps: CeoSessionDeps) {}

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
			`UPDATE ceo_sessions SET status = $1, stopped_at = now()
			 WHERE status IN ($2, $3)`,
			[CeoSessionStatus.Crashed, CeoSessionStatus.Starting, CeoSessionStatus.Running],
		);
		// No CEO turn survives a process restart, so any message left in a non-terminal
		// state (streaming/pending) is orphaned — its run is gone. Empty ones are pure
		// "thinking" placeholders with nothing to show: delete them so they don't reload
		// as perpetual dots. Non-empty ones kept a partial reply: mark them interrupted.
		await this.deps.db.query(`DELETE FROM ceo_messages WHERE status IN ($1, $2) AND content = ''`, [
			CeoMessageStatus.Streaming,
			CeoMessageStatus.Pending,
		]);
		await this.deps.db.query(`UPDATE ceo_messages SET status = $1 WHERE status IN ($2, $3)`, [
			CeoMessageStatus.Interrupted,
			CeoMessageStatus.Streaming,
			CeoMessageStatus.Pending,
		]);
	}

	/**
	 * Send a user turn. Persists the user message, interrupts any in-flight reply,
	 * creates the streaming assistant row, and kicks the turn in the background.
	 * Returns the two message ids so the client can correlate streamed deltas.
	 */
	async sendTurn(input: {
		text: string;
		channel?: CeoChannel;
		authorUserId?: string | null;
	}): Promise<{ userMessageId: string; assistantMessageId: string }> {
		// Serialize turns: chain on the prior send so two overlapping requests run the
		// body sequentially (the second only after the first has set `this.current`),
		// letting the interrupt guard below abort the prior turn instead of racing it.
		const run = this.turnLock.then(
			() => this.runSendTurn(input),
			() => this.runSendTurn(input),
		);
		this.turnLock = run.catch(() => undefined);
		return run;
	}

	private async runSendTurn(input: {
		text: string;
		channel?: CeoChannel;
		authorUserId?: string | null;
	}): Promise<{ userMessageId: string; assistantMessageId: string }> {
		const session = await this.ensureSession();
		const channel = input.channel ?? CeoChannel.Web;

		// A user turn preempts any in-flight background compaction so the shared
		// prompt file and container exec are free, and so the new message is part
		// of the window the next compaction summarizes.
		if (this.compactionAbort) {
			this.compactionAbort.abort('interrupted');
			await this.compaction?.catch(() => undefined);
		}

		// Interrupt an in-flight reply: abort it and wait for it to finalize
		// (the run loop persists the partial as `interrupted`) so the next turn's
		// prompt includes it.
		if (this.current) {
			this.current.abort.abort('interrupted');
			await this.current.promise.catch(() => undefined);
		}

		const userMessageId = await this.insertMessage({
			conversationId: session.conversationId,
			role: CeoMessageRole.User,
			channel,
			status: CeoMessageStatus.Complete,
			content: input.text,
			authorUserId: input.authorUserId ?? null,
			completed: true,
		});
		this.broadcastStart(userMessageId, CeoMessageRole.User, channel, input.text);

		const assistantMessageId = await this.insertMessage({
			conversationId: session.conversationId,
			role: CeoMessageRole.Assistant,
			channel: CeoChannel.Web,
			status: CeoMessageStatus.Streaming,
			content: '',
			sessionId: session.sessionId,
			completed: false,
		});
		this.broadcastStart(assistantMessageId, CeoMessageRole.Assistant, CeoChannel.Web, '');

		const abort = new AbortController();
		const promise = this.runTurn(session, assistantMessageId, abort);
		this.current = { assistantMessageId, abort, promise };
		// After the reply settles, compact the window if it has grown past the cap.
		trackBackground(promise.then(() => this.maybeCompact()));

		return { userMessageId, assistantMessageId };
	}

	/** Tear the live session down; the next turn re-allocates a fresh one. */
	async restart(): Promise<void> {
		if (this.current) {
			this.current.abort.abort('restart');
			await this.current.promise.catch(() => undefined);
		}
		await this.teardown(CeoSessionStatus.Stopped);
	}

	/** Resolve the single global conversation row, creating it on first use. */
	async getConversationId(): Promise<string> {
		const ceoMemberId = await this.resolveCeoMemberId();
		return this.ensureConversation(ceoMemberId);
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

		const conversationId = await this.ensureConversation(ceoMemberId);

		// Reclaim any DB rows left live by a crash without an in-memory session, so
		// the singleton insert below doesn't collide.
		await db.query(
			`UPDATE ceo_sessions SET status = $1, stopped_at = now()
			 WHERE member_id = $2 AND status IN ($3, $4)`,
			[CeoSessionStatus.Crashed, ceoMemberId, CeoSessionStatus.Starting, CeoSessionStatus.Running],
		);

		const inserted = await db.query<{ id: string }>(
			`INSERT INTO ceo_sessions (member_id, team_id, project_id, container_id, runtime_type, status)
			 VALUES ($1, $2, $3, $4, $5::agent_runtime, $6)
			 RETURNING id`,
			[
				ceoMemberId,
				DEFAULT_TEAM_ID,
				project.id,
				containerId,
				runtimeType,
				CeoSessionStatus.Starting,
			],
		);
		const sessionId = inserted.rows[0].id;

		let releaseSsh = async (): Promise<void> => undefined;
		let releaseEgress = async (): Promise<void> => undefined;
		try {
			const label = `ceo/chat`;

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
				};
				releaseEgress = () => egressProxy.releaseRunProxy(sessionId);
			}

			const agentJwt = await signCeoSessionJwt(
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

			await db.query(`UPDATE ceo_sessions SET status = $1 WHERE id = $2`, [
				CeoSessionStatus.Running,
				sessionId,
			]);

			this.live = {
				sessionId,
				conversationId,
				ceoMemberId,
				projectId: project.id,
				containerId,
				runUser,
				runtimeType,
				env: invocation.env,
				execCmd: invocation.execCmd,
				promptHostPath: getHostPromptPath(
					this.deps.dataDir,
					DEFAULT_TEAM_ID,
					project.id,
					sessionId,
				),
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
					`UPDATE ceo_sessions SET status = $1, error = $2, stopped_at = now() WHERE id = $3`,
					[CeoSessionStatus.Crashed, (err as Error).message, sessionId],
				)
				.catch(() => undefined);
			throw err;
		}
	}

	private async runTurn(
		session: LiveSession,
		assistantMessageId: string,
		abort: AbortController,
	): Promise<void> {
		const accumulated = { text: '' };
		let finalized = false;
		const finalize = async (
			status: CeoMessageStatus,
			usage: AgentRunUsage | null,
			error?: string,
		) => {
			if (finalized) return;
			finalized = true;
			await this.finalizeMessage(assistantMessageId, status, accumulated.text, usage, error);
		};

		try {
			const prompt = await this.composePrompt(session);
			mkdirSync(dirname(session.promptHostPath), { recursive: true });
			writeFileSync(session.promptHostPath, prompt);

			const pricing = this.deps.pricing;
			const parser = createAgentChatParser(
				session.runtimeType,
				pricing ? (model, tokens) => pricing.costCents(model, tokens) : undefined,
			);
			const handle = (events: ReturnType<AgentChatParser['onStdout']>) => {
				for (const ev of events) {
					if (ev.text) {
						accumulated.text += ev.text;
						this.broadcastDelta(assistantMessageId, ev.text);
					}
				}
			};

			const execId = await this.deps.docker.execCreate(session.containerId, {
				Cmd: session.execCmd,
				Env: session.env,
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
			await finalize(CeoMessageStatus.Complete, parser.getUsage());
		} catch (err) {
			if (abort.signal.aborted) {
				await finalize(CeoMessageStatus.Interrupted, null);
			} else {
				log.error('CEO chat turn failed', err);
				await finalize(CeoMessageStatus.Failed, null, (err as Error).message);
			}
		} finally {
			rmSync(session.promptHostPath, { force: true });
			if (this.current?.assistantMessageId === assistantMessageId) this.current = null;
		}
	}

	private async composePrompt(session: LiveSession): Promise<string> {
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

		const memory = await getChatMemory(this.deps.db, session.ceoMemberId);

		// The full active (non-compacted) window IS the short-term memory — its size
		// is bounded by compaction, so there's no per-turn message limit here.
		const window = await loadActiveWindow(this.deps.db, session.conversationId);
		const transcript = window.map((r) => `${roleLabel(r.role)}: ${r.content}`).join('\n\n');

		return [
			resolved,
			session.promptDirective ?? '',
			CHAT_GUIDE,
			formatLongTermMemoryBlock(memory?.content ?? ''),
			'## Conversation so far',
			transcript,
			'Reply to the latest operator message as the CEO.',
		]
			.filter((s) => s.trim() !== '')
			.join('\n\n');
	}

	/**
	 * Compact the active window if it has grown past the byte cap. Runs in the
	 * background after a reply settles; skipped when a newer turn is already in
	 * flight (it will retry after that turn) or when a compaction is already
	 * running. The agent does the summarization — this just orchestrates.
	 */
	private async maybeCompact(): Promise<void> {
		const session = this.live;
		if (!session) return;
		if (this.current || this.compaction) return;
		const abort = new AbortController();
		this.compactionAbort = abort;
		const run = this.runCompaction(session, abort);
		this.compaction = run;
		try {
			await run;
		} catch (e) {
			log.error('CEO chat compaction failed', e);
		} finally {
			if (this.compactionAbort === abort) this.compactionAbort = null;
			if (this.compaction === run) this.compaction = null;
		}
	}

	/**
	 * Headless compaction run: hand the agent the whole active window and have it
	 * fold the durable points into long-term memory via `update_chat_memory`, then
	 * evict all but the latest few messages. No `ceo_message`, no broadcast — the
	 * operator sees nothing. Eviction is gated on the agent actually advancing its
	 * memory this run, so a no-op (or aborted) run loses nothing.
	 */
	private async runCompaction(session: LiveSession, abort: AbortController): Promise<void> {
		const window = await loadActiveWindow(this.deps.db, session.conversationId);
		const maxBytes = await getMaxChatHistorySize(this.deps.db);
		const flush = selectFlush(
			window.map((m) => ({
				id: m.id,
				bytes: Buffer.byteLength(m.content, 'utf8'),
				line: `${roleLabel(m.role)}: ${m.content}`,
			})),
			maxBytes,
			CHAT_WINDOW_RETAIN_MESSAGES,
		);
		if (!flush.overCap || flush.evictIds.length === 0) return;

		const memory = await getChatMemory(this.deps.db, session.ceoMemberId);
		const before = memory?.updated_at ?? null;
		const prompt = buildCompactionPrompt(memory?.content ?? '', flush.windowTranscript);
		mkdirSync(dirname(session.promptHostPath), { recursive: true });
		writeFileSync(session.promptHostPath, prompt);
		try {
			const execId = await this.deps.docker.execCreate(session.containerId, {
				Cmd: session.execCmd,
				Env: session.env,
				WorkingDir: CHAT_WORKING_DIR,
				User: session.runUser.name,
				AttachStdout: true,
				AttachStderr: true,
			});
			// Drain output; the reply text is irrelevant — the memory write is the
			// real product, landed via the update_chat_memory MCP tool.
			await this.deps.docker.execStart(execId, { signal: abort.signal, onChunk: () => undefined });
		} catch (e) {
			// A new user turn preempts compaction (shared prompt file) — that's a
			// clean stop, not a failure; nothing is evicted and it retries later.
			if (abort.signal.aborted) return;
			throw e;
		} finally {
			rmSync(session.promptHostPath, { force: true });
		}
		if (abort.signal.aborted) return;

		// Gate eviction on the agent having written memory this run (any
		// update_chat_memory call bumps updated_at). If it didn't, leave the window
		// intact — the next reply re-triggers compaction.
		const after = await getChatMemory(this.deps.db, session.ceoMemberId);
		const advanced = after !== null && (before === null || after.updated_at !== before);
		if (advanced) {
			await markCompacted(this.deps.db, flush.evictIds);
			// Tell every mirrored chatbox to drop the evicted messages and show the
			// "chat compacted" marker — the conversation refetch returns just the tail.
			this.deps.wsManager.broadcast(wsRoom.ceo(), {
				type: WsMessageType.CeoCompacted,
				conversationId: session.conversationId,
			});
		} else {
			log.warn('CEO compaction did not update long-term memory; window left intact', {
				session: session.sessionId,
			});
		}
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
			await this.teardown(CeoSessionStatus.Stopped);
		}
	}

	private async shutdown(): Promise<void> {
		if (this.current) {
			this.current.abort.abort('shutdown');
			await this.current.promise.catch(() => undefined);
		}
		await this.teardown(CeoSessionStatus.Stopped);
	}

	private async teardown(status: CeoSessionStatus): Promise<void> {
		const live = this.live;
		if (!live) return;
		this.live = null;
		await live.releaseSsh().catch(() => undefined);
		await live.releaseEgress().catch(() => undefined);
		await this.deps.db
			.query(`UPDATE ceo_sessions SET status = $1, stopped_at = now() WHERE id = $2`, [
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

	private async ensureConversation(ceoMemberId: string): Promise<string> {
		const existing = await this.deps.db.query<{ id: string }>(
			`SELECT id FROM ceo_conversations WHERE member_id = $1 ORDER BY created_at ASC LIMIT 1`,
			[ceoMemberId],
		);
		if (existing.rows[0]) return existing.rows[0].id;
		const created = await this.deps.db.query<{ id: string }>(
			`INSERT INTO ceo_conversations (member_id, team_id) VALUES ($1, $2) RETURNING id`,
			[ceoMemberId, DEFAULT_TEAM_ID],
		);
		return created.rows[0].id;
	}

	private async insertMessage(input: {
		conversationId: string;
		role: CeoMessageRole;
		channel: CeoChannel;
		status: CeoMessageStatus;
		content: string;
		authorUserId?: string | null;
		sessionId?: string | null;
		completed: boolean;
	}): Promise<string> {
		const r = await this.deps.db.query<{ id: string }>(
			`INSERT INTO ceo_messages
			   (conversation_id, role, channel, status, content, author_user_id, session_id, completed_at)
			 VALUES ($1, $2::ceo_message_role, $3::ceo_channel, $4::ceo_message_status, $5, $6, $7, ${input.completed ? 'now()' : 'NULL'})
			 RETURNING id`,
			[
				input.conversationId,
				input.role,
				input.channel,
				input.status,
				input.content,
				input.authorUserId ?? null,
				input.sessionId ?? null,
			],
		);
		return r.rows[0].id;
	}

	private async finalizeMessage(
		messageId: string,
		status: CeoMessageStatus,
		content: string,
		usage: AgentRunUsage | null,
		error?: string,
	): Promise<void> {
		await this.deps.db.query(
			`UPDATE ceo_messages
			 SET status = $2::ceo_message_status, content = $3, input_tokens = $4, output_tokens = $5,
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
				.query(`UPDATE ceo_sessions SET last_activity_at = now() WHERE id = $1`, [
					this.live.sessionId,
				])
				.catch(() => undefined);
		}
		this.deps.wsManager.broadcast(wsRoom.ceo(), {
			type: WsMessageType.CeoMessageComplete,
			messageId,
			status,
			content,
			inputTokens: usage?.inputTokens ?? 0,
			outputTokens: usage?.outputTokens ?? 0,
			costCents: usage?.costCents ?? 0,
		});
	}

	private broadcastStart(
		messageId: string,
		role: CeoMessageRole,
		channel: CeoChannel,
		content: string,
	): void {
		this.deps.wsManager.broadcast(wsRoom.ceo(), {
			type: WsMessageType.CeoMessageStart,
			messageId,
			role,
			channel,
			content,
			createdAt: new Date().toISOString(),
		});
	}

	private broadcastDelta(messageId: string, text: string): void {
		this.deps.wsManager.broadcast(wsRoom.ceo(), {
			type: WsMessageType.CeoMessageDelta,
			messageId,
			text,
		});
	}
}

function roleLabel(role: string): string {
	if (role === CeoMessageRole.User) return 'Operator';
	if (role === CeoMessageRole.Assistant) return 'CEO';
	return 'System';
}
