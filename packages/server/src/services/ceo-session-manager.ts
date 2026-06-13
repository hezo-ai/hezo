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
	CHAT_MEMORY_SLUG,
	DEFAULT_TEAM_ID,
	DocumentType,
	PROVIDER_RUNTIME_ADAPTERS,
	WsMessageType,
	wsRoom,
} from '@hezo/shared';
import { trackBackground } from '../lib/background';
import { getChatHistoryLimit } from '../lib/system-meta';
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
import { getAgentSystemPrompt, getDocument } from './documents';
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

## Chatbox memory

Your context carries a **Chatbox memory** block (below the guide, above the conversation). It is the persisted contents of \`chat-memory.md\` in the hq project, injected in full on every turn, so anything recorded there survives once older messages scroll out of the conversation window.

Use it for **durable, standing knowledge only**:

- **Record:** operator preferences and guidelines (how they like things done, tone, defaults, recurring decisions), and **anything the operator explicitly asks you to remember** — record that regardless of what it is.
- **Do NOT record:** live data you can already fetch each turn — project/ticket/comment contents or status, rosters, counts, or any metadata about them. That is rebuilt into your context from the live database every turn; copying it into memory only goes stale. The roster and the tools are the source of truth for state, not this memory.

When something belongs in memory, update it by **rewriting the whole document via \`write_project_doc\` (project: hq, filename: chat-memory.md)** — read the current memory block, merge the new fact in, and write the full result back. Do not blindly append; keep it short, curated, and free of stale entries. There is no separate "remember" tool — \`write_project_doc\` is how you maintain it.`;

/**
 * Render the persistent chatbox-memory data block injected into every turn. The
 * curation rules live in CHAT_GUIDE; this is just the current contents (or a
 * placeholder when empty so the agent knows the facility exists).
 */
export function formatChatMemoryBlock(content: string): string {
	const trimmed = content.trim();
	const body = trimmed === '' ? '_(nothing recorded yet)_' : trimmed;
	return `## Chatbox memory\n\nPersisted across the conversation (from ${CHAT_MEMORY_SLUG} in hq). Maintain it with write_project_doc — see the guidance above.\n\n${body}`;
}

export interface CeoSessionDeps extends RunnerDeps {
	wsManager: WebSocketManager;
}

interface LiveSession {
	sessionId: string;
	conversationId: string;
	ceoMemberId: string;
	projectId: string;
	containerId: string;
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

interface CeoMessageRow {
	id: string;
	role: string;
	channel: string;
	status: string;
	content: string;
	created_at: string;
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
		const session = await this.ensureSession();
		const channel = input.channel ?? CeoChannel.Web;

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
		trackBackground(promise);

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
		if (project.container_status !== 'running' || !project.container_id) {
			throw new Error('HQ container is not running');
		}

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
				project.container_id,
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
					socketUser: 'node',
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
				containerId: project.container_id,
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
			const prompt = await this.composePrompt(session, assistantMessageId);
			mkdirSync(dirname(session.promptHostPath), { recursive: true });
			writeFileSync(session.promptHostPath, prompt);

			const parser = createAgentChatParser(session.runtimeType);
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
				User: 'node',
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

	private async composePrompt(session: LiveSession, excludeMessageId: string): Promise<string> {
		const stored = await getAgentSystemPrompt(this.deps.db, DEFAULT_TEAM_ID, session.ceoMemberId);
		const resolved = await resolveSystemPrompt(this.deps.db, stored, {
			teamId: DEFAULT_TEAM_ID,
			projectId: session.projectId,
			agentId: session.ceoMemberId,
			dataDir: this.deps.dataDir,
			mode: 'runtime',
			crossTeam: true,
		});

		const memoryDoc = await getDocument(this.deps.db, {
			type: DocumentType.ProjectDoc,
			teamId: DEFAULT_TEAM_ID,
			projectId: session.projectId,
			slug: CHAT_MEMORY_SLUG,
		});

		const historyLimit = await getChatHistoryLimit(this.deps.db);
		const history = await this.deps.db.query<CeoMessageRow>(
			`SELECT id, role, channel, status, content, created_at FROM ceo_messages
			 WHERE conversation_id = $1 AND id != $2
			 ORDER BY created_at DESC LIMIT $3`,
			[session.conversationId, excludeMessageId, historyLimit],
		);
		const transcript = history.rows
			.reverse()
			.filter((r) => r.content.trim() !== '')
			.map((r) => `${roleLabel(r.role)}: ${r.content}`)
			.join('\n\n');

		return [
			resolved,
			session.promptDirective ?? '',
			CHAT_GUIDE,
			formatChatMemoryBlock(memoryDoc?.content ?? ''),
			'## Conversation so far',
			transcript,
			'Reply to the latest operator message as the CEO.',
		]
			.filter((s) => s.trim() !== '')
			.join('\n\n');
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
