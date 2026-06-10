import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import {
	AgentRuntime,
	AiAuthMethod,
	type AiProvider,
	CLAUDE_CODE_QUIET_ENV,
	CommentContentType,
	ContainerStatus,
	claudeCodeModelArg,
	HeartbeatRunStatus,
	PROVIDER_RUNTIME_ADAPTERS,
	providerDirectUpstreamHosts,
	RUNTIME_AUTO_APPROVE_ARGS,
	RUNTIME_COMMANDS,
	RUNTIME_DISALLOWED_TOOLS_ARGS,
	RUNTIME_HEADLESS_PREFIX_ARGS,
	RUNTIME_HEADLESS_SUFFIX_ARGS,
	RUNTIME_STREAM_ARGS,
	TaskStatus,
	TERMINAL_TASK_STATUSES,
	WakeupSource,
	WsMessageType,
	wsRoom,
} from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import type { DomainEventBus } from '../events/bus';
import { broadcastRowChange } from '../lib/broadcast';
import { withTransaction } from '../lib/sql';
import { signAgentJwt } from '../middleware/auth';
import { type AgentRunUsage, createAgentStreamParser } from './agent-stream-parser';
import {
	type AiProviderCredential,
	getProviderCredentialAndModel,
	updateAiProviderCredential,
} from './ai-provider-keys';
import { loadSkillFilesForTeam } from './connectors/lifecycle';
import type { DockerClient, ExecLogChunk } from './docker';
import { getAgentSystemPrompt } from './documents';
import { applyEffortToRuntime, type EffortRuntimeApplication, resolveEffort } from './effort';
import type { EgressProxy } from './egress';
import { ensureGithubKnownHosts, ensureTaskWorktree, fetchRepo } from './git';
import { buildGitIdentityEnv } from './git-identity';
import type { LogStreamBroker } from './log-stream-broker';
import { loadMcpConnectionDescriptors } from './mcp-connections';
import { MCP_ADAPTERS, type McpDescriptor, validateInjection } from './mcp-injectors';
import { loadReactionsForTask, type ReactionGroup } from './reactions';
import { ensureProjectRepos } from './repo-sync';
import {
	buildSubscriptionMount as buildSubscriptionMountImpl,
	ensureRuntimeHomeDir,
	getContainerSubscriptionRoot as getContainerSubscriptionRootImpl,
	getHostSubscriptionRoot as getHostSubscriptionRootImpl,
	type RuntimeHomeMount,
	SUBSCRIPTION_LAYOUTS,
	type SubscriptionMount as SubscriptionMountImpl,
} from './runtime-home';
import { resolveRuntimeForTask } from './runtime-resolver';
import { type BridgeRunnerArgs, buildBridgeRunnerArgv, type SshAgentServer } from './ssh-agent';
import { withHostAgentSocket } from './ssh-agent/host';
import { recordStatusChange } from './task-events';
import { resolveSystemPrompt } from './template-resolver';
import { getRunSocketPath, getWorkspacePath, getWorktreesPath } from './workspace';
import type { WebSocketManager } from './ws';

export interface AgentInfo {
	id: string;
	title: string;
	slug?: string | null;
	team_id: string;
	default_effort?: string | null;
	model_override_provider?: AiProvider | null;
	model_override_model?: string | null;
}

export interface TaskInfo {
	id: string;
	identifier: string;
	title: string;
	description: string;
	status: string;
	priority: string;
	project_id: string;
	rules: string | null;
	progress_summary: string | null;
	assignee_id?: string | null;
	runtime_type?: AgentRuntime | null;
	parent_task_id?: string | null;
	created_by_run_id?: string | null;
}

interface ProjectInfo {
	id: string;
	slug: string;
	team_id: string;
	team_slug: string;
	container_id: string;
	container_status: string;
	designated_repo_id: string | null;
	is_internal: boolean;
}

export interface RunResult {
	success: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	heartbeatRunId?: string;
}

export interface RunnerDeps {
	db: PGlite;
	docker: DockerClient;
	masterKeyManager: MasterKeyManager;
	serverPort: number;
	dataDir: string;
	wsManager?: WebSocketManager;
	events?: DomainEventBus;
	logs: LogStreamBroker;
	sshAgentServer?: SshAgentServer;
	egressProxy?: EgressProxy | null;
	egressCAPath?: string | null;
}

interface RepoRow {
	id: string;
	short_name: string;
	repo_identifier: string;
}

/**
 * Build the env-var entries for a given provider/auth method. Composed from the
 * provider's adapter: any static entries (base URL, model defaults) followed by
 * the credential carried in the auth-method-specific env var. Agents that read
 * a different var won't see the credential.
 *
 * Returns only the static entries when the auth method is subscription-based,
 * since the credential is delivered via a file mount instead — see
 * {@link buildSubscriptionMount}.
 */
export function buildProviderEnv(provider: AiProvider, credential: AiProviderCredential): string[] {
	const adapter = PROVIDER_RUNTIME_ADAPTERS[provider];
	const out: string[] = [];
	if (adapter.runtime === AgentRuntime.ClaudeCode) {
		for (const [key, value] of Object.entries(CLAUDE_CODE_QUIET_ENV)) {
			out.push(`${key}=${value}`);
		}
	}
	if (adapter.staticEnv) {
		for (const [key, value] of Object.entries(adapter.staticEnv)) {
			out.push(`${key}=${value}`);
		}
	}
	const varName = adapter.credentialEnvByAuthMethod[credential.authMethod];
	if (varName) out.push(`${varName}=${credential.value}`);
	return out;
}

// SUBSCRIPTION_LAYOUTS, SubscriptionMount, and the home-dir helpers live in
// runtime-home.ts so per-runtime config conventions sit in one place. These
// re-exports keep the public import surface stable for callers and tests.
export type SubscriptionMount = SubscriptionMountImpl;
export const buildSubscriptionMount = buildSubscriptionMountImpl;
export const getContainerSubscriptionRoot = getContainerSubscriptionRootImpl;
export const getHostSubscriptionRoot = getHostSubscriptionRootImpl;

/**
 * Some subscription credentials carry a single-use refresh token (Codex), so
 * two parallel runs against the same credential would mutually invalidate
 * each other. This in-process mutex serialises runs on the credential row's
 * id when the provider's refresh token rotates.
 */
const credentialLocks = new Map<string, Promise<void>>();

export async function acquireCredentialLock(configId: string): Promise<() => void> {
	const previous = credentialLocks.get(configId) ?? Promise.resolve();
	let release!: () => void;
	const next = new Promise<void>((resolve) => {
		release = resolve;
	});
	const chain = previous.then(() => next);
	credentialLocks.set(configId, chain);
	await previous;
	return () => {
		release();
		if (credentialLocks.get(configId) === chain) credentialLocks.delete(configId);
	};
}

export interface RunContext {
	cmd: string[];
	execCmd: string[];
	env: string[];
	taskPrompt: string;
	promptFilePath: string;
	effort: string;
	effortApplication: EffortRuntimeApplication;
	agentJwt: string;
	subscriptionMount: SubscriptionMount | null;
	/**
	 * Per-run runtime config dir. Reuses the subscription mount when present;
	 * otherwise a freshly created dir for runtimes that need one (Codex, Gemini)
	 * even when authenticating with an API key. Null when the runtime takes its
	 * MCP config via CLI flags (Claude Code).
	 */
	homeMount: RuntimeHomeMount | null;
}

const CONTAINER_PROMPT_DIR = '/workspace/.hezo/prompts';

export function getContainerPromptPath(heartbeatRunId: string): string {
	return `${CONTAINER_PROMPT_DIR}/${heartbeatRunId}.txt`;
}

export function getHostPromptPath(
	dataDir: string,
	teamId: string,
	projectId: string,
	heartbeatRunId: string,
): string {
	return join(
		getWorkspacePath(dataDir, teamId, projectId),
		'.hezo',
		'prompts',
		`${heartbeatRunId}.txt`,
	);
}

function wrapExecCmd(cmd: string[], bridge: BridgeRunnerArgs | null): string[] {
	if (bridge) {
		return [...buildBridgeRunnerArgv(bridge), ...cmd];
	}
	return ['sh', '-c', 'exec "$@" < "$HEZO_PROMPT_FILE"', 'sh', ...cmd];
}

interface EgressEnvDescriptor {
	host: string;
	port: number;
	containerCAPath: string;
}

async function buildRunContext(
	deps: RunnerDeps,
	agent: AgentInfo,
	task: TaskInfo,
	project: ProjectInfo,
	wakeupPayload: Record<string, unknown> | undefined,
	credential: AiProviderCredential,
	provider: AiProvider,
	runtimeType: AgentRuntime,
	heartbeatRunId: string,
	modelOverride: string | null,
	sshSocketContainerPath: string | null,
	bridge: BridgeRunnerArgs | null,
	egress: EgressEnvDescriptor | null,
): Promise<RunContext> {
	// The run is scoped to the project's team (the "run team"). For normal agents
	// this equals the agent's home team; for instance agents (CEO/Coach) that
	// execute inside another team's project it is that project's team, so the run's
	// token, env, skills and tool access all operate on the project being worked.
	// The agent's own system prompt still belongs to its home team.
	const runTeamId = project.team_id;
	// The agent's stored system prompt lives under its home team (HQ for the
	// instance CEO/Coach), which can differ from the run team when an instance
	// agent works inside another team's project.
	const homeTeam = await deps.db.query<{ team_id: string }>(
		'SELECT team_id FROM members WHERE id = $1',
		[agent.id],
	);
	const homeTeamId = homeTeam.rows[0]?.team_id ?? runTeamId;
	const storedPrompt = await getAgentSystemPrompt(deps.db, homeTeamId, agent.id);
	let resolvedPrompt = await resolveSystemPrompt(deps.db, storedPrompt, {
		teamId: runTeamId,
		projectId: project.id,
		taskId: task.id,
		agentId: agent.id,
		dataDir: deps.dataDir,
	});

	if (resolvedPrompt.includes('{{requester_context}}')) {
		const creator = await deps.db.query<{ display_name: string; member_type: string }>(
			`SELECT m.display_name, m.member_type FROM tasks i
			 JOIN members m ON m.id = i.created_by_member_id
			 WHERE i.id = $1`,
			[task.id],
		);
		const row = creator.rows[0];
		const requesterText = row
			? `This task was created by ${row.display_name} (${row.member_type}).`
			: '';
		resolvedPrompt = resolvedPrompt.replace(/\{\{requester_context\}\}/g, requesterText);
	}

	const agentJwt = await signAgentJwt(
		deps.masterKeyManager,
		agent.id,
		runTeamId,
		heartbeatRunId,
		project.id,
		project.is_internal,
	);
	const effort = resolveEffort(wakeupPayload?.effort, agent.default_effort, agent.slug);
	const effortApplication = applyEffortToRuntime(runtimeType, effort);

	const isCoachReview = wakeupPayload?.trigger === 'task_done';
	const mentionContext =
		wakeupPayload?.source === WakeupSource.Mention
			? await loadMentionContext(deps.db, agent.id, runTeamId, wakeupPayload)
			: null;
	const replyContext =
		wakeupPayload?.source === WakeupSource.Reply
			? await loadReplyContext(deps.db, wakeupPayload)
			: null;
	const spawnedFrom = await loadSpawnedFromTask(deps.db, task);
	const basePrompt = isCoachReview
		? await buildCoachReviewPrompt(deps.db, resolvedPrompt, task, runTeamId)
		: buildTaskPrompt(resolvedPrompt, task, wakeupPayload, {
				mentionContext,
				replyContext,
				spawnedFrom,
			});
	const taskPrompt = effortApplication.promptDirective
		? `${basePrompt}\n\n${effortApplication.promptDirective}`
		: basePrompt;

	const promptFilePath = getContainerPromptPath(heartbeatRunId);

	const subscriptionMount = buildSubscriptionMount(
		deps.dataDir,
		project.team_id,
		project.id,
		heartbeatRunId,
		provider,
		credential,
	);

	const adapter = MCP_ADAPTERS[runtimeType];
	const homeMount: RuntimeHomeMount | null = adapter.capabilities.requiresHomeDir
		? ensureRuntimeHomeDir(
				provider,
				deps.dataDir,
				project.team_id,
				project.id,
				heartbeatRunId,
				subscriptionMount,
			)
		: null;

	const mcpDescriptors: McpDescriptor[] = [
		{
			kind: 'http',
			name: 'hezo',
			url: `http://host.docker.internal:${deps.serverPort}/mcp`,
			bearerToken: agentJwt,
		},
		...(await loadMcpConnectionDescriptors(deps.db, deps.masterKeyManager)),
	];

	const skillFiles = await loadSkillFilesForTeam(deps.db, runTeamId);
	const mcpInjection = adapter.build(mcpDescriptors, {
		hostHomeDir: homeMount?.hostDir ?? null,
		containerHomeDir: homeMount?.containerDir ?? null,
		provider,
		skillFiles,
	});
	validateInjection(adapter, mcpInjection);

	for (const file of mcpInjection.files) {
		mkdirSync(dirname(file.hostPath), { recursive: true, mode: 0o700 });
		writeFileSync(file.hostPath, file.contents, { mode: file.mode });
	}

	const env: string[] = [
		`HEZO_API_URL=http://host.docker.internal:${deps.serverPort}/agent-api`,
		`HEZO_AGENT_TOKEN=${agentJwt}`,
		`HEZO_AGENT_ID=${agent.id}`,
		`HEZO_TEAM_ID=${runTeamId}`,
		`HEZO_TASK_ID=${task.id}`,
		`HEZO_TASK_IDENTIFIER=${task.identifier}`,
		`HEZO_AGENT_EFFORT=${effort}`,
		`HEZO_PROMPT_FILE=${promptFilePath}`,
		...effortApplication.extraEnv,
		...buildProviderEnv(provider, credential),
		// Subscription mount sets the runtime HOME env var when present; otherwise
		// fall through to the home-mount entry so the runtime CLI finds its
		// per-run config dir even without a subscription credential.
		...(subscriptionMount?.envEntries ?? (homeMount ? [homeMount.envEntry] : [])),
		...mcpInjection.envEntries,
	];
	if (sshSocketContainerPath) {
		env.push(`SSH_AUTH_SOCK=${sshSocketContainerPath}`);
	}
	// Configure git author/committer identity and SSH commit signing from the
	// team's connected GitHub account + Ed25519 key, so in-container commits
	// don't fail for lack of an author and land Verified via the agent socket.
	env.push(...(await buildGitIdentityEnv(deps.db, deps.masterKeyManager, runTeamId)));
	if (egress) {
		const proxyUrl = `http://${egress.host}:${egress.port}`;
		const noProxyHosts = [
			egress.host,
			'localhost',
			'127.0.0.1',
			...providerDirectUpstreamHosts(provider),
		];
		const noProxy = [...new Set(noProxyHosts)].join(',');
		env.push(
			`HTTP_PROXY=${proxyUrl}`,
			`http_proxy=${proxyUrl}`,
			`HTTPS_PROXY=${proxyUrl}`,
			`https_proxy=${proxyUrl}`,
			`NO_PROXY=${noProxy}`,
			`no_proxy=${noProxy}`,
			// Rely on update-ca-certificates for curl/git; do not set SSL_CERT_FILE to
			// the egress CA alone — that replaces the system trust store and breaks TLS.
			`NODE_EXTRA_CA_CERTS=${egress.containerCAPath}`,
			`CURL_CA_BUNDLE=${egress.containerCAPath}`,
			`GIT_SSL_CAINFO=${egress.containerCAPath}`,
		);
	}

	const cliCommand = RUNTIME_COMMANDS[runtimeType];
	const cliModel =
		modelOverride && runtimeType === AgentRuntime.ClaudeCode
			? claudeCodeModelArg(provider, modelOverride)
			: modelOverride;
	const modelArgs = cliModel ? ['--model', cliModel] : [];

	const cmd = [
		cliCommand,
		...RUNTIME_HEADLESS_PREFIX_ARGS[runtimeType],
		...mcpInjection.cliArgs,
		...RUNTIME_STREAM_ARGS[runtimeType],
		...RUNTIME_AUTO_APPROVE_ARGS[runtimeType],
		...RUNTIME_DISALLOWED_TOOLS_ARGS[runtimeType],
		...effortApplication.extraArgs,
		...modelArgs,
		...RUNTIME_HEADLESS_SUFFIX_ARGS[runtimeType],
	];

	const execCmd = wrapExecCmd(cmd, bridge);

	return {
		cmd,
		execCmd,
		env,
		taskPrompt,
		promptFilePath,
		effort,
		effortApplication,
		agentJwt,
		subscriptionMount,
		homeMount,
	};
}

export type ContainerExitAbortReason = 'container_error' | 'container_stopped';

function exitReasonFromSignal(signal?: AbortSignal): ContainerExitAbortReason | null {
	if (!signal) return null;
	const reason = signal.reason as unknown;
	if (reason === 'container_error' || reason === 'container_stopped') return reason;
	return null;
}

function extractTriggeredBy(payload: Record<string, unknown> | undefined): TriggeredBy | null {
	const raw = payload?.triggered_by;
	if (!raw || typeof raw !== 'object') return null;
	const obj = raw as Record<string, unknown>;
	const name = typeof obj.name === 'string' ? obj.name : null;
	if (!name) return null;
	const memberId = typeof obj.member_id === 'string' ? obj.member_id : null;
	return { member_id: memberId, name };
}

async function createSyntheticOnDemandWakeup(
	db: PGlite,
	memberId: string,
	teamId: string,
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, claimed_at)
		 VALUES ($1, $2, $3::wakeup_source, 'claimed'::wakeup_status, '{}'::jsonb, now())
		 RETURNING id`,
		[memberId, teamId, WakeupSource.OnDemand],
	);
	return r.rows[0].id;
}

export async function runAgent(
	deps: RunnerDeps,
	agent: AgentInfo,
	task: TaskInfo,
	project: ProjectInfo,
	wakeupPayload?: Record<string, unknown>,
	signal?: AbortSignal,
	onRunRegistered?: (heartbeatRunId: string) => void,
	wakeupId?: string,
): Promise<RunResult> {
	const startTime = Date.now();

	if (signal?.aborted) return abortedResult(startTime);

	// The run executes in the project's team (see buildRunContext); for instance
	// agents working another team's project this differs from agent.team_id.
	const runTeamId = project.team_id;
	const runBroadcast: HeartbeatRunBroadcast = {
		wsManager: deps.wsManager,
		events: deps.events,
		teamId: runTeamId,
		projectId: project.id,
		taskId: task.id,
		memberId: agent.id,
	};
	const effectiveWakeupId =
		wakeupId ?? (await createSyntheticOnDemandWakeup(deps.db, agent.id, runTeamId));
	const heartbeatRunId = await createHeartbeatRun(
		deps.db,
		agent,
		runTeamId,
		task,
		runBroadcast,
		effectiveWakeupId,
		extractTriggeredBy(wakeupPayload),
	);
	onRunRegistered?.(heartbeatRunId);
	await emitRunStarted(deps, heartbeatRunId, agent, task, project, effectiveWakeupId);
	const streamId = `run:${heartbeatRunId}`;

	deps.logs.begin({
		streamId,
		room: `project-runs:${project.id}`,
		buildMessage: (line) => ({
			type: WsMessageType.RunLog,
			projectId: project.id,
			runId: heartbeatRunId,
			taskId: task.id,
			stream: line.stream,
			text: line.text,
		}),
		buildSnapshot: (text) => ({
			type: WsMessageType.RunLog,
			projectId: project.id,
			runId: heartbeatRunId,
			taskId: task.id,
			stream: 'stdout',
			text,
			replace: true,
		}),
		onFlush: async (text) => {
			await deps.db.query('UPDATE heartbeat_runs SET log_text = $1 WHERE id = $2', [
				text,
				heartbeatRunId,
			]);
		},
	});

	const emit = (stream: 'stdout' | 'stderr', text: string) =>
		deps.logs.emit(streamId, stream, text);

	const finalizeFailure = async (message: string): Promise<RunResult> => {
		emit('stderr', `[runner] ${message}\n`);
		const durationMs = Date.now() - startTime;
		await deps.logs.end(streamId);
		await updateHeartbeatRun(
			deps.db,
			heartbeatRunId,
			{
				status: HeartbeatRunStatus.Failed,
				exitCode: -1,
				durationMs,
				error: message,
			},
			runBroadcast,
		);
		return {
			success: false,
			exitCode: -1,
			stdout: '',
			stderr: message,
			durationMs,
			heartbeatRunId,
		};
	};

	const finalizeAbort = async (): Promise<RunResult> => {
		const durationMs = Date.now() - startTime;
		await deps.logs.end(streamId);
		const exitReason = exitReasonFromSignal(signal);
		const status = exitReason ? HeartbeatRunStatus.Failed : HeartbeatRunStatus.Cancelled;
		await updateHeartbeatRun(
			deps.db,
			heartbeatRunId,
			{
				status,
				exitCode: -1,
				durationMs,
				error: exitReason ?? undefined,
			},
			runBroadcast,
		);
		return {
			success: false,
			exitCode: -1,
			stdout: '',
			stderr: exitReason ?? 'Aborted',
			durationMs,
			heartbeatRunId,
		};
	};

	if (!project.container_id || project.container_status !== ContainerStatus.Running) {
		return finalizeFailure(
			'Project container is not running. Start the container from the Project page and retry.',
		);
	}

	let provider: AiProvider;
	let runtimeType: AgentRuntime;
	if (agent.model_override_provider) {
		provider = agent.model_override_provider;
		runtimeType = PROVIDER_RUNTIME_ADAPTERS[provider].runtime;
	} else {
		const resolved = await resolveRuntimeForTask(deps.db, task.runtime_type ?? null);
		if (!resolved) {
			return finalizeFailure(
				'No AI provider credentials configured at the instance level. Add one in Settings > AI Providers.',
			);
		}
		runtimeType = resolved.runtime;
		provider = resolved.provider;
	}

	const credential = await getProviderCredentialAndModel(deps.db, deps.masterKeyManager, provider);
	if (!credential) {
		return finalizeFailure(
			`No ${provider} credential configured. Add one in Settings > AI Providers.`,
		);
	}

	const modelOverride = agent.model_override_model ?? credential.defaultModel ?? null;

	if (signal?.aborted) return finalizeAbort();

	const layout = SUBSCRIPTION_LAYOUTS[provider];
	let releaseCredentialLock: (() => void) | null = null;
	if (credential.authMethod === AiAuthMethod.Subscription && layout?.rotates) {
		// Records the true wait so the run comment reads honestly while blocked.
		await deps.db.query(
			`UPDATE heartbeat_runs SET queued_reason = $1
			 WHERE id = $2 AND status = $3::heartbeat_run_status`,
			['waiting for prior run on this credential', heartbeatRunId, HeartbeatRunStatus.Queued],
		);
		releaseCredentialLock = await acquireCredentialLock(credential.configId);
	}

	// Everything past the lock runs inside a try/finally so the credential lock is
	// always released — including when setup (sockets, proxy, context, worktrees,
	// file writes) throws before the exec block. Leaking it would queue every later
	// run on this credential forever. Release is idempotent, so the explicit cleanup
	// paths below don't double-free.
	try {
		await markHeartbeatRunRunning(deps.db, heartbeatRunId, runBroadcast);

		// Human-friendly label for run-scoped logs (egress proxy, ssh-agent),
		// since a run has no friendly identifier of its own.
		const runLabel = `${agent.slug}/${task.identifier}`;

		let sshSocketContainerPath: string | null = null;
		let sshSocketHostPath: string | null = null;
		let bridge: BridgeRunnerArgs | null = null;
		if (deps.sshAgentServer) {
			sshSocketHostPath = getRunSocketPath(deps.dataDir, heartbeatRunId);
			const allocated = await deps.sshAgentServer.allocateRunSocket(
				heartbeatRunId,
				{ teamId: agent.team_id, agentId: agent.id, label: runLabel },
				sshSocketHostPath,
			);
			sshSocketContainerPath = `/run/hezo/${heartbeatRunId}.sock`;
			bridge = {
				socketPath: sshSocketContainerPath,
				socketUser: 'node',
				tokenHex: allocated.tokenHex,
				hostName: 'host.docker.internal',
				hostPort: allocated.tcpHostPort,
			};
		}

		let egressEnv: EgressEnvDescriptor | null = null;
		let egressAllocated = false;
		if (deps.egressProxy && deps.egressCAPath) {
			// Egress proxy is mandatory: agents may have placeholder secrets in
			// their env. Failing fast prevents real secrets from leaking through
			// a fall-through path. If allocation fails, the run aborts.
			const allocated = await deps.egressProxy.allocateRunProxy(heartbeatRunId, {
				teamId: agent.team_id,
				agentId: agent.id,
				projectId: project.id,
				label: runLabel,
			});
			egressAllocated = true;
			egressEnv = {
				host: allocated.proxyHost,
				port: allocated.proxyPort,
				containerCAPath: '/usr/local/share/ca-certificates/hezo-egress.crt',
			};
		}

		const context = await buildRunContext(
			deps,
			agent,
			task,
			project,
			wakeupPayload,
			credential,
			provider,
			runtimeType,
			heartbeatRunId,
			modelOverride,
			sshSocketContainerPath,
			bridge,
			egressEnv,
		);

		if (signal?.aborted) {
			const dirToRemove = context.subscriptionMount?.hostDir ?? context.homeMount?.hostDir;
			if (dirToRemove) {
				rmSync(dirToRemove, { recursive: true, force: true });
			}
			if (deps.sshAgentServer) {
				await deps.sshAgentServer.releaseRunSocket(heartbeatRunId);
			}
			if (deps.egressProxy && egressAllocated) {
				await deps.egressProxy.releaseRunProxy(heartbeatRunId);
			}
			return finalizeAbort();
		}

		const prep = await prepareWorktrees(deps, project, task, emit, signal);

		const hostPromptPath = getHostPromptPath(
			deps.dataDir,
			project.team_id,
			project.id,
			heartbeatRunId,
		);
		mkdirSync(dirname(hostPromptPath), { recursive: true });
		writeFileSync(hostPromptPath, context.taskPrompt);

		const redactedCmd = context.cmd.map((arg) => arg.replace(/Bearer [^"\s]+/g, 'Bearer ***'));
		const invocationCommand = `$ ${redactedCmd.map(shellQuoteArg).join(' ')} < ${context.promptFilePath}`;

		await deps.db.query(
			`UPDATE heartbeat_runs SET invocation_command = $1, working_dir = $2 WHERE id = $3`,
			[invocationCommand, prep.workingDir, heartbeatRunId],
		);

		emit('stdout', `${invocationCommand}\n`);

		const parser = createAgentStreamParser(runtimeType);

		const persistRotatedAuth = async () => {
			const mount = context.subscriptionMount;
			if (!mount?.rotates) return;
			try {
				if (existsSync(mount.hostAuthFile)) {
					const rotated = readFileSync(mount.hostAuthFile, 'utf8');
					if (rotated && rotated !== credential.value) {
						await updateAiProviderCredential(
							deps.db,
							deps.masterKeyManager,
							credential.configId,
							rotated,
						);
					}
				}
			} catch (e) {
				emit(
					'stderr',
					`[runner] failed to persist rotated subscription auth: ${(e as Error).message}\n`,
				);
			}
		};

		const cleanupRunArtifacts = async () => {
			await persistRotatedAuth();
			rmSync(hostPromptPath, { force: true });
			const dirToRemove = context.subscriptionMount?.hostDir ?? context.homeMount?.hostDir;
			if (dirToRemove) {
				rmSync(dirToRemove, { recursive: true, force: true });
			}
			if (deps.sshAgentServer) {
				await deps.sshAgentServer.releaseRunSocket(heartbeatRunId);
			}
			if (deps.egressProxy && egressAllocated) {
				await deps.egressProxy.releaseRunProxy(heartbeatRunId);
			}
		};

		try {
			if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

			const execId = await deps.docker.execCreate(project.container_id, {
				Cmd: context.execCmd,
				Env: context.env,
				WorkingDir: prep.workingDir,
				User: 'node',
				AttachStdout: true,
				AttachStderr: true,
			});

			const onChunk = async (chunk: ExecLogChunk) => {
				const rendered =
					chunk.stream === 'stdout' ? parser.onStdout(chunk.text) : parser.onStderr(chunk.text);
				if (rendered) emit(chunk.stream, rendered);
			};

			const { stdout, stderr } = await deps.docker.execStart(execId, { signal, onChunk });
			const tail = parser.flush();
			if (tail) emit('stdout', tail);
			const execInfo = await deps.docker.execInspect(execId);
			const durationMs = Date.now() - startTime;
			const success = execInfo.ExitCode === 0;

			await deps.logs.end(streamId);
			await updateHeartbeatRun(
				deps.db,
				heartbeatRunId,
				{
					status: success ? HeartbeatRunStatus.Succeeded : HeartbeatRunStatus.Failed,
					exitCode: execInfo.ExitCode,
					durationMs,
					usage: parser.getUsage(),
				},
				runBroadcast,
			);

			await cleanupRunArtifacts();
			return { success, exitCode: execInfo.ExitCode, stdout, stderr, durationMs, heartbeatRunId };
		} catch (error) {
			const durationMs = Date.now() - startTime;
			const isAbort = (error as Error).name === 'AbortError';
			const exitReason = exitReasonFromSignal(signal);
			const errorMessage = exitReason ?? (error as Error).message;
			const status = isAbort
				? exitReason
					? HeartbeatRunStatus.Failed
					: HeartbeatRunStatus.Cancelled
				: HeartbeatRunStatus.Failed;

			emit('stderr', `\n[runner] ${errorMessage}\n`);

			await deps.logs.end(streamId);
			await updateHeartbeatRun(
				deps.db,
				heartbeatRunId,
				{
					status,
					exitCode: -1,
					durationMs,
					error: errorMessage,
				},
				runBroadcast,
			);

			await cleanupRunArtifacts();
			return {
				success: false,
				exitCode: -1,
				stdout: '',
				stderr: errorMessage,
				durationMs,
				heartbeatRunId,
			};
		}
	} finally {
		releaseCredentialLock?.();
	}
}

function failedResult(stderr: string, startTime: number): RunResult {
	return { success: false, exitCode: -1, stdout: '', stderr, durationMs: Date.now() - startTime };
}

function abortedResult(startTime: number): RunResult {
	return failedResult('Aborted', startTime);
}

export function shellQuoteArg(arg: string): string {
	if (arg === '') return "''";
	if (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(arg)) return arg;
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

// Serializes git operations that mutate a repo's shared .git store (clone,
// fetch, worktree add) per project. Concurrent runs on the same project work in
// separate per-task worktrees but share one .git per repo, so these brief setup
// steps must not overlap or they race on git's index/ref locks. Keyed by
// project id, so different projects never block one another.
const projectGitLocks = new Map<string, Promise<unknown>>();
function withProjectGitLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
	const prev = projectGitLocks.get(projectId) ?? Promise.resolve();
	const run = prev.then(() => fn());
	const tail = run.catch(() => {});
	projectGitLocks.set(projectId, tail);
	void tail.then(() => {
		if (projectGitLocks.get(projectId) === tail) projectGitLocks.delete(projectId);
	});
	return run;
}

async function prepareWorktrees(
	deps: RunnerDeps,
	project: ProjectInfo,
	task: TaskInfo,
	emit: (stream: 'stdout' | 'stderr', text: string) => void,
	signal?: AbortSignal,
): Promise<{ workingDir: string; designatedRepo: RepoRow | null }> {
	const emitSystem = (stream: 'stdout' | 'stderr', text: string) =>
		emit(stream, `[system] ${text}\n`);

	const repos = await deps.db.query<RepoRow>(
		`SELECT id, short_name, repo_identifier FROM repos
		 WHERE project_id = $1 ORDER BY created_at ASC`,
		[project.id],
	);

	if (repos.rows.length === 0) {
		emitSystem('stdout', '(no repos linked to project — running in /workspace)');
		return { workingDir: '/workspace', designatedRepo: null };
	}

	return withProjectGitLock(project.id, async () => {
		emitSystem('stdout', '(syncing repos...)');
		const syncRes = await ensureProjectRepos(
			deps.db,
			deps.masterKeyManager,
			{
				id: project.id,
				team_id: project.team_id,
			},
			deps.dataDir,
			deps.sshAgentServer,
			emitSystem,
		);
		if (syncRes.cloned.length > 0) {
			emitSystem('stdout', `(cloned ${syncRes.cloned.length} repo(s) on demand)`);
		}

		if (signal?.aborted) return { workingDir: '/workspace', designatedRepo: null };

		const workspaceRoot = getWorkspacePath(deps.dataDir, project.team_id, project.id);
		const worktreesRoot = getWorktreesPath(deps.dataDir, project.team_id, project.id);
		const taskWorktreeRoot = join(worktreesRoot, task.identifier);
		mkdirSync(taskWorktreeRoot, { recursive: true });

		const branchName = `hezo/${task.identifier}`;
		const knownHostsPath = await ensureGithubKnownHosts(deps.dataDir);
		const reposNeedingWorktree = repos.rows.filter(
			(r) => !signal?.aborted && existsSync(join(workspaceRoot, r.short_name, '.git')),
		);

		if (reposNeedingWorktree.length > 0 && deps.sshAgentServer) {
			await withHostAgentSocket(
				deps.sshAgentServer,
				project.team_id,
				deps.dataDir,
				async ({ sshAuthSock }) => {
					for (const repo of reposNeedingWorktree) {
						if (signal?.aborted) break;
						const repoDir = join(workspaceRoot, repo.short_name);

						emitSystem('stdout', `git fetch ${repo.short_name}...`);
						const fetchRes = await fetchRepo(repoDir, sshAuthSock, knownHostsPath);
						if (fetchRes.success) {
							emitSystem('stdout', `git fetch ${repo.short_name} done`);
						} else {
							emitSystem('stderr', `git fetch ${repo.short_name} failed: ${fetchRes.error ?? '?'}`);
						}
					}
				},
			);
		}

		for (const repo of repos.rows) {
			if (signal?.aborted) break;
			const repoDir = join(workspaceRoot, repo.short_name);
			const worktreePath = join(taskWorktreeRoot, repo.short_name);

			if (!existsSync(join(repoDir, '.git'))) {
				emitSystem('stderr', `(skipping worktree for ${repo.short_name} — not cloned)`);
				continue;
			}

			emitSystem('stdout', `git worktree ${repo.short_name}...`);
			const wt = await ensureTaskWorktree(repoDir, worktreePath, branchName);
			if (!wt.success) {
				emitSystem(
					'stderr',
					`git worktree for ${repo.short_name} failed: ${wt.error ?? 'unknown'}`,
				);
			} else if (wt.created) {
				emitSystem('stdout', `git worktree add ${repo.short_name} @ ${branchName}`);
			}
		}

		const designated = project.designated_repo_id
			? repos.rows.find((r) => r.id === project.designated_repo_id)
			: null;
		const primary = designated ?? repos.rows[0];
		const workingDir = `/worktrees/${task.identifier}/${primary.short_name}`;

		return { workingDir, designatedRepo: primary ?? null };
	});
}

export interface MentionOpenTicket {
	identifier: string;
	title: string;
	status: string;
	priority: string;
}

export interface MentionContext {
	authorName: string;
	excerpt: string;
	openTickets: MentionOpenTicket[];
	triggeringCommentId: string;
}

export async function loadMentionContext(
	db: PGlite,
	agentMemberId: string,
	teamId: string,
	wakeupPayload: Record<string, unknown>,
): Promise<MentionContext | null> {
	const commentId = typeof wakeupPayload.comment_id === 'string' ? wakeupPayload.comment_id : null;
	if (!commentId) return null;

	const row = await db.query<{
		content: Record<string, unknown>;
		author_name: string | null;
	}>(
		`SELECT ic.content,
		        COALESCE(ma.title, m.display_name, 'Admin') AS author_name
		 FROM task_comments ic
		 LEFT JOIN members m ON m.id = ic.author_member_id
		 LEFT JOIN member_agents ma ON ma.id = ic.author_member_id
		 WHERE ic.id = $1`,
		[commentId],
	);
	if (row.rows.length === 0) return null;

	// The full comment body is injected verbatim into the handoff — no truncation,
	// no code-fence stripping — so the agent sees exactly what was said.
	const excerpt = extractCommentText(row.rows[0].content).trim();

	const tickets = await db.query<MentionOpenTicket>(
		`SELECT identifier, title, status::text AS status, priority::text AS priority
		 FROM tasks
		 WHERE assignee_id = $1
		   AND team_id = $2
		   AND status NOT IN (${TERMINAL_TASK_STATUSES.map((_, i) => `$${i + 3}::task_status`).join(', ')})
		 ORDER BY
		   CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
		   updated_at DESC
		 LIMIT 10`,
		[agentMemberId, teamId, ...TERMINAL_TASK_STATUSES],
	);

	return {
		authorName: row.rows[0].author_name ?? 'Admin',
		excerpt,
		openTickets: tickets.rows,
		triggeringCommentId: commentId,
	};
}

const REACTION_GLYPH: Record<string, string> = { ack: '✓' };

function reactorLabel(m: { slug: string | null; display_name: string | null }): string {
	if (m.slug) return `@${m.slug}`;
	return m.display_name ?? 'someone';
}

export function formatReactionLine(groups: ReactionGroup[] | undefined): string | null {
	if (!groups || groups.length === 0) return null;
	const parts = groups.map((g) => {
		const glyph = REACTION_GLYPH[g.kind] ?? g.kind;
		return `${glyph} ${g.members.map(reactorLabel).join(', ')}`;
	});
	return `Reactions: ${parts.join(' · ')}`;
}

export interface AgentAttachment {
	id: string;
	original_filename: string;
	content_type: string;
	byte_size: number;
	path: string;
}

export const AGENT_ATTACHMENT_DIR = '/workspace/.hezo/assets';

export async function loadAgentAttachmentsForComments(
	db: PGlite,
	commentIds: string[],
): Promise<Map<string, AgentAttachment[]>> {
	if (commentIds.length === 0) return new Map();
	const rows = await db.query<{
		comment_id: string;
		id: string;
		original_filename: string;
		content_type: string;
		byte_size: number;
	}>(
		`SELECT ca.comment_id, a.id, a.original_filename, a.content_type, a.byte_size
		 FROM comment_attachments ca
		 JOIN assets a ON a.id = ca.asset_id
		 WHERE ca.comment_id = ANY($1::uuid[])
		 ORDER BY ca.created_at ASC`,
		[commentIds],
	);
	const out = new Map<string, AgentAttachment[]>();
	for (const row of rows.rows) {
		const list = out.get(row.comment_id) ?? [];
		list.push({
			id: row.id,
			original_filename: row.original_filename,
			content_type: row.content_type,
			byte_size: row.byte_size,
			path: `${AGENT_ATTACHMENT_DIR}/${row.id}`,
		});
		out.set(row.comment_id, list);
	}
	return out;
}

function extractCommentText(content: unknown): string {
	if (content == null) return '';
	if (typeof content === 'string') return content;
	if (typeof content !== 'object') return String(content);
	const obj = content as Record<string, unknown>;
	if (typeof obj.text === 'string') return obj.text;
	return Object.values(obj)
		.map(extractCommentText)
		.filter((v) => v.length > 0)
		.join('\n');
}

export interface BuildTaskPromptContext {
	mentionContext?: MentionContext | null;
	replyContext?: ReplyContext | null;
	spawnedFrom?: SpawnedFromTask | null;
}

export function buildTaskPrompt(
	systemPrompt: string,
	task: TaskInfo,
	wakeupPayload?: Record<string, unknown>,
	ctx: BuildTaskPromptContext = {},
): string {
	const { mentionContext, replyContext, spawnedFrom } = ctx;
	const parts = [systemPrompt, '', '---', ''];

	if (replyContext && wakeupPayload?.source === WakeupSource.Reply) {
		parts.push(...renderReplyHandoff(task, replyContext));
	} else if (mentionContext && wakeupPayload?.source === WakeupSource.Mention) {
		parts.push(...renderMentionHandoff(task, mentionContext));
	}

	parts.push(`## Current Task: ${task.identifier} — ${task.title}`);
	parts.push(`**Priority:** ${task.priority}`);
	parts.push(`**Status:** ${task.status}`);
	if (spawnedFrom?.parentLine) parts.push(spawnedFrom.parentLine);
	if (spawnedFrom?.spawnLine) parts.push(spawnedFrom.spawnLine);
	parts.push('');

	if (task.rules) {
		parts.push('### Rules for this task');
		parts.push(task.rules);
		parts.push('');
	}

	parts.push('### Description');
	parts.push(task.description || 'No description provided.');

	if (task.progress_summary) {
		parts.push('');
		parts.push('### Progress Summary');
		parts.push(task.progress_summary);
	}

	if (wakeupPayload?.previous_failure) {
		const pf = wakeupPayload.previous_failure as Record<string, unknown>;
		parts.push('');
		parts.push(`## Retry Attempt ${wakeupPayload.retry_count}/${wakeupPayload.max_retries}`);
		parts.push('The previous attempt FAILED. Analyze the error and try a different approach.');
		if (pf.exit_code !== undefined && pf.exit_code !== null)
			parts.push(`**Exit code:** ${pf.exit_code}`);
		if (pf.stderr_tail) parts.push(`**Error output:**\n\`\`\`\n${pf.stderr_tail}\n\`\`\``);
		if (pf.stdout_tail) parts.push(`**Last output:**\n\`\`\`\n${pf.stdout_tail}\n\`\`\``);
	}

	parts.push('');
	parts.push('Work on this task. Post comments via the Agent API to report progress.');

	return parts.join('\n');
}

function renderMentionHandoff(task: TaskInfo, ctx: MentionContext): string[] {
	const ticketList =
		ctx.openTickets.length === 0
			? 'none'
			: ctx.openTickets
					.map((t) => `- ${t.identifier} — ${t.title} (${t.status}, ${t.priority})`)
					.join('\n');
	const excerptBlock = ctx.excerpt
		? ctx.excerpt
				.split('\n')
				.map((line) => `> ${line}`)
				.join('\n')
		: '> (empty)';
	return [
		'## Mention Handoff',
		`You were mentioned by ${ctx.authorName} in ${task.identifier} — their full comment:`,
		'',
		excerptBlock,
		'',
		'### Your open tickets',
		ticketList,
		'',
		'### How to handle this mention',
		`Follow the \`## Handling @-mentions\` rules defined in your system prompt. The triggering ticket referenced in those rules is ${task.identifier}; when creating a sub-task, use \`parent_task_id = ${task.id}\`.`,
		`To acknowledge the handoff, call \`add_reaction(comment_id='${ctx.triggeringCommentId}', kind='ack')\`. That is the triggering comment's UUID — do not call \`list_comments\` to look it up.`,
		'',
		'---',
		'',
	];
}

export interface ReplyContext {
	responderName: string;
	responderSlug: string | null;
	replyExcerpt: string;
	originalExcerpt: string;
	referencedTasks: Array<{ identifier: string; title: string; status: string }>;
}

export async function loadReplyContext(
	db: PGlite,
	wakeupPayload: Record<string, unknown>,
): Promise<ReplyContext | null> {
	const replyCommentId =
		typeof wakeupPayload.comment_id === 'string' ? wakeupPayload.comment_id : null;
	const triggeringCommentId =
		typeof wakeupPayload.triggering_comment_id === 'string'
			? wakeupPayload.triggering_comment_id
			: null;
	if (!replyCommentId || !triggeringCommentId) return null;

	const reply = await db.query<{
		content: Record<string, unknown>;
		task_id: string;
		author_name: string | null;
		author_slug: string | null;
	}>(
		`SELECT ic.content, ic.task_id,
		        COALESCE(ma.title, m.display_name, 'Admin') AS author_name,
		        ma.slug AS author_slug
		 FROM task_comments ic
		 LEFT JOIN members m ON m.id = ic.author_member_id
		 LEFT JOIN member_agents ma ON ma.id = ic.author_member_id
		 WHERE ic.id = $1`,
		[replyCommentId],
	);
	if (reply.rows.length === 0) return null;

	const original = await db.query<{ content: Record<string, unknown> }>(
		'SELECT content FROM task_comments WHERE id = $1',
		[triggeringCommentId],
	);
	if (original.rows.length === 0) return null;

	const replyText = extractCommentText(reply.rows[0].content);
	const originalText = extractCommentText(original.rows[0].content);

	const referencedIdentifiers = Array.from(
		new Set(replyText.match(/\b[A-Z][A-Z0-9_]*-\d+\b/g) ?? []),
	);
	let referencedTasks: ReplyContext['referencedTasks'] = [];
	if (referencedIdentifiers.length > 0) {
		const rows = await db.query<{ identifier: string; title: string; status: string }>(
			`SELECT identifier, title, status::text AS status
			 FROM tasks
			 WHERE identifier = ANY($1::text[])`,
			[referencedIdentifiers],
		);
		referencedTasks = rows.rows;
	}

	return {
		responderName: reply.rows[0].author_name ?? 'Agent',
		responderSlug: reply.rows[0].author_slug,
		replyExcerpt: replyText.trim(),
		originalExcerpt: originalText.trim(),
		referencedTasks,
	};
}

function renderReplyHandoff(task: TaskInfo, ctx: ReplyContext): string[] {
	const replyBlock = ctx.replyExcerpt
		? ctx.replyExcerpt
				.split('\n')
				.map((line) => `> ${line}`)
				.join('\n')
		: '> (empty)';
	const originalBlock = ctx.originalExcerpt
		? ctx.originalExcerpt
				.split('\n')
				.map((line) => `> ${line}`)
				.join('\n')
		: '> (empty)';
	const referenced =
		ctx.referencedTasks.length === 0
			? 'none'
			: ctx.referencedTasks.map((t) => `- ${t.identifier} — ${t.title} (${t.status})`).join('\n');
	const responderLabel = ctx.responderSlug
		? `${ctx.responderName} (@${ctx.responderSlug})`
		: ctx.responderName;
	return [
		'## Reply Received',
		`${responderLabel} replied on ${task.identifier} to a comment of yours. Your original comment:`,
		'',
		originalBlock,
		'',
		'### Their reply',
		replyBlock,
		'',
		'### Tickets referenced by the reply',
		referenced,
		'',
		'### How to handle this reply',
		'1. Read the reply and any referenced tickets.',
		`2. If more responses to the same original comment are still expected (you mentioned multiple agents), you may choose to wait — another reply wakeup will arrive and you'll see the latest state then.`,
		`3. Otherwise, update your own plan or post a follow-up comment on ${task.identifier} as appropriate. Do not re-mention the responder unless you need another round-trip.`,
		'4. End the turn.',
		'',
		'---',
		'',
	];
}

export interface SpawnedFromTask {
	parentLine: string | null;
	spawnLine: string | null;
}

export async function loadSpawnedFromTask(
	db: PGlite,
	task: TaskInfo,
): Promise<SpawnedFromTask | null> {
	let spawningTask: { id: string; identifier: string; title: string } | null = null;
	if (task.created_by_run_id) {
		const row = await db.query<{ id: string; identifier: string; title: string }>(
			`SELECT i.id, i.identifier, i.title
			 FROM heartbeat_runs r JOIN tasks i ON i.id = r.task_id
			 WHERE r.id = $1`,
			[task.created_by_run_id],
		);
		if (row.rows.length > 0 && row.rows[0].id !== task.id) {
			spawningTask = row.rows[0];
		}
	}

	let parent: { id: string; identifier: string; title: string } | null = null;
	if (task.parent_task_id) {
		const row = await db.query<{ id: string; identifier: string; title: string }>(
			'SELECT id, identifier, title FROM tasks WHERE id = $1',
			[task.parent_task_id],
		);
		if (row.rows.length > 0) parent = row.rows[0];
	}

	if (!spawningTask && !parent) return null;

	if (parent && spawningTask && parent.id === spawningTask.id) {
		return {
			parentLine: `**Parent ticket:** ${parent.identifier} — ${parent.title}`,
			spawnLine: null,
		};
	}
	return {
		parentLine: parent ? `**Parent ticket:** ${parent.identifier} — ${parent.title}` : null,
		spawnLine: spawningTask
			? `**Spawned from:** ${spawningTask.identifier} — ${spawningTask.title} (provenance only; this ticket is your own work)`
			: null,
	};
}

export async function buildCoachReviewPrompt(
	db: PGlite,
	systemPrompt: string,
	task: TaskInfo,
	teamId: string,
): Promise<string> {
	const comments = await db.query<{
		id: string;
		content_type: string;
		content: Record<string, unknown>;
		author_name: string;
		created_at: string;
	}>(
		`SELECT ic.id, ic.content_type, ic.content,
		        COALESCE(ma.title, m.display_name, 'Unknown') AS author_name,
		        ic.created_at::text
		 FROM task_comments ic
		 LEFT JOIN members m ON m.id = ic.author_member_id
		 LEFT JOIN member_agents ma ON ma.id = ic.author_member_id
		 WHERE ic.task_id = $1
		 ORDER BY ic.created_at ASC`,
		[task.id],
	);

	const reactionsByComment = await loadReactionsForTask(db, task.id);

	const involvedAgents = await db.query<{
		id: string;
		title: string;
		slug: string;
	}>(
		`SELECT DISTINCT ma.id, ma.title, ma.slug
		 FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1
		   AND (ma.id = (SELECT assignee_id FROM tasks WHERE id = $2)
		        OR ma.id IN (SELECT DISTINCT author_member_id FROM task_comments WHERE task_id = $2 AND author_member_id IS NOT NULL))`,
		[teamId, task.id],
	);

	const commentIds = comments.rows.map((c) => c.id);
	const attachmentsByComment = await loadAgentAttachmentsForComments(db, commentIds);

	const commentLog = comments.rows
		.map((c) => {
			const text =
				c.content_type === 'text' ? extractCommentText(c.content) : JSON.stringify(c.content);
			const base = `[${c.created_at}] ${c.author_name} (${c.content_type}): ${text}`;
			const reactionLine = formatReactionLine(reactionsByComment.get(c.id));
			const attachmentLines = (attachmentsByComment.get(c.id) ?? []).map(
				(a) =>
					`  attachment: ${a.original_filename} (${a.content_type}, ${a.byte_size} bytes) → ${a.path}`,
			);
			const extra = [reactionLine, ...attachmentLines].filter((l): l is string => l !== null);
			return extra.length > 0 ? `${base}\n${extra.join('\n')}` : base;
		})
		.join('\n');

	const agentList = involvedAgents.rows
		.map((a) => `- ${a.title} (slug: ${a.slug}, id: ${a.id})`)
		.join('\n');

	const parts = [
		systemPrompt,
		'',
		'---',
		'',
		`## Review Completed Ticket: ${task.identifier} — ${task.title}`,
		`**Final Status:** ${task.status}`,
		`**Priority:** ${task.priority}`,
		'',
		'### Description',
		task.description || 'No description provided.',
		'',
		...(task.rules ? ['### Rules', task.rules, ''] : []),
		...(task.progress_summary ? ['### Progress Summary', task.progress_summary, ''] : []),
		'### Agents Involved',
		agentList || 'No agents identified.',
		'',
		'### Comment History',
		commentLog || 'No comments on this task.',
		'',
		'### Your Task',
		'Review this completed ticket. Analyze the comment history for patterns where agents struggled,',
		'received feedback, had work rejected, or needed multiple attempts. For each improvement opportunity,',
		"use `get_agent_system_prompt` with `placeholders: false` to read the affected agent's raw prompt",
		'(you need the `{{…}}` placeholders intact for a safe round-trip), then use `update_agent_system_prompt`',
		'to add a specific rule to their `## Learned Rules` section. Updates apply immediately and a revision',
		'snapshot is recorded so the admin can roll back from the agent settings page if needed.',
		'',
		'If the ticket completed smoothly without significant rework or feedback, no changes are needed.',
		'',
		'### Final Step',
		`Post the review summary comment on ${task.identifier} now, following the format defined in your system prompt.`,
	];

	return parts.join('\n');
}

export interface HeartbeatRunBroadcast {
	wsManager?: WebSocketManager;
	events?: DomainEventBus;
	teamId: string;
	projectId?: string;
	taskId: string;
	memberId: string;
}

function broadcastHeartbeatRunChange(
	ctx: HeartbeatRunBroadcast,
	runId: string,
	status: string,
	action: 'INSERT' | 'UPDATE',
): void {
	if (!ctx.wsManager) return;
	broadcastRowChange(ctx.wsManager, wsRoom.team(ctx.teamId), 'heartbeat_runs', action, {
		id: runId,
		task_id: ctx.taskId,
		team_id: ctx.teamId,
		member_id: ctx.memberId,
		status,
	});
}

export interface TriggeredBy {
	member_id: string | null;
	name: string;
}

export async function createHeartbeatRun(
	db: PGlite,
	agent: AgentInfo,
	runTeamId: string,
	task: TaskInfo,
	broadcast: HeartbeatRunBroadcast,
	wakeupId: string,
	triggeredBy: TriggeredBy | null = null,
): Promise<string> {
	const { runId, statusFlippedToInProgress } = await withTransaction(db, async () => {
		const runResult = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, wakeup_id, status)
			 VALUES ($1, $2, $3, $4, $5::heartbeat_run_status)
			 RETURNING id`,
			[agent.id, runTeamId, task.id, wakeupId, HeartbeatRunStatus.Queued],
		);
		const runId = runResult.rows[0].id;

		await db.query(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)`,
			[
				task.id,
				agent.id,
				CommentContentType.Run,
				JSON.stringify({
					run_id: runId,
					agent_id: agent.id,
					agent_title: agent.title,
					agent_slug: agent.slug,
					...(triggeredBy ? { actor_id: triggeredBy.member_id, actor_name: triggeredBy.name } : {}),
				}),
			],
		);

		let statusFlippedToInProgress = false;
		if (task.assignee_id === agent.id && task.status === TaskStatus.Backlog) {
			const updated = await db.query<{ id: string }>(
				`UPDATE tasks
				    SET status = $1::task_status, updated_at = now()
				  WHERE id = $2 AND status = $3::task_status
				  RETURNING id`,
				[TaskStatus.InProgress, task.id, TaskStatus.Backlog],
			);
			if (updated.rows.length > 0) {
				statusFlippedToInProgress = true;
				task.status = TaskStatus.InProgress;
			}
		}

		return { runId, statusFlippedToInProgress };
	});

	broadcastHeartbeatRunChange(broadcast, runId, HeartbeatRunStatus.Queued, 'INSERT');
	if (broadcast.wsManager) {
		broadcastRowChange(
			broadcast.wsManager,
			wsRoom.team(broadcast.teamId),
			'task_comments',
			'INSERT',
			{
				task_id: task.id,
			},
		);
		if (statusFlippedToInProgress) {
			broadcastRowChange(broadcast.wsManager, wsRoom.team(broadcast.teamId), 'tasks', 'UPDATE', {
				id: task.id,
				team_id: broadcast.teamId,
				status: TaskStatus.InProgress,
			});
		}
	}
	if (statusFlippedToInProgress) {
		await recordStatusChange(
			db,
			broadcast.teamId,
			task.id,
			TaskStatus.Backlog,
			TaskStatus.InProgress,
			agent.id,
			broadcast.wsManager,
		);
	}
	return runId;
}

async function markHeartbeatRunRunning(
	db: PGlite,
	runId: string,
	broadcast: HeartbeatRunBroadcast,
): Promise<void> {
	const result = await db.query<{ id: string }>(
		`UPDATE heartbeat_runs
		    SET status = $1::heartbeat_run_status, started_at = now()
		  WHERE id = $2 AND status = $3::heartbeat_run_status
		  RETURNING id`,
		[HeartbeatRunStatus.Running, runId, HeartbeatRunStatus.Queued],
	);
	if (result.rows.length > 0) {
		broadcastHeartbeatRunChange(broadcast, runId, HeartbeatRunStatus.Running, 'UPDATE');
	}
}

async function updateHeartbeatRun(
	db: PGlite,
	runId: string,
	update: {
		status: string;
		exitCode: number;
		durationMs: number;
		error?: string;
		usage?: AgentRunUsage | null;
	},
	broadcast: HeartbeatRunBroadcast,
): Promise<void> {
	await db.query(
		`UPDATE heartbeat_runs
		 SET status = $1::heartbeat_run_status,
		     started_at = COALESCE(started_at, now()),
		     finished_at = now(),
		     exit_code = $2,
		     error = COALESCE($3, error),
		     input_tokens = COALESCE($4, input_tokens),
		     output_tokens = COALESCE($5, output_tokens),
		     cost_cents = COALESCE($6, cost_cents)
		 WHERE id = $7`,
		[
			update.status,
			update.exitCode,
			update.error ?? null,
			update.usage?.inputTokens ?? null,
			update.usage?.outputTokens ?? null,
			update.usage?.costCents ?? null,
			runId,
		],
	);
	broadcastHeartbeatRunChange(broadcast, runId, update.status, 'UPDATE');
	broadcast.events?.emit({
		type: 'agent_run.completed',
		teamId: broadcast.teamId,
		projectId: broadcast.projectId ?? null,
		runId,
		taskId: broadcast.taskId,
		agentMemberId: broadcast.memberId,
		status: update.status as HeartbeatRunStatus,
		exitCode: update.exitCode,
		error: update.error ?? null,
	});
}

/**
 * Emit `agent_run.started` once the run row exists. Looks up the wakeup's source
 * and a light triggered-by hint for the audit trail.
 */
async function emitRunStarted(
	deps: RunnerDeps,
	runId: string,
	agent: AgentInfo,
	task: TaskInfo,
	project: ProjectInfo,
	wakeupId: string,
): Promise<void> {
	if (!deps.events) return;
	let triggerSource: string | null = null;
	let triggeredBy: string | null = null;
	try {
		const r = await deps.db.query<{ source: string; payload: Record<string, unknown> | null }>(
			'SELECT source, payload FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		triggerSource = r.rows[0]?.source ?? null;
		const payload = r.rows[0]?.payload;
		const by = payload?.author_member_id ?? payload?.reason;
		triggeredBy = typeof by === 'string' ? by : null;
	} catch {
		// Best-effort enrichment; the started event still fires without it.
	}
	deps.events.emit({
		type: 'agent_run.started',
		teamId: agent.team_id,
		projectId: project.id,
		runId,
		taskId: task.id,
		agentMemberId: agent.id,
		triggerSource,
		triggeredBy,
	});
}
