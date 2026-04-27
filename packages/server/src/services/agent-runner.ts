import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import {
	type AgentRuntime,
	AiAuthMethod,
	type AiProvider,
	CommentContentType,
	ContainerStatus,
	HeartbeatRunStatus,
	IssueStatus,
	PROVIDER_TO_ENV_VAR,
	PROVIDER_TO_RUNTIME,
	RUNTIME_AUTO_APPROVE_ARGS,
	RUNTIME_COMMANDS,
	RUNTIME_HEADLESS_PREFIX_ARGS,
	RUNTIME_HEADLESS_SUFFIX_ARGS,
	RUNTIME_STREAM_ARGS,
	RUNTIME_TO_PROVIDER,
	TERMINAL_ISSUE_STATUSES,
	WakeupSource,
	WsMessageType,
	wsRoom,
} from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import { broadcastRowChange } from '../lib/broadcast';
import { signAgentJwt } from '../middleware/auth';
import { type AgentRunUsage, createAgentStreamParser } from './agent-stream-parser';
import {
	type AiProviderCredential,
	getProviderCredentialAndModel,
	updateAiProviderCredential,
} from './ai-provider-keys';
import type { DockerClient, ExecLogChunk } from './docker';
import { getAgentSystemPrompt } from './documents';
import { applyEffortToRuntime, type EffortRuntimeApplication, resolveEffort } from './effort';
import { ensureIssueWorktree, fetchRepo } from './git';
import { recordStatusChange } from './issue-events';
import type { LogStreamBroker } from './log-stream-broker';
import { MCP_ADAPTERS, type McpDescriptor, validateInjection } from './mcp-injectors';
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
import { resolveRuntimeForIssue } from './runtime-resolver';
import { getCompanySSHKey } from './ssh-keys';
import { resolveSystemPrompt } from './template-resolver';
import { getWorkspacePath, getWorktreesPath } from './workspace';
import type { WebSocketManager } from './ws';

export interface AgentInfo {
	id: string;
	title: string;
	slug?: string | null;
	company_id: string;
	default_effort?: string | null;
	model_override_provider?: AiProvider | null;
	model_override_model?: string | null;
}

export interface IssueInfo {
	id: string;
	identifier: string;
	title: string;
	description: string;
	status: string;
	priority: string;
	project_id: string;
	rules: string | null;
	assignee_id?: string | null;
	runtime_type?: AgentRuntime | null;
	parent_issue_id?: string | null;
	created_by_run_id?: string | null;
}

interface ProjectInfo {
	id: string;
	slug: string;
	company_id: string;
	company_slug: string;
	container_id: string;
	container_status: string;
	designated_repo_id: string | null;
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
	logs: LogStreamBroker;
}

interface RepoRow {
	id: string;
	short_name: string;
	repo_identifier: string;
}

/**
 * Build the env-var entries for a given provider/auth method. Only the matching
 * env var is set; agents that read a different var won't see the credential.
 *
 * Returns no env entries for subscription credentials, which are delivered via
 * a file mount instead — see {@link buildSubscriptionMount}.
 */
export function buildProviderEnv(provider: AiProvider, credential: AiProviderCredential): string[] {
	const envVarName = PROVIDER_TO_ENV_VAR[provider]?.[credential.authMethod];
	if (!envVarName) return [];
	return [`${envVarName}=${credential.value}`];
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
	companySlug: string,
	projectSlug: string,
	heartbeatRunId: string,
): string {
	return join(
		getWorkspacePath(dataDir, companySlug, projectSlug),
		'.hezo',
		'prompts',
		`${heartbeatRunId}.txt`,
	);
}

function wrapExecCmd(cmd: string[]): string[] {
	return ['sh', '-c', 'exec "$@" < "$HEZO_PROMPT_FILE"', 'sh', ...cmd];
}

async function buildRunContext(
	deps: RunnerDeps,
	agent: AgentInfo,
	issue: IssueInfo,
	project: ProjectInfo,
	wakeupPayload: Record<string, unknown> | undefined,
	credential: AiProviderCredential,
	provider: AiProvider,
	runtimeType: AgentRuntime,
	heartbeatRunId: string,
	modelOverride: string | null,
): Promise<RunContext> {
	const storedPrompt = await getAgentSystemPrompt(deps.db, agent.company_id, agent.id);
	let resolvedPrompt = await resolveSystemPrompt(deps.db, storedPrompt, {
		companyId: agent.company_id,
		projectId: project.id,
		issueId: issue.id,
		agentId: agent.id,
		dataDir: deps.dataDir,
	});

	if (resolvedPrompt.includes('{{requester_context}}')) {
		const creator = await deps.db.query<{ display_name: string; member_type: string }>(
			`SELECT m.display_name, m.member_type FROM issues i
			 JOIN members m ON m.id = i.created_by_member_id
			 WHERE i.id = $1`,
			[issue.id],
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
		agent.company_id,
		heartbeatRunId,
	);
	const effort = resolveEffort(wakeupPayload?.effort, agent.default_effort, agent.slug);
	const effortApplication = applyEffortToRuntime(runtimeType, effort);

	const isCoachReview = wakeupPayload?.trigger === 'issue_done';
	const mentionContext =
		wakeupPayload?.source === WakeupSource.Mention
			? await loadMentionContext(deps.db, agent.id, agent.company_id, wakeupPayload)
			: null;
	const replyContext =
		wakeupPayload?.source === WakeupSource.Reply
			? await loadReplyContext(deps.db, wakeupPayload)
			: null;
	const spawnedFrom = await loadSpawnedFromIssue(deps.db, issue);
	const basePrompt = isCoachReview
		? await buildCoachReviewPrompt(deps.db, resolvedPrompt, issue, agent.company_id)
		: buildTaskPrompt(resolvedPrompt, issue, wakeupPayload, {
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
		project.company_slug,
		project.slug,
		heartbeatRunId,
		provider,
		credential,
	);

	const adapter = MCP_ADAPTERS[runtimeType];
	const homeMount: RuntimeHomeMount | null = adapter.capabilities.requiresHomeDir
		? ensureRuntimeHomeDir(
				runtimeType,
				deps.dataDir,
				project.company_slug,
				project.slug,
				heartbeatRunId,
				subscriptionMount,
			)
		: null;

	const mcpDescriptors: McpDescriptor[] = [
		{
			name: 'hezo',
			url: `http://host.docker.internal:${deps.serverPort}/mcp`,
			bearerToken: agentJwt,
		},
	];

	const mcpInjection = adapter.build(mcpDescriptors, {
		hostHomeDir: homeMount?.hostDir ?? null,
		containerHomeDir: homeMount?.containerDir ?? null,
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
		`HEZO_COMPANY_ID=${agent.company_id}`,
		`HEZO_ISSUE_ID=${issue.id}`,
		`HEZO_ISSUE_IDENTIFIER=${issue.identifier}`,
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

	const cliCommand = RUNTIME_COMMANDS[runtimeType];
	const modelArgs = modelOverride ? ['--model', modelOverride] : [];

	const cmd = [
		cliCommand,
		...RUNTIME_HEADLESS_PREFIX_ARGS[runtimeType],
		...mcpInjection.cliArgs,
		...RUNTIME_STREAM_ARGS[runtimeType],
		...RUNTIME_AUTO_APPROVE_ARGS[runtimeType],
		...effortApplication.extraArgs,
		...modelArgs,
		...RUNTIME_HEADLESS_SUFFIX_ARGS[runtimeType],
	];

	const execCmd = wrapExecCmd(cmd);

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

async function createSyntheticOnDemandWakeup(
	db: PGlite,
	memberId: string,
	companyId: string,
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, payload, claimed_at)
		 VALUES ($1, $2, $3::wakeup_source, 'claimed'::wakeup_status, '{}'::jsonb, now())
		 RETURNING id`,
		[memberId, companyId, WakeupSource.OnDemand],
	);
	return r.rows[0].id;
}

export async function runAgent(
	deps: RunnerDeps,
	agent: AgentInfo,
	issue: IssueInfo,
	project: ProjectInfo,
	wakeupPayload?: Record<string, unknown>,
	signal?: AbortSignal,
	onRunRegistered?: (heartbeatRunId: string) => void,
	wakeupId?: string,
): Promise<RunResult> {
	const startTime = Date.now();

	if (signal?.aborted) return abortedResult(startTime);

	const runBroadcast: HeartbeatRunBroadcast = {
		wsManager: deps.wsManager,
		companyId: agent.company_id,
		issueId: issue.id,
		memberId: agent.id,
	};
	const effectiveWakeupId =
		wakeupId ?? (await createSyntheticOnDemandWakeup(deps.db, agent.id, agent.company_id));
	const heartbeatRunId = await createHeartbeatRun(
		deps.db,
		agent,
		issue,
		runBroadcast,
		effectiveWakeupId,
	);
	onRunRegistered?.(heartbeatRunId);
	const streamId = `run:${heartbeatRunId}`;

	deps.logs.begin({
		streamId,
		room: `project-runs:${project.id}`,
		buildMessage: (line) => ({
			type: WsMessageType.RunLog,
			projectId: project.id,
			runId: heartbeatRunId,
			issueId: issue.id,
			stream: line.stream,
			text: line.text,
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
		runtimeType = PROVIDER_TO_RUNTIME[provider];
	} else {
		const resolved = await resolveRuntimeForIssue(deps.db, issue.runtime_type ?? null);
		if (!resolved) {
			return finalizeFailure(
				'No AI provider credentials configured at the instance level. Add one in Settings > AI Providers.',
			);
		}
		runtimeType = resolved;
		provider = RUNTIME_TO_PROVIDER[runtimeType];
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
	const releaseCredentialLock =
		credential.authMethod === AiAuthMethod.Subscription && layout?.rotates
			? await acquireCredentialLock(credential.configId)
			: null;

	await markHeartbeatRunRunning(deps.db, heartbeatRunId, runBroadcast);

	const context = await buildRunContext(
		deps,
		agent,
		issue,
		project,
		wakeupPayload,
		credential,
		provider,
		runtimeType,
		heartbeatRunId,
		modelOverride,
	);

	if (signal?.aborted) {
		releaseCredentialLock?.();
		const dirToRemove = context.subscriptionMount?.hostDir ?? context.homeMount?.hostDir;
		if (dirToRemove) {
			rmSync(dirToRemove, { recursive: true, force: true });
		}
		return finalizeAbort();
	}

	const prep = await prepareWorktrees(deps, project, issue, emit, signal);

	const hostPromptPath = getHostPromptPath(
		deps.dataDir,
		project.company_slug,
		project.slug,
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
		if (!mount || !mount.rotates) return;
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
		releaseCredentialLock?.();
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

async function prepareWorktrees(
	deps: RunnerDeps,
	project: ProjectInfo,
	issue: IssueInfo,
	emit: (stream: 'stdout' | 'stderr', text: string) => void,
	signal?: AbortSignal,
): Promise<{ workingDir: string; designatedRepo: RepoRow | null }> {
	const repos = await deps.db.query<RepoRow>(
		`SELECT id, short_name, repo_identifier FROM repos
		 WHERE project_id = $1 ORDER BY created_at ASC`,
		[project.id],
	);

	if (repos.rows.length === 0) {
		emit('stdout', '(no repos linked to project — running in /workspace)\n');
		return { workingDir: '/workspace', designatedRepo: null };
	}

	emit('stdout', '(syncing repos...)\n');
	const syncRes = await ensureProjectRepos(
		deps.db,
		deps.masterKeyManager,
		{
			id: project.id,
			company_id: project.company_id,
			companySlug: project.company_slug,
			projectSlug: project.slug,
		},
		deps.dataDir,
		(stream, text) => emit(stream, `${text}\n`),
	);
	if (syncRes.cloned.length > 0) {
		emit('stdout', `(cloned ${syncRes.cloned.length} repo(s) on demand)\n`);
	}

	if (signal?.aborted) return { workingDir: '/workspace', designatedRepo: null };

	const companySshKey = await getCompanySSHKey(deps.db, project.company_id, deps.masterKeyManager);

	const workspaceRoot = getWorkspacePath(deps.dataDir, project.company_slug, project.slug);
	const worktreesRoot = getWorktreesPath(deps.dataDir, project.company_slug, project.slug);
	const issueWorktreeRoot = join(worktreesRoot, issue.identifier);
	mkdirSync(issueWorktreeRoot, { recursive: true });

	const branchName = `hezo/${issue.identifier}`;

	for (const repo of repos.rows) {
		if (signal?.aborted) break;
		const repoDir = join(workspaceRoot, repo.short_name);
		const worktreePath = join(issueWorktreeRoot, repo.short_name);

		if (!existsSync(join(repoDir, '.git'))) {
			emit('stderr', `(skipping worktree for ${repo.short_name} — not cloned)\n`);
			continue;
		}

		if (companySshKey) {
			emit('stdout', `git fetch ${repo.short_name}...\n`);
			const fetchRes = await fetchRepo(repoDir, companySshKey.privateKey);
			if (fetchRes.success) {
				emit('stdout', `git fetch ${repo.short_name} done\n`);
			} else {
				emit('stderr', `git fetch ${repo.short_name} failed: ${fetchRes.error ?? '?'}\n`);
			}
		}

		emit('stdout', `git worktree ${repo.short_name}...\n`);
		const wt = await ensureIssueWorktree(repoDir, worktreePath, branchName);
		if (!wt.success) {
			emit('stderr', `git worktree for ${repo.short_name} failed: ${wt.error ?? 'unknown'}\n`);
		} else if (wt.created) {
			emit('stdout', `git worktree add ${repo.short_name} @ ${branchName}\n`);
		}
	}

	const designated = project.designated_repo_id
		? repos.rows.find((r) => r.id === project.designated_repo_id)
		: null;
	const primary = designated ?? repos.rows[0];
	const workingDir = `/worktrees/${issue.identifier}/${primary.short_name}`;

	return { workingDir, designatedRepo: primary ?? null };
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
}

const MENTION_EXCERPT_MAX = 500;
const FENCED_CODE_STRIP_RE = /(?:^|\n)(?:```|~~~)[^\n]*\n[\s\S]*?(?:```|~~~)(?=\n|$)/g;

export async function loadMentionContext(
	db: PGlite,
	agentMemberId: string,
	companyId: string,
	wakeupPayload: Record<string, unknown>,
): Promise<MentionContext | null> {
	const commentId = typeof wakeupPayload.comment_id === 'string' ? wakeupPayload.comment_id : null;
	if (!commentId) return null;

	const row = await db.query<{
		content: Record<string, unknown>;
		author_name: string | null;
	}>(
		`SELECT ic.content,
		        COALESCE(ma.title, m.display_name, 'Board') AS author_name
		 FROM issue_comments ic
		 LEFT JOIN members m ON m.id = ic.author_member_id
		 LEFT JOIN member_agents ma ON ma.id = ic.author_member_id
		 WHERE ic.id = $1`,
		[commentId],
	);
	if (row.rows.length === 0) return null;

	const commentText = extractCommentText(row.rows[0].content);
	const excerpt = truncateExcerpt(commentText, MENTION_EXCERPT_MAX);

	const tickets = await db.query<MentionOpenTicket>(
		`SELECT identifier, title, status::text AS status, priority::text AS priority
		 FROM issues
		 WHERE assignee_id = $1
		   AND company_id = $2
		   AND status NOT IN (${TERMINAL_ISSUE_STATUSES.map((_, i) => `$${i + 3}::issue_status`).join(', ')})
		 ORDER BY
		   CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
		   updated_at DESC
		 LIMIT 10`,
		[agentMemberId, companyId, ...TERMINAL_ISSUE_STATUSES],
	);

	return {
		authorName: row.rows[0].author_name ?? 'Board',
		excerpt,
		openTickets: tickets.rows,
	};
}

function extractCommentText(content: unknown): string {
	if (!content || typeof content !== 'object') return '';
	const obj = content as Record<string, unknown>;
	if (typeof obj.text === 'string') return obj.text;
	return Object.values(obj)
		.filter((v): v is string => typeof v === 'string')
		.join('\n');
}

function truncateExcerpt(text: string, max: number): string {
	const stripped = text.replace(FENCED_CODE_STRIP_RE, '[code omitted]').trim();
	if (stripped.length <= max) return stripped;
	return `${stripped.slice(0, max).trimEnd()}…`;
}

export interface BuildTaskPromptContext {
	mentionContext?: MentionContext | null;
	replyContext?: ReplyContext | null;
	spawnedFrom?: SpawnedFromIssue | null;
}

export function buildTaskPrompt(
	systemPrompt: string,
	issue: IssueInfo,
	wakeupPayload?: Record<string, unknown>,
	ctx: BuildTaskPromptContext = {},
): string {
	const { mentionContext, replyContext, spawnedFrom } = ctx;
	const parts = [systemPrompt, '', '---', ''];

	if (replyContext && wakeupPayload?.source === WakeupSource.Reply) {
		parts.push(...renderReplyHandoff(issue, replyContext));
	} else if (mentionContext && wakeupPayload?.source === WakeupSource.Mention) {
		parts.push(...renderMentionHandoff(issue, mentionContext));
	}

	parts.push(`## Current Task: ${issue.identifier} — ${issue.title}`);
	parts.push(`**Priority:** ${issue.priority}`);
	parts.push(`**Status:** ${issue.status}`);
	if (spawnedFrom?.parentLine) parts.push(spawnedFrom.parentLine);
	if (spawnedFrom?.spawnLine) parts.push(spawnedFrom.spawnLine);
	parts.push('');

	if (issue.rules) {
		parts.push('### Rules for this issue');
		parts.push(issue.rules);
		parts.push('');
	}

	parts.push(issue.description || 'No description provided.');

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

function renderMentionHandoff(issue: IssueInfo, ctx: MentionContext): string[] {
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
		`You were mentioned by ${ctx.authorName} in ${issue.identifier} — a comment excerpt:`,
		'',
		excerptBlock,
		'',
		'### Your open tickets',
		ticketList,
		'',
		'### How to handle this mention',
		`Follow the \`## Handling @-mentions\` rules defined in your system prompt. The triggering ticket referenced in those rules is ${issue.identifier}; when creating a sub-issue, use \`parent_issue_id = ${issue.id}\`.`,
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
	referencedIssues: Array<{ identifier: string; title: string; status: string }>;
}

const REPLY_EXCERPT_MAX = 500;

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
		issue_id: string;
		author_name: string | null;
		author_slug: string | null;
	}>(
		`SELECT ic.content, ic.issue_id,
		        COALESCE(ma.title, m.display_name, 'Board') AS author_name,
		        ma.slug AS author_slug
		 FROM issue_comments ic
		 LEFT JOIN members m ON m.id = ic.author_member_id
		 LEFT JOIN member_agents ma ON ma.id = ic.author_member_id
		 WHERE ic.id = $1`,
		[replyCommentId],
	);
	if (reply.rows.length === 0) return null;

	const original = await db.query<{ content: Record<string, unknown> }>(
		'SELECT content FROM issue_comments WHERE id = $1',
		[triggeringCommentId],
	);
	if (original.rows.length === 0) return null;

	const replyText = extractCommentText(reply.rows[0].content);
	const originalText = extractCommentText(original.rows[0].content);

	const referencedIdentifiers = Array.from(
		new Set(replyText.match(/\b[A-Z][A-Z0-9_]*-\d+\b/g) ?? []),
	);
	let referencedIssues: ReplyContext['referencedIssues'] = [];
	if (referencedIdentifiers.length > 0) {
		const rows = await db.query<{ identifier: string; title: string; status: string }>(
			`SELECT identifier, title, status::text AS status
			 FROM issues
			 WHERE identifier = ANY($1::text[])`,
			[referencedIdentifiers],
		);
		referencedIssues = rows.rows;
	}

	return {
		responderName: reply.rows[0].author_name ?? 'Agent',
		responderSlug: reply.rows[0].author_slug,
		replyExcerpt: truncateExcerpt(replyText, REPLY_EXCERPT_MAX),
		originalExcerpt: truncateExcerpt(originalText, REPLY_EXCERPT_MAX),
		referencedIssues,
	};
}

function renderReplyHandoff(issue: IssueInfo, ctx: ReplyContext): string[] {
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
		ctx.referencedIssues.length === 0
			? 'none'
			: ctx.referencedIssues.map((t) => `- ${t.identifier} — ${t.title} (${t.status})`).join('\n');
	const responderLabel = ctx.responderSlug
		? `${ctx.responderName} (@${ctx.responderSlug})`
		: ctx.responderName;
	return [
		'## Reply Received',
		`${responderLabel} replied on ${issue.identifier} to a comment of yours. Your original comment:`,
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
		`3. Otherwise, update your own plan or post a follow-up comment on ${issue.identifier} as appropriate. Do not re-mention the responder unless you need another round-trip.`,
		'4. End the turn.',
		'',
		'---',
		'',
	];
}

export interface SpawnedFromIssue {
	parentLine: string | null;
	spawnLine: string | null;
}

export async function loadSpawnedFromIssue(
	db: PGlite,
	issue: IssueInfo,
): Promise<SpawnedFromIssue | null> {
	let spawningIssue: { id: string; identifier: string; title: string } | null = null;
	if (issue.created_by_run_id) {
		const row = await db.query<{ id: string; identifier: string; title: string }>(
			`SELECT i.id, i.identifier, i.title
			 FROM heartbeat_runs r JOIN issues i ON i.id = r.issue_id
			 WHERE r.id = $1`,
			[issue.created_by_run_id],
		);
		if (row.rows.length > 0 && row.rows[0].id !== issue.id) {
			spawningIssue = row.rows[0];
		}
	}

	let parent: { id: string; identifier: string; title: string } | null = null;
	if (issue.parent_issue_id) {
		const row = await db.query<{ id: string; identifier: string; title: string }>(
			'SELECT id, identifier, title FROM issues WHERE id = $1',
			[issue.parent_issue_id],
		);
		if (row.rows.length > 0) parent = row.rows[0];
	}

	if (!spawningIssue && !parent) return null;

	if (parent && spawningIssue && parent.id === spawningIssue.id) {
		return {
			parentLine: `**Parent ticket:** ${parent.identifier} — ${parent.title}`,
			spawnLine: null,
		};
	}
	return {
		parentLine: parent ? `**Parent ticket:** ${parent.identifier} — ${parent.title}` : null,
		spawnLine: spawningIssue
			? `**Spawned from:** ${spawningIssue.identifier} — ${spawningIssue.title} (provenance only; this ticket is your own work)`
			: null,
	};
}

export async function buildCoachReviewPrompt(
	db: PGlite,
	systemPrompt: string,
	issue: IssueInfo,
	companyId: string,
): Promise<string> {
	const comments = await db.query<{
		content_type: string;
		content: Record<string, unknown>;
		author_name: string;
		created_at: string;
	}>(
		`SELECT ic.content_type, ic.content,
		        COALESCE(ma.title, m.display_name, 'Unknown') AS author_name,
		        ic.created_at::text
		 FROM issue_comments ic
		 LEFT JOIN members m ON m.id = ic.author_member_id
		 LEFT JOIN member_agents ma ON ma.id = ic.author_member_id
		 WHERE ic.issue_id = $1
		 ORDER BY ic.created_at ASC`,
		[issue.id],
	);

	const involvedAgents = await db.query<{
		id: string;
		title: string;
		slug: string;
	}>(
		`SELECT DISTINCT ma.id, ma.title, ma.slug
		 FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.company_id = $1
		   AND (ma.id = (SELECT assignee_id FROM issues WHERE id = $2)
		        OR ma.id IN (SELECT DISTINCT author_member_id FROM issue_comments WHERE issue_id = $2 AND author_member_id IS NOT NULL))`,
		[companyId, issue.id],
	);

	const commentLog = comments.rows
		.map((c) => {
			const text =
				c.content_type === 'text'
					? (c.content as Record<string, unknown>).text
					: JSON.stringify(c.content);
			return `[${c.created_at}] ${c.author_name} (${c.content_type}): ${text}`;
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
		`## Review Completed Ticket: ${issue.identifier} — ${issue.title}`,
		`**Final Status:** ${issue.status}`,
		`**Priority:** ${issue.priority}`,
		'',
		'### Description',
		issue.description || 'No description provided.',
		'',
		'### Agents Involved',
		agentList || 'No agents identified.',
		'',
		'### Comment History',
		commentLog || 'No comments on this issue.',
		'',
		'### Your Task',
		'Review this completed ticket. Analyze the comment history for patterns where agents struggled,',
		'received feedback, had work rejected, or needed multiple attempts. For each improvement opportunity,',
		"use the `get_agent_system_prompt` tool to read the affected agent's current prompt, then use",
		'`update_agent_system_prompt` to add a specific rule to their `## Learned Rules` section. Updates',
		'apply immediately and a revision snapshot is recorded so the board can roll back from the agent',
		'settings page if needed.',
		'',
		'If the ticket completed smoothly without significant rework or feedback, no changes are needed.',
		'',
		'### Final Step',
		`Post the review summary comment on ${issue.identifier} now, following the format defined in your system prompt.`,
	];

	return parts.join('\n');
}

export interface HeartbeatRunBroadcast {
	wsManager?: WebSocketManager;
	companyId: string;
	issueId: string;
	memberId: string;
}

function broadcastHeartbeatRunChange(
	ctx: HeartbeatRunBroadcast,
	runId: string,
	status: string,
	action: 'INSERT' | 'UPDATE',
): void {
	if (!ctx.wsManager) return;
	broadcastRowChange(ctx.wsManager, wsRoom.company(ctx.companyId), 'heartbeat_runs', action, {
		id: runId,
		issue_id: ctx.issueId,
		company_id: ctx.companyId,
		member_id: ctx.memberId,
		status,
	});
}

export async function createHeartbeatRun(
	db: PGlite,
	agent: AgentInfo,
	issue: IssueInfo,
	broadcast: HeartbeatRunBroadcast,
	wakeupId: string,
): Promise<string> {
	await db.query('BEGIN');
	let runId: string;
	let statusFlippedToInProgress = false;
	try {
		const runResult = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, company_id, issue_id, wakeup_id, status)
			 VALUES ($1, $2, $3, $4, $5::heartbeat_run_status)
			 RETURNING id`,
			[agent.id, agent.company_id, issue.id, wakeupId, HeartbeatRunStatus.Queued],
		);
		runId = runResult.rows[0].id;

		await db.query(
			`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
			 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)`,
			[
				issue.id,
				agent.id,
				CommentContentType.Run,
				JSON.stringify({ run_id: runId, agent_id: agent.id, agent_title: agent.title }),
			],
		);

		if (issue.assignee_id === agent.id && issue.status === IssueStatus.Backlog) {
			const updated = await db.query<{ id: string }>(
				`UPDATE issues
				    SET status = $1::issue_status, updated_at = now()
				  WHERE id = $2 AND status = $3::issue_status
				  RETURNING id`,
				[IssueStatus.InProgress, issue.id, IssueStatus.Backlog],
			);
			if (updated.rows.length > 0) {
				statusFlippedToInProgress = true;
				issue.status = IssueStatus.InProgress;
			}
		}

		await db.query('COMMIT');
	} catch (e) {
		await db.query('ROLLBACK');
		throw e;
	}

	broadcastHeartbeatRunChange(broadcast, runId, HeartbeatRunStatus.Queued, 'INSERT');
	if (broadcast.wsManager) {
		broadcastRowChange(
			broadcast.wsManager,
			wsRoom.company(broadcast.companyId),
			'issue_comments',
			'INSERT',
			{
				issue_id: issue.id,
			},
		);
		if (statusFlippedToInProgress) {
			broadcastRowChange(
				broadcast.wsManager,
				wsRoom.company(broadcast.companyId),
				'issues',
				'UPDATE',
				{
					id: issue.id,
					company_id: broadcast.companyId,
					status: IssueStatus.InProgress,
				},
			);
		}
	}
	if (statusFlippedToInProgress) {
		await recordStatusChange(
			db,
			broadcast.companyId,
			issue.id,
			IssueStatus.Backlog,
			IssueStatus.InProgress,
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
}
