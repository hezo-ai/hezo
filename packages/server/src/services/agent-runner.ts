import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import {
	AGENT_RUNTIME_LABELS,
	type AgentEffort,
	type AgentRuntime,
	AiAuthMethod,
	type AiProvider,
	CommentContentType,
	ContainerStatus,
	type CostTokens,
	credentialSerializesRuns,
	DEFAULT_THREAD_ROW_CATEGORIES,
	effectiveRuntime,
	formatContainerMetaLogLine,
	formatRunLink,
	HeartbeatRunKind,
	HeartbeatRunStatus,
	MAX_SINGLE_ARG_BYTES,
	PROVIDER_RUNTIME_ADAPTERS,
	type PromptDelivery,
	providerDirectUpstreamHosts,
	providerRuntimeBinding,
	QueuedRunReason,
	RUNTIME_AUTO_APPROVE_ARGS,
	RUNTIME_COMMANDS,
	RUNTIME_DISALLOWED_TOOLS_ARGS,
	RUNTIME_HEADLESS_PREFIX_ARGS,
	RUNTIME_HEADLESS_SUFFIX_ARGS,
	RUNTIME_MODEL_DELIVERY,
	RUNTIME_PROMPT_DELIVERY,
	RUNTIME_STREAM_ARGS,
	RUNTIME_SYSTEM_PROMPT_FILE,
	type RunLink,
	repoNameFromIdentifier,
	TaskStatus,
	TERMINAL_TASK_STATUSES,
	type ThreadRowCategory,
	WakeupSkipReason,
	WakeupSource,
	WsMessageType,
	wsRoom,
} from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import { appendRunLogChunks, runLogLengthSql } from '../db/run-log-chunks';
import type { DomainEventBus } from '../events/bus';
import { signAgentAssetUrl } from '../lib/asset-urls';
import { trackBackground } from '../lib/background';
import { broadcastProjectUpdate, broadcastRowChange } from '../lib/broadcast';
import { commentCategoryPredicate } from '../lib/comment-filters';
import { describeSignalExit, signalFromExitCode } from '../lib/exit-code';
import { withProjectGitLock } from '../lib/git-lock';
import {
	type AcquireOptions,
	acquireKeyedLock,
	currentOwner,
	type KeyedLockRegistry,
	KeyedLockTimeoutError,
} from '../lib/keyed-lock';
import {
	detectPassiveTeammateAsks,
	detectUnlinkedTeammateAsks,
	extractMentionSlugs,
} from '../lib/mentions';
import { terminalStatusParams, withTransaction } from '../lib/sql';
import { logger } from '../logger';
import { signAgentJwt } from '../middleware/auth';
import { pauseAgentForBudget } from './agent-runtime-status';
import {
	type AgentRunUsage,
	createAgentStreamParser,
	extractGrokUsageFromDebugLog,
	extractKimiUsageFromSessionLog,
} from './agent-stream-parser';
import {
	type AiProviderCredential,
	getProviderCredentialAndModel,
	readAiProviderCredentialValue,
	updateAiProviderCredential,
} from './ai-provider-keys';
import { BackgroundTerminationDetector } from './background-termination';
import { checkOverBudget, recordRunCost } from './budget';
import {
	detectNoWakeExits,
	formatNoWakeExitWarning,
	postAgentComment,
	resolveWarnableSlugs,
} from './comment-wakeups';
import { loadConnectorDescriptors } from './connectors/connections';
import { describeConnectorRejection, recheckRejectedConnector } from './connectors/run-rejection';
import type { ContainerLogStreamer } from './container-logs';
import {
	type ContainerRunUser,
	chownToRunUser,
	containerHomeDir,
	ensureContainerDirReady,
	resolveContainerRunUser,
} from './container-user';
import { acquireRunContainer, PoolCapacityError } from './containers';
import type { ContainerEngine, ExecLogChunk } from './docker';
import { getAgentSystemPrompt } from './documents';
import { type EffortRuntimeApplication, resolveEffort } from './effort';
import { buildEgressProxyEnv, type EgressProxy } from './egress';
import {
	clearPushErrors,
	countBranchDelivery,
	describeUnpushedWork,
	ensurePushHook,
	ensureTaskWorktreeWithRetry,
	fastForwardFromRecovery,
	fastForwardLocalDefault,
	fetchRepo,
	findUnpushedWork,
	getWorktreeHead,
	mergeDefaultIntoWorktree,
	type RepoLoc,
	readPushErrors,
	readPushedMarker,
	seedInitialCommitIfEmpty,
	type UnpushedWorkScan,
	voidPushedMarker,
	type WorktreeLoc,
	worktreeChangedPaths,
	worktreeHasChanges,
	worktreeTracksPath,
} from './git';
import { ContainerGitExecutor, type GitExecutor } from './git-executor';
import { buildGitIdentityEnv } from './git-identity';
import type { LogStreamBroker } from './log-stream-broker';
import { retryOrEscalateLostRun, STALE_STATE_GRACE_SECONDS } from './orphan-detector';
import type { PricingService } from './pricing';
import type { ProgressActivityCandidates, ProgressActivityKind } from './project-activity';
import { loadReactionsForTask, type ReactionGroup } from './reactions';
import { checkRepoCommitMerged } from './repo-github';
import { ensureProjectRepos } from './repo-sync';
import { CAPACITY_PARK_QUEUED_REASON, projectContainerMemoryGb } from './run-concurrency';
import { classifyRunFailure, RunFailureClass } from './run-failure-classification';
import {
	applyEffortToRuntime,
	buildMcpInjection,
	HEZO_MCP_SERVER_NAME,
	type McpDescriptor,
	RUNTIME_ADAPTERS,
	type RuntimeEnvContext,
} from './runtime-adapters';
import {
	buildSubscriptionMount as buildSubscriptionMountImpl,
	ensureRuntimeHomeDir,
	getContainerSubscriptionRoot as getContainerSubscriptionRootImpl,
	getHostSubscriptionBase,
	getHostSubscriptionRoot as getHostSubscriptionRootImpl,
	persistRotatedSubscriptionAuth,
	RUNTIME_HOME_LAYOUTS,
	type RuntimeHomeMount,
	SUBSCRIPTION_DIR_MODE,
	type SubscriptionMount as SubscriptionMountImpl,
	subscriptionFiles,
} from './runtime-home';
import { resolveRuntimeForTask } from './runtime-resolver';
import { createBundleVault } from './sandbox/bundle-vault';
import { PREFLIGHT_TUNNEL_ENDPOINTS, type RunEndpoints } from './sandbox/endpoints';
import type { SandboxFiles } from './sandbox/files';
import { dockerSandboxHandle } from './sandbox/handle';
import { setPoolMemberDiskUsage, setPoolMemberUnpushedFlag } from './sandbox/pool-db';
import {
	releaseRecoveryBundle,
	restoreRecoveryBundle,
	saveRecoveryBundle,
} from './sandbox/recovery';
import { type RunTunnel, startRunTunnel } from './sandbox/tunnel/run-tunnel';
import { buildTunnelHostPolicy } from './sandbox/tunnel/split-routing';
import { collectFinishedWorktrees } from './sandbox/worktree-gc';
import { type BridgeRunnerArgs, buildBridgeRunnerArgv, type SshAgentServer } from './ssh-agent';
import { validateSubscriptionBlob } from './subscription-auth';
import { recordStatusChange } from './task-events';
import { resolveSystemPrompt } from './template-resolver';
import {
	CONTAINER_WORKSPACE_ROOT,
	CONTAINER_WORKTREES_ROOT,
	getRunSocketPath,
	getWorkspacePath,
	getWorktreesPath,
} from './workspace';
import type { WebSocketManager } from './ws';

const log = logger.child('agent-runner');

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
	container_id: string | null;
	container_status: string | null;
	designated_repo_id: string | null;
	is_internal: boolean;
}

/**
 * ProjectInfo once the runner has ensured the project container is running —
 * containers start on demand at run start, so callers may hand runAgent a
 * project whose container is stopped or was never provisioned.
 */
type RunningProjectInfo = ProjectInfo & { container_id: string };

export interface RunResult {
	success: boolean;
	exitCode: number;
	/**
	 * Failure text for the run, not the exec's stderr — a streamed exec retains
	 * no output at all (see `ExecStartOpts.onChunk`). Empty on success.
	 */
	stderr: string;
	durationMs: number;
	heartbeatRunId?: string;
	/** The run ended by hitting its wall-clock time limit; drives an automatic same-task continuation. */
	timedOut?: boolean;
	/**
	 * The run never started because the instance was busy, and handed its work
	 * back. Not a failure: the wakeup is re-queued and dispatched again, and no
	 * failure ping is posted. Two waits reach it - the container-memory budget and
	 * the rotating provider credential - so the cause travels beside it rather
	 * than being assumed.
	 */
	requeued?: boolean;
	/** Which wait gave up, so the queued wakeup reports the real reason it is waiting. */
	requeueReason?: WakeupSkipReason;
}

export interface RunnerDeps {
	db: Db;
	docker: ContainerEngine;
	masterKeyManager: MasterKeyManager;
	serverPort: number;
	dataDir: string;
	wsManager?: WebSocketManager;
	events?: DomainEventBus;
	logs: LogStreamBroker;
	sshAgentServer?: SshAgentServer;
	egressProxy?: EgressProxy | null;
	egressCAPath?: string | null;
	/** When present, a container the runner lazy-starts resubscribes its log stream. */
	containerLogStreamer?: ContainerLogStreamer;
	/** Runtime model pricing; when present, the parser computes run cost from it. */
	pricing?: PricingService;
	/**
	 * How long a run blocked on container capacity waits, and how often it
	 * re-tries. Defaults to {@link CAPACITY_PARK_POLL_MS} /
	 * {@link CAPACITY_PARK_MAX_MS}; overridden only by tests, which cannot
	 * otherwise reach a wait measured in minutes.
	 */
	capacityPark?: { pollMs: number; maxMs: number };
}

interface RepoRow {
	id: string;
	repo_identifier: string;
}

/**
 * A prepared clone, carrying the `repos` row it came from.
 *
 * The id rides along rather than being looked up again at finalize because the one
 * check that needs it - asking the git host what became of a branch the remote no
 * longer advertises - has only a container path to go on otherwise, and matching a
 * path back to a row by name is a second source of truth for something already known
 * here. Structurally still a {@link RepoLoc}, so every existing consumer is unchanged.
 */
type CloneRef = RepoLoc & { repoId: string };

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
export function buildProviderEnv(
	provider: AiProvider,
	credential: AiProviderCredential,
	runModel?: string | null,
): string[] {
	// Everything below keys off the runtime the credential actually runs on, not
	// the provider's default: a provider can be configured onto any of several
	// CLIs, and each wants a different static bag and a different variable for the
	// key. Reading the adapter's own fields would build the default runtime's env
	// for a switched credential, which fails as "no credentials found" rather than
	// as anything diagnosable.
	const runtime = effectiveRuntime(provider, credential.runtime);
	const binding = runtime ? providerRuntimeBinding(provider, runtime) : null;
	const adapter = runtime ? RUNTIME_ADAPTERS[runtime] : null;
	const envCtx: RuntimeEnvContext = {
		provider,
		runModel: runModel?.trim() || null,
		baseUrl: credential.baseUrl ?? null,
	};
	const out: string[] = [];
	// What this CLI needs regardless of provider, then the provider's own bag with
	// the CLI given a say over each value, then whatever the credential itself
	// implies. Which entries any of those are is the adapter's business - this
	// function composes them and never asks which runtime it is building for.
	for (const [key, value] of Object.entries(adapter?.constantEnv ?? {})) {
		out.push(`${key}=${value}`);
	}
	for (const [key, value] of Object.entries(binding?.staticEnv ?? {})) {
		out.push(`${key}=${adapter?.staticEnvValue?.(key, value, envCtx) ?? value}`);
	}
	out.push(...(adapter?.credentialEnv?.(envCtx) ?? []));
	const varName = binding?.credentialEnvByAuthMethod[credential.authMethod];
	if (varName) out.push(`${varName}=${credential.value}`);
	return out;
}

// RUNTIME_HOME_LAYOUTS, SubscriptionMount, and the home-dir helpers live in
// runtime-home.ts so per-runtime config conventions sit in one place. These
// re-exports keep the public import surface stable for callers and tests.
export type SubscriptionMount = SubscriptionMountImpl;
export const buildSubscriptionMount = buildSubscriptionMountImpl;
export const getContainerSubscriptionRoot = getContainerSubscriptionRootImpl;
export const getHostSubscriptionRoot = getHostSubscriptionRootImpl;

/**
 * Some subscription credentials carry a single-use refresh token (Codex), so
 * two parallel runs against the same credential would mutually invalidate each
 * other. Runs serialise on the credential row's id when the provider's refresh
 * token rotates.
 *
 * Held for the whole run rather than for the token read alone: the CLI rewrites
 * the file at a moment of its own choosing, and the rotated value is read back
 * and persisted during teardown. A waiter therefore queues behind a complete
 * run - which is why the wait is bounded, and why it is taken before a container
 * rather than after.
 */
const credentialLocks: KeyedLockRegistry<CredentialLockHolder> = new Map();

/**
 * Who holds a rotating credential: a name for the sentence a waiter writes, and
 * the run behind it when there is one, so that sentence can point at it. The
 * CEO chat holds it too and has no run page, so it carries a name alone.
 */
export interface CredentialLockHolder {
	label: string;
	link: RunLink | null;
}

/**
 * Take the credential lock, resolving to the function that gives it back.
 *
 * A bounded wait is the point: this used to be an unbounded promise chain, so a
 * holder that never returned parked every later run on the credential forever,
 * with nothing to time it out, cancel it or say what it was waiting on.
 */
export function acquireCredentialLock(
	configId: string,
	opts: AcquireOptions<CredentialLockHolder> = {},
): Promise<() => void> {
	return acquireKeyedLock(credentialLocks, configId, opts);
}

/** What holds this credential right now, for a waiter to name. */
export function credentialLockHolder(configId: string): CredentialLockHolder | null {
	return currentOwner(credentialLocks, configId);
}

/**
 * The holder as a waiter writes it: the run as a link to its page where there is
 * one, else the bare label. The one place the wording of "who" is decided, so a
 * run log and a chat notice name the holder identically.
 */
export function describeCredentialHolder(holder: CredentialLockHolder): string {
	return holder.link ? formatRunLink(holder.label, holder.link) : holder.label;
}

/** The sentence a waiter writes - to its run log, or into a chat thread - while it queues. */
export function credentialWaitNotice(holder: CredentialLockHolder): string {
	return `Waiting for ${describeCredentialHolder(holder)} to finish with this credential.`;
}

export interface RunContext {
	cmd: string[];
	execCmd: string[];
	env: string[];
	taskPrompt: string;
	promptFilePath: string;
	/** The CLI this run launches, after provider/credential/task-pin resolution. */
	runtimeType: AgentRuntime;
	/** How the runtime receives {@link taskPrompt} - see RUNTIME_PROMPT_DELIVERY. */
	promptDelivery: PromptDelivery;
	effort: AgentEffort;
	effortApplication: EffortRuntimeApplication;
	agentJwt: string;
	subscriptionMount: SubscriptionMount | null;
	/**
	 * Per-run runtime config dir. Reuses the subscription mount when present;
	 * otherwise a freshly created dir for runtimes that need one (Codex) even when
	 * authenticating with an API key. Null when the runtime takes its MCP config
	 * via CLI flags (Claude Code) or from the container home (Antigravity).
	 */
	homeMount: RuntimeHomeMount | null;
	/**
	 * Paths (relative to the container run-user's home) of home-rooted config
	 * files carrying a per-run secret, scrubbed after the run (Antigravity's
	 * mcp_config.json holds the agent JWT).
	 */
	homeConfigScrubPaths: string[];
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
	return join(getWorkspacePath(dataDir, teamId, projectId), getPromptRelPath(heartbeatRunId));
}

/**
 * The prompt file's path *relative to the workspace root*, which is the form a
 * {@link SandboxFiles} takes. The absolute host path above is derived from it
 * rather than the other way round, so the two can never disagree about where
 * the file is - the bug a second hand-written join would eventually introduce.
 */
export function getPromptRelPath(heartbeatRunId: string): string {
	return join('.hezo', 'prompts', `${heartbeatRunId}.txt`);
}

/**
 * Refuse a prompt that cannot physically reach its CLI.
 *
 * An `'arg'`-delivery runtime receives the prompt as one argv element, and Linux
 * caps a single element at MAX_ARG_STRLEN. Past it the exec dies with a bare
 * `Argument list too long` from `sh`, before the CLI starts and with nothing in
 * the run log naming the cause. Fail here instead, loudly and by name - never by
 * truncating the prompt or quietly rerouting it (see AGENTS.md § One mechanism,
 * no silent fallbacks).
 *
 * Called by both prompt writers (the task runner and the chat session manager);
 * `buildRuntimeInvocation` cannot host it, since it knows the prompt's path but
 * not its text.
 */
export function assertPromptDeliverable(runtime: AgentRuntime, prompt: string): void {
	if (RUNTIME_PROMPT_DELIVERY[runtime] !== 'arg') return;
	const bytes = Buffer.byteLength(prompt, 'utf8');
	if (bytes < MAX_SINGLE_ARG_BYTES) return;
	throw new Error(
		`prompt is ${bytes} bytes, but ${AGENT_RUNTIME_LABELS[runtime]} takes it as a single ` +
			`command-line argument, which Linux caps at ${MAX_SINGLE_ARG_BYTES} bytes ` +
			`(MAX_ARG_STRLEN). The exec would fail with "Argument list too long" before the CLI ` +
			`started. Shorten the task description and its recent comments, or move this agent ` +
			`to a runtime that reads the prompt from a file or stdin.`,
	);
}

// Basename of Kimi Code's per-session wire log, written under
// `$KIMI_CODE_HOME/sessions/<workspace>/<session>/agents/<agent>/`. Kimi Code's
// `stream-json` stdout carries no token usage at all, so — as with Grok — cost is
// recovered from this file. The path depth is an upstream implementation detail,
// so the runner searches the per-run home rather than reconstructing it.
const KIMI_SESSION_LOG_BASENAME = 'wire.jsonl';

// Depth cap for the wire-log search. The real path sits 5 levels below the home
// dir; 8 leaves room for an upstream layout change without ever letting a
// symlink loop or a surprise `node_modules` turn run teardown into a full-disk
// walk.
const KIMI_SESSION_LOG_MAX_DEPTH = 8;

/**
 * Recover a run's token usage for the runtimes that report none on stdout.
 *
 * Two runtimes need this and they need it for the same structural reason — their
 * stream carries no usage — so the dispatch lives here rather than being copied
 * per runtime:
 *
 *   - **Grok** — the per-run `--debug-file`.
 *   - **Kimi Code** — the per-session `wire.jsonl` under the per-run home.
 *
 * Both files are scrubbed after parsing: Grok's holds the XAI_API_KEY in
 * plaintext, and a "wire" log plausibly captures request headers (i.e. the
 * Moonshot bearer token), so neither should outlive the run on the host.
 *
 * Returns null for every other runtime, so the caller keeps the parser's stream
 * usage. Best-effort throughout: a missing or unreadable log yields null (⇒ $0
 * rather than a failed run), and the home mount is removed at cleanup regardless.
 */
export async function recoverOffStreamRunUsage(
	runtimeType: AgentRuntime,
	files: SandboxFiles | null,
	priceFn: ((model: string | undefined, tokens: CostTokens) => number) | undefined,
	onError: (msg: string) => void,
): Promise<AgentRunUsage | null> {
	if (!files) return null;
	const recover = RUNTIME_ADAPTERS[runtimeType].recoverUsage;
	if (!recover) return null;
	return recover({ files, price: priceFn, onError });
}

// Deliver the prompt one of three ways, selected per runtime via the
// HEZO_PROMPT_MODE env var — see RUNTIME_PROMPT_DELIVERY. The bridge wrapper
// script (docker/scripts/hezo-run-with-bridge) mirrors this exactly, and
// agent-prompt-delivery.test.ts runs both texts through the same cases so they
// cannot drift.
//
//   arg   — the prompt's TEXT becomes a trailing argv element (Kimi Code `-p`).
//   file  — the CLI opens the file itself (Grok `--prompt-file <path>`); the flag
//           AND the path are already in the server-built argv, so nothing is
//           appended here.
//   stdin — default: the prompt file IS the CLI's stdin.
//
// **Both non-stdin branches close stdin, and must.** An exec leaves the container
// process's stdin attached to a pipe nothing ever writes to and nothing ever
// closes, so a CLI that reads it in headless mode blocks forever — no output, no
// exit, no error, indistinguishable from a slow model until the run's deadline.
// Measured against a CLI that does read it: byte-identical invocations produced a
// full stream-json transcript in ~2s with `< /dev/null` and nothing at all in 15
// minutes without it. In both branches the prompt has already reached the CLI by
// another route, so there is by definition nothing stdin can legitimately carry.
export const PROMPT_DELIVERY_SH =
	'case "${HEZO_PROMPT_MODE:-stdin}" in arg) exec "$@" "$(cat "$HEZO_PROMPT_FILE")" < /dev/null ;; file) exec "$@" < /dev/null ;; *) exec "$@" < "$HEZO_PROMPT_FILE" ;; esac';

function wrapExecCmd(cmd: string[], bridge: BridgeRunnerArgs | null): string[] {
	if (bridge) {
		return [...buildBridgeRunnerArgv(bridge), ...cmd];
	}
	return ['sh', '-c', PROMPT_DELIVERY_SH, 'sh', ...cmd];
}

export interface EgressEnvDescriptor {
	host: string;
	port: number;
	containerCAPath: string;
	/** Per-run proxy token, or `null` when egress-proxy auth is disabled. */
	token: string | null;
}

export interface RuntimeInvocation {
	env: string[];
	cmd: string[];
	execCmd: string[];
	subscriptionMount: SubscriptionMount | null;
	homeMount: RuntimeHomeMount | null;
	/** Home-rooted config files carrying a per-run secret, to scrub after the run. */
	homeConfigScrubPaths: string[];
}

export interface RuntimeInvocationInput {
	deps: RunnerDeps;
	/** The team the run/session executes against (project's team). */
	runTeamId: string;
	projectId: string;
	provider: AiProvider;
	credential: AiProviderCredential;
	runtimeType: AgentRuntime;
	/** Pre-minted MCP bearer token (run token for a task run; session token for chat). */
	agentJwt: string;
	agentId: string;
	/** Keys the per-resource home/subscription/config dirs — heartbeatRunId or sessionId. */
	resourceId: string;
	/** The project container the run executes in (target of the run-user chown). */
	containerId: string;
	/** Detected container run-user; the per-run config dir is chowned to it so the
	 *  non-root agent CLI can read the host-written settings/credentials. */
	runUser: ContainerRunUser;
	/** Container path the prompt file is written to - see RUNTIME_PROMPT_DELIVERY. */
	promptContainerPath: string;
	/**
	 * The run's resolved system prompt, for a runtime whose
	 * {@link RUNTIME_SYSTEM_PROMPT_FILE} entry routes it to an instructions file
	 * instead of the prompt body. Callers that inline it in the prompt pass null.
	 */
	systemPrompt?: string | null;
	effort: AgentEffort;
	effortApplication: EffortRuntimeApplication;
	modelOverride: string | null;
	sshSocketContainerPath: string | null;
	bridge: BridgeRunnerArgs | null;
	egress: EgressEnvDescriptor | null;
	/**
	 * How the container addresses Hezo. Passed in rather than derived so the run
	 * path can hand over the tunnel's loopback endpoints without this function
	 * learning that a tunnel exists.
	 */
	endpoints: RunEndpoints;
	/**
	 * The project's connector MCP servers.
	 *
	 * Passed in rather than loaded here because the caller needs them *before*
	 * this runs: the tunnel's split-routing policy has to name the connector hosts
	 * so they reach the egress proxy, where the per-connector method allowlist is
	 * enforced. Resolving them once and handing them down also keeps the policy
	 * and the descriptors describing the same set - two loads a moment apart could
	 * disagree, and the one that silently lost a host would be the policy.
	 */
	connectorDescriptors: McpDescriptor[];
	/** Caller-specific env entries (e.g. HEZO_TASK_ID for a run). */
	extraEnv?: string[];
	/**
	 * Whether this invocation gets the completeness Stop-hook judge. Defaults to
	 * true (every task run); the CEO chat passes false. See
	 * {@link McpAdapterContext.stopJudge}.
	 */
	stopJudge?: boolean;
}

/**
 * Assemble the container env vars and CLI invocation shared by every runtime
 * launch — provider credentials, MCP injection (with the caller's bearer token),
 * the per-resource runtime config dir, ssh/git identity, egress proxy, and the
 * headless command. Used by both the one-shot task run path ({@link buildRunContext})
 * and the persistent CEO chat session, so a change to how a runtime is launched
 * applies to both. Writes the MCP/settings files to disk as a side effect.
 */
export async function buildRuntimeInvocation(
	input: RuntimeInvocationInput,
): Promise<RuntimeInvocation> {
	const {
		deps,
		runTeamId,
		projectId,
		provider,
		credential,
		runtimeType,
		agentJwt,
		agentId,
		resourceId,
		containerId,
		runUser,
		promptContainerPath,
		systemPrompt = null,
		effort,
		effortApplication,
		modelOverride,
		sshSocketContainerPath,
		bridge,
		egress,
		endpoints,
		connectorDescriptors,
		extraEnv = [],
		stopJudge = true,
	} = input;

	const subscriptionMount = await buildSubscriptionMount(
		deps.dataDir,
		runTeamId,
		projectId,
		resourceId,
		provider,
		runtimeType,
		credential,
		deps.docker,
		containerId,
	);

	const adapter = RUNTIME_ADAPTERS[runtimeType];
	const homeMount: RuntimeHomeMount | null = adapter.capabilities.requiresHomeDir
		? await ensureRuntimeHomeDir(
				provider,
				runtimeType,
				deps.dataDir,
				runTeamId,
				projectId,
				resourceId,
				subscriptionMount,
				deps.docker,
				containerId,
			)
		: null;

	const mcpDescriptors: McpDescriptor[] = [
		{
			kind: 'http',
			name: HEZO_MCP_SERVER_NAME,
			url: `${endpoints.hezoBaseUrl}/mcp`,
			bearerToken: agentJwt,
		},
		...connectorDescriptors,
	];

	// Active project-doc filenames, baked into the runtime's doc-write guard so it
	// can refuse a filesystem write aimed at one without needing any tool access
	// of its own. Advisory: a failed lookup just means no guard on this run.
	const projectDocSlugs = await deps.db
		.query<{ slug: string }>(
			`SELECT slug FROM documents
			 WHERE type = 'project_doc' AND project_id = $1 AND archived_at IS NULL`,
			[projectId],
		)
		.then((r) => r.rows.map((row) => row.slug))
		.catch(() => [] as string[]);

	const mcpInjection = buildMcpInjection(runtimeType, mcpDescriptors, {
		hostHomeDir: homeMount?.hostDir ?? null,
		containerHomeDir: homeMount?.containerDir ?? null,
		provider,
		runModel: modelOverride,
		effort,
		projectDocSlugs,
		stopJudge,
		systemPrompt,
	});

	// Through SandboxFiles, rooted at the subscription base: the container reads
	// these, so on a backend whose container is not on this machine the write has
	// to go through the provider's file API. `dirMode` is what keeps the
	// other-execute bit the non-root run-user needs to traverse down to this leaf,
	// which a strict process umask would otherwise strip.
	const runtimeFiles = subscriptionFiles(deps.docker, containerId);
	const subscriptionBase = getHostSubscriptionBase(deps.dataDir, runTeamId, projectId);
	for (const file of mcpInjection.files) {
		await runtimeFiles.write(relative(subscriptionBase, file.hostPath), file.contents, {
			mode: file.mode,
			dirMode: SUBSCRIPTION_DIR_MODE,
		});
	}

	// The host (root in production) just wrote the per-run config dir + files at
	// restrictive modes; give the container's non-root run-user ownership so the
	// agent CLI can read them (settings/MCP config, judge script) and rewrite any
	// rotating subscription credential. Runs in-container as root (needs no host
	// privilege); a no-op when the run-user is root.
	if (homeMount) {
		await chownToRunUser(deps.docker, containerId, runUser, [homeMount.containerDir], {
			recursive: true,
		});
	}

	// Config files a CLI reads only from its real `$HOME` (the Antigravity CLI's
	// `~/.gemini`), written straight into the run user's home rather than a per-run
	// dir. Safe because one run holds a container at a time; the per-run MCP config
	// is scrubbed after the run (below). Chowned so the non-root run-user can read
	// what the host wrote.
	const homeConfigFiles = mcpInjection.homeConfigFiles ?? [];
	const homeConfigScrubPaths: string[] = [];
	if (homeConfigFiles.length > 0) {
		const home = containerHomeDir(runUser);
		const homeFiles = deps.docker.files(containerId, home);
		const chownPaths: string[] = [];
		for (const file of homeConfigFiles) {
			await homeFiles.write(file.relativePath, file.contents, {
				mode: file.mode,
				dirMode: SUBSCRIPTION_DIR_MODE,
			});
			chownPaths.push(join(home, file.relativePath));
			if (file.scrubAfterRun) homeConfigScrubPaths.push(file.relativePath);
		}
		await chownToRunUser(deps.docker, containerId, runUser, chownPaths);
	}

	const env: string[] = [
		`HEZO_AGENT_TOKEN=${agentJwt}`,
		`HEZO_AGENT_ID=${agentId}`,
		`HEZO_HEARTBEAT_RUN_ID=${resourceId}`,
		`HEZO_TEAM_ID=${runTeamId}`,
		`HEZO_AGENT_EFFORT=${effort}`,
		`HEZO_PROMPT_FILE=${promptContainerPath}`,
		`HEZO_PROMPT_MODE=${RUNTIME_PROMPT_DELIVERY[runtimeType]}`,
		...extraEnv,
		...effortApplication.extraEnv,
		...buildProviderEnv(provider, credential, modelOverride),
		// Subscription mount sets the runtime HOME env var when present; otherwise
		// fall through to the home-mount entry so the runtime CLI finds its
		// per-run config dir even without a subscription credential.
		...(subscriptionMount?.envEntries ?? (homeMount ? [homeMount.envEntry] : [])),
		...mcpInjection.envEntries,
	];
	// The agent socket is for commit *signing* (`ssh-keygen -Y sign`), which is
	// local. Git transport is HTTPS and needs no ssh at all, so there is no
	// `GIT_SSH_COMMAND` to set alongside it any more.
	if (sshSocketContainerPath) {
		env.push(`SSH_AUTH_SOCK=${sshSocketContainerPath}`);
	}
	// Configure git author/committer identity and SSH commit signing from the
	// team's connected GitHub account + Ed25519 key, so in-container commits
	// don't fail for lack of an author and land Verified via the agent socket.
	env.push(
		...(await buildGitIdentityEnv(deps.db, deps.masterKeyManager, {
			projectId,
			teamId: runTeamId,
		})),
	);
	if (egress) {
		env.push(
			// The same entries every in-container git op gets, from the same builder -
			// a run's agent CLI and its `git clone` reach the proxy identically.
			// For a locally-hosted provider the upstream is the operator's own machine,
			// known only from the config's stored base URL — pass it so that host
			// bypasses the MITM proxy like any other model-provider endpoint.
			// The resolved runtime, not the provider's default: a credential switched
			// onto another CLI can reach a different upstream, so the direct-host list
			// has to be read off the pairing that will actually run.
			...buildEgressProxyEnv(
				egress,
				providerDirectUpstreamHosts(provider, credential.baseUrl, runtimeType),
			),
			// Defense-in-depth: make Node's *built-in* global fetch/undici honor the
			// proxy env vars for any Node process the agent spawns that doesn't set
			// its own dispatcher. Node ≥24 gates this behind NODE_USE_ENV_PROXY; it
			// respects NO_PROXY, so LLM-provider traffic still goes direct.
			//
			// Connector auth rides an egress-substituted `__HEZO_SECRET_*__`
			// placeholder (AGENTS.md red line — never a materialized token), so every
			// runtime's *connector* MCP HTTP MUST traverse the proxy or the placeholder
			// 401s (the Hezo-local MCP on host.docker.internal is NO_PROXY-exempt above:
			// it authenticates with a real JWT, not a placeholder). Each
			// of the four coding CLIs already ensures this on its own, so this var is a
			// safety net, not the load-bearing mechanism. The per-run token in the
			// proxy URL userinfo is carried as Proxy-Authorization by each client's
			// standard proxy handling (URL userinfo → Basic auth); a runtime that
			// somehow omitted it would 407 loudly rather than silently egressing
			// direct (auth failure ⊂ the same fail-closed posture as a missing proxy):
			//   • Claude Code & Gemini (Node): install their own global undici
			//     ProxyAgent/EnvHttpProxyAgent from HTTPS_PROXY at startup (this then
			//     overrides NODE_USE_ENV_PROXY for them — fine); undici sends userinfo
			//     as Proxy-Authorization; trust NODE_EXTRA_CA_CERTS.
			//   • OpenCode (bundled Bun, not Node): Bun's fetch reads HTTP(S)_PROXY
			//     natively incl. userinfo; trusts our single-cert NODE_EXTRA_CA_CERTS.
			//   • Codex & Grok (Rust/reqwest): honor HTTP(S)_PROXY incl. userinfo by
			//     default; ignore the Node/curl CA vars but fall back to the system
			//     trust store, into which the container's start-up
			//     `update-ca-certificates` installs the egress CA.
			`NODE_USE_ENV_PROXY=1`,
			// `NODE_EXTRA_CA_CERTS` is *additive* — Node keeps its bundled roots and
			// adds this one, so a direct TLS peer still verifies.
			//
			// `CURL_CA_BUNDLE` and `GIT_SSL_CAINFO` are deliberately NOT set, for the
			// same reason `SSL_CERT_FILE` is not: they **replace** the trust bundle
			// rather than adding to it. That is harmless only while every TLS peer is
			// the MITM proxy. Under split routing curl or git talking to a direct host
			// would check a real public certificate against a bundle holding only the
			// Hezo CA, and fail. Both rely instead on the `update-ca-certificates` run
			// at provision, which installs the CA *into* the system trust store so
			// both kinds of certificate verify.
			`NODE_EXTRA_CA_CERTS=${egress.containerCAPath}`,
		);
	}

	const cliCommand = RUNTIME_COMMANDS[runtimeType];
	// A CLI that spells model ids its own way says so on its adapter; one that
	// takes the stored id unchanged declares nothing and gets it unchanged.
	const cliModel =
		modelOverride && adapter.modelArg ? adapter.modelArg(provider, modelOverride) : modelOverride;
	// A runtime that selects its model from the environment gets no flag: on Kimi
	// Code `--model` looks the id up in a config table Hezo never writes, and the
	// run dies before reaching the model at all.
	const modelArgs =
		cliModel && RUNTIME_MODEL_DELIVERY[runtimeType] === 'flag' ? ['--model', cliModel] : [];

	// Whatever this CLI needs that no shared table can express - a path into its own
	// per-run home, typically. Most runtimes contribute nothing.
	const adapterArgs =
		adapter.extraArgs?.({ containerHomeDir: homeMount?.containerDir ?? null }) ?? [];

	// A 'file'-delivery CLI opens the prompt itself, so the flag's VALUE belongs in
	// the server-built argv rather than being appended by the exec wrapper. That is
	// what makes this version-skew-safe: an older in-image bridge script knowing
	// only arg/stdin falls through to `"$@" < "$HEZO_PROMPT_FILE"`, and the run is
	// still correct because argv is already complete.
	const promptFileArgs =
		RUNTIME_PROMPT_DELIVERY[runtimeType] === 'file' ? [promptContainerPath] : [];

	const cmd = [
		cliCommand,
		...RUNTIME_HEADLESS_PREFIX_ARGS[runtimeType],
		...mcpInjection.cliArgs,
		...RUNTIME_STREAM_ARGS[runtimeType],
		...adapterArgs,
		...RUNTIME_AUTO_APPROVE_ARGS[runtimeType],
		...RUNTIME_DISALLOWED_TOOLS_ARGS[runtimeType],
		...effortApplication.extraArgs,
		...modelArgs,
		...RUNTIME_HEADLESS_SUFFIX_ARGS[runtimeType],
		...promptFileArgs,
	];

	const execCmd = wrapExecCmd(cmd, bridge);

	return { env, cmd, execCmd, subscriptionMount, homeMount, homeConfigScrubPaths };
}

async function buildRunContext(
	deps: RunnerDeps,
	agent: AgentInfo,
	task: TaskInfo | null,
	project: RunningProjectInfo,
	wakeupPayload: Record<string, unknown> | undefined,
	credential: AiProviderCredential,
	provider: AiProvider,
	runtimeType: AgentRuntime,
	heartbeatRunId: string,
	modelOverride: string | null,
	sshSocketContainerPath: string | null,
	bridge: BridgeRunnerArgs | null,
	egress: EgressEnvDescriptor | null,
	runUser: ContainerRunUser,
	progressUpdate: ProgressUpdateContext | null,
	endpoints: RunEndpoints,
	// Loaded before the tunnel starts, because the tunnel's split-routing policy
	// needs the connector hosts and the tunnel is up before this runs. Passed in
	// rather than re-queried so a run resolves them exactly once.
	connectorDescriptors: McpDescriptor[],
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
		taskId: task?.id,
		agentId: agent.id,
		dataDir: deps.dataDir,
	});

	if (resolvedPrompt.includes('{{requester_context}}')) {
		let requesterText = '';
		if (task) {
			const creator = await deps.db.query<{ display_name: string; member_type: string }>(
				`SELECT m.display_name, m.member_type FROM tasks i
				 JOIN members m ON m.id = i.created_by_member_id
				 WHERE i.id = $1`,
				[task.id],
			);
			const row = creator.rows[0];
			if (row) requesterText = `This task was created by ${row.display_name} (${row.member_type}).`;
		}
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
	const commentWakeContext =
		wakeupPayload?.source === WakeupSource.Comment
			? await loadCommentWakeContext(deps.db, wakeupPayload)
			: null;
	const wakingCommentId =
		typeof wakeupPayload?.comment_id === 'string' ? wakeupPayload.comment_id : undefined;
	const spawnedFrom = task ? await loadSpawnedFromTask(deps.db, task) : null;
	const openSubTasks = task ? await loadOpenSubTasks(deps.db, task) : [];
	// A runtime that can only take the prompt as one argv element gets the system
	// half through an instructions file its CLI loads instead, leaving the prompt
	// small enough to survive MAX_ARG_STRLEN. The builders below take an empty
	// system prompt and skip their separator; the text travels via
	// buildRuntimeInvocation to that runtime's injector.
	const systemPromptToFile = RUNTIME_SYSTEM_PROMPT_FILE[runtimeType] ? resolvedPrompt : null;
	const inlineSystemPrompt = systemPromptToFile ? '' : resolvedPrompt;
	let basePrompt: string;
	if (progressUpdate) {
		basePrompt = buildProgressUpdatePrompt(inlineSystemPrompt, progressUpdate);
	} else if (isCoachReview) {
		// task is non-null on every non-progress-update path (enforced by runAgent).
		basePrompt = await buildCoachReviewPrompt(
			deps.db,
			inlineSystemPrompt,
			task as TaskInfo,
			runTeamId,
			deps.masterKeyManager,
			endpoints.hezoBaseUrl,
		);
	} else {
		// Every task run gets the latest few comments inline as a head-start, plus
		// where to start reading from, so catching up has an end rather than being
		// a walk back through everything the task has ever accumulated.
		const recentComments = await loadCommentHistory(
			deps.db,
			(task as TaskInfo).id,
			deps.masterKeyManager,
			endpoints.hezoBaseUrl,
			{ limit: RECENT_COMMENTS_LIMIT, categories: DEFAULT_THREAD_ROW_CATEGORIES },
		);
		const catchUp = await loadCatchUpSinceLastRun(
			deps.db,
			agent.id,
			(task as TaskInfo).id,
			heartbeatRunId,
		);
		basePrompt = buildTaskPrompt(inlineSystemPrompt, task as TaskInfo, wakeupPayload, {
			mentionContext,
			replyContext,
			commentWakeContext,
			spawnedFrom,
			openSubTasks,
			recentComments,
			wakingCommentId,
			catchUp,
		});
	}
	const taskPrompt = effortApplication.promptDirective
		? `${basePrompt}\n\n${effortApplication.promptDirective}`
		: basePrompt;

	const promptFilePath = getContainerPromptPath(heartbeatRunId);

	const { env, cmd, execCmd, subscriptionMount, homeMount, homeConfigScrubPaths } =
		await buildRuntimeInvocation({
			endpoints,
			connectorDescriptors,
			deps,
			runTeamId,
			projectId: project.id,
			provider,
			credential,
			runtimeType,
			agentJwt,
			agentId: agent.id,
			resourceId: heartbeatRunId,
			containerId: project.container_id,
			runUser,
			promptContainerPath: promptFilePath,
			systemPrompt: systemPromptToFile,
			effort,
			effortApplication,
			modelOverride,
			sshSocketContainerPath,
			bridge,
			egress,
			extraEnv: task
				? [`HEZO_TASK_ID=${task.id}`, `HEZO_TASK_IDENTIFIER=${task.identifier}`]
				: ['HEZO_PROGRESS_UPDATE=1'],
		});

	return {
		cmd,
		execCmd,
		env,
		taskPrompt,
		promptFilePath,
		runtimeType,
		promptDelivery: RUNTIME_PROMPT_DELIVERY[runtimeType],
		effort,
		effortApplication,
		agentJwt,
		subscriptionMount,
		homeMount,
		homeConfigScrubPaths,
	};
}

export type ContainerExitAbortReason = 'container_error' | 'container_stopped';
/**
 * Reasons the runner tags on a run's AbortSignal. A bare abort — a user cancel via
 * `cancelTask`, server shutdown, or the stale-dispatch reaper — carries none.
 *
 * `tunnel_lost` is the runner's own: the container reaches Hezo only through the
 * run tunnel, so a tunnel that dies mid-run leaves the agent unable to read a
 * task, post a comment, or record anything at all. The container is still alive,
 * so no `container_*` transition fires and nothing else would notice.
 */
export type RunAbortReason =
	| ContainerExitAbortReason
	| 'run_timeout'
	| 'tunnel_lost'
	| 'server_shutdown';

const RUN_ABORT_REASONS: readonly string[] = [
	'container_error',
	'container_stopped',
	'run_timeout',
	'tunnel_lost',
	'server_shutdown',
];

/**
 * What a run killed by a clean shutdown records.
 *
 * Deliberately distinguishable from `reconcileOnStartup`'s "Server restarted
 * while run in flight": this one means the drain saw it coming, that one means
 * it did not. Which of the two a run wears says whether the shutdown was orderly.
 */
export const RUN_LOST_TO_SHUTDOWN_ERROR =
	'Server shut down while this run was in flight; it will be re-queued when Hezo comes back.';

function runAbortReason(signal?: AbortSignal): RunAbortReason | null {
	const reason = signal?.reason as unknown;
	if (typeof reason === 'string' && RUN_ABORT_REASONS.includes(reason))
		return reason as RunAbortReason;
	return null;
}

/**
 * Terminal status for an aborted run: a wall-clock timeout is `TimedOut` (and drives an
 * automatic same-task continuation — see `JobManager.onAgentComplete`), container death and
 * a lost tunnel are `Failed`, and a bare abort (user cancel / shutdown) is `Cancelled`.
 */
function abortedRunStatus(reason: RunAbortReason | null): HeartbeatRunStatus {
	if (reason === 'run_timeout') return HeartbeatRunStatus.TimedOut;
	if (reason) return HeartbeatRunStatus.Failed; // container_error / container_stopped
	return HeartbeatRunStatus.Cancelled;
}

/**
 * How often a run blocked on container capacity re-tries the pool ladder.
 *
 * Nothing is event-driven on container release — `releasePoolMember` just marks
 * a member idle — so polling is the only signal available. Matched to
 * `WAKEUP_CRON` (5s), since the pass that actually frees the capacity being
 * waited on (`retireSurplusIdleContainers`) runs on the job manager's clock.
 */
const CAPACITY_PARK_POLL_MS = 5_000;

/**
 * The stand-in bearer the pre-claim dry run gives the `hezo` MCP descriptor.
 *
 * Shaped like the signed token the real run mints - three dot-separated
 * segments of token characters - so an adapter that inlines it into a file is
 * caught by the same check that would catch the real one. It is never written
 * anywhere and never reaches a container: the dry run's output is discarded and
 * `buildRuntimeInvocation` builds again with the real token.
 */
const PREFLIGHT_BEARER_TOKEN = 'preflight.dry.run';

/**
 * How long a run waits for capacity before giving up and returning to the queue.
 *
 * Deliberately not the agent's own `run_timeout_min`: letting the park run to
 * that deadline aborts with `run_timeout`, which finalizes the run `timed_out` —
 * trading one errored row for another. The dispatcher's pre-flight gate already
 * refuses to dispatch while at capacity, so a run that reaches the ladder and
 * finds nothing lost a race, and a race resolves in seconds or was never one.
 *
 * This exceeds {@link STALE_STATE_GRACE_SECONDS}, so a parked run outlives the
 * age at which the orphan pass would consider its row. That is safe only because
 * the pass skips any run id in the live-run registry, and this park stays inside
 * `runAgent` precisely to keep it there. The registry is in-memory, so a restart
 * mid-park drops the row to the pass anyway — which is why the never-started
 * verdict has to be survivable rather than a failure. `capacity-park-grace`
 * in `orphan-detector.test.ts` pins the relationship.
 */
export const CAPACITY_PARK_MAX_MS = 3 * 60_000;

/**
 * How long a run waits for the rotating provider credential before handing its
 * work back.
 *
 * **Deliberately not {@link CAPACITY_PARK_MAX_MS}, which it used to share.** The
 * two waits look alike and are not the same judgement. The capacity park waits
 * for a container slot the idle-reclaim cron frees, so it resolves in seconds
 * and giving up early costs nothing. This lock is held for a *whole other run*
 * (the CLI rewrites the token file whenever it likes and the rotated value is
 * read back during teardown), so what is being waited on is bounded by that
 * run's `run_timeout_min` - 60 minutes by default. At a 3 minute ceiling a
 * second run on a rotating credential gave up, re-queued, redispatched 5s later
 * and gave up again, over and over, until the holder finished: a thrash loop
 * that never converged and filled the run list on the way. Queueing on the lock
 * is FIFO and correct; giving up early only randomises who goes next.
 *
 * Derived from the waiting run's own timeout rather than fixed, with headroom,
 * because waiting past that deadline lets `launchTask`'s wall-clock timer abort
 * the run as `timed_out` - trading one errored row for another, which is the
 * same reason the capacity park does not use `run_timeout_min` raw.
 *
 * **Deliberately unfloored.** An earlier revision floored this at the capacity
 * park's ceiling so a short agent timeout could not regress the wait; that
 * inverted the invariant above for any `run_timeout_min` of 3 or less (settable
 * to 1 in the UI), where a 180 s wait outlives a 60 s wall-clock timer and the
 * run is finalized `timed_out` instead of handing back. The fraction alone keeps
 * the wait inside the run's own budget at every setting.
 *
 * The cap bounds a cost the wait carries that is easy to miss: a dispatch with
 * no spare container takes a `pendingContainerStarts` reservation *before*
 * `launchTask`, and it is charged against the instance memory budget until the
 * run settles. So a waiter reserves a container's worth of headroom for a
 * container it has not asked for yet, and every minute of this wait is a minute
 * another project can be told the instance is at capacity. 15 minutes covers the
 * "a run takes several minutes" case this exists for while keeping that
 * reservation bounded.
 */
const CREDENTIAL_WAIT_MAX_FRACTION = 0.8;
/**
 * Also the CEO chat's ceiling on the same lock: a chat turn queues ahead of every
 * parked run and so waits on the holder alone, and the operator sees what it is
 * waiting for and can stop the turn at any moment, so the run's cap is the right
 * one there too.
 */
export const CREDENTIAL_WAIT_CAP_MS = 15 * 60_000;

export function credentialWaitMaxMs(runTimeoutMin: number | null | undefined): number {
	const budget = (runTimeoutMin ?? 0) * 60_000 * CREDENTIAL_WAIT_MAX_FRACTION;
	return Math.min(budget, CREDENTIAL_WAIT_CAP_MS);
}

/**
 * Sleep that returns early when the run is aborted, so a cancel or a shutdown
 * during a capacity park is not held for the rest of the poll interval.
 */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done, { once: true });
	});
}

/** Error string stamped on an aborted run row — a friendly line for a timeout, else the raw reason. */
function abortErrorMessage(reason: RunAbortReason | null): string | undefined {
	if (reason === 'run_timeout') return 'run reached its time limit';
	if (reason === 'server_shutdown') return RUN_LOST_TO_SHUTDOWN_ERROR;
	if (reason === 'tunnel_lost')
		return (
			'the run tunnel to the container closed mid-run, so the agent lost its Hezo tools, ' +
			'the egress proxy and the ssh agent - the run was failed rather than left to finish ' +
			'with no way to record anything'
		);
	return reason ?? undefined;
}

/**
 * Where each recovery records the run it is replacing, and whether that
 * recovery draws on the lost-run retry budget.
 *
 * Three paths mint a replacement run and each names the prior run under its own
 * key. One reader, so a fourth spelling is a row here rather than a branch at
 * the call site.
 */
const RUN_LINEAGE_SOURCES: readonly {
	read: (p: Record<string, unknown>) => unknown;
	inheritsLossBudget: boolean;
}[] = [
	// The orphan pass's retry - the only one bounded by the lost-run ceiling.
	{
		read: (p) => (p.previous_failure as Record<string, unknown> | undefined)?.run_id,
		inheritsLossBudget: true,
	},
	// A container coming back, and startup recovery. One-shot.
	{ read: (p) => p.previous_run_id, inheritsLossBudget: false },
	// A human pressing Retry. Somebody is asking for another attempt.
	{ read: (p) => p.source_run_id, inheritsLossBudget: false },
];

export function extractReplacedRun(
	payload: Record<string, unknown> | undefined,
): ReplacedRun | null {
	if (!payload) return null;
	for (const source of RUN_LINEAGE_SOURCES) {
		const id = source.read(payload);
		if (typeof id === 'string') {
			return { runId: id, inheritsLossBudget: source.inheritsLossBudget };
		}
	}
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
	db: Db,
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

/**
 * Told that a run exists, and given a way to be told where it landed.
 *
 * The two are separate calls because the order is fixed: a run has a row - and
 * is therefore cancellable - before the pool has decided which container it will
 * execute in. A caller keeping an in-memory registry needs the run from the
 * first moment and the placement as soon as it is known, or a
 * container-scoped cancellation cannot aim at the right runs.
 */
export type RunRegistrationHook = (
	heartbeatRunId: string,
) => ((containerId: string) => void) | void;

export async function runAgent(
	deps: RunnerDeps,
	agent: AgentInfo,
	task: TaskInfo | null,
	project: ProjectInfo,
	wakeupPayload?: Record<string, unknown>,
	signal?: AbortSignal,
	onRunRegistered?: RunRegistrationHook,
	wakeupId?: string,
	progressUpdate?: ProgressUpdateContext | null,
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
		taskId: task?.id ?? null,
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
		progressUpdate ? HeartbeatRunKind.ProgressUpdate : HeartbeatRunKind.Task,
		extractReplacedRun(wakeupPayload),
	);
	const onContainerAcquired = onRunRegistered?.(heartbeatRunId);
	await emitRunStarted(deps, heartbeatRunId, agent, task, project, effectiveWakeupId);
	const streamId = `run:${heartbeatRunId}`;

	// Latest running token usage, refreshed from the parser on every exec chunk.
	// Persisted on every log flush (below) so that whatever the run has burned
	// so far survives a crash — reconcileOnStartup never overwrites these
	// columns, so the last snapshot is what a restart-failed run reports.
	let currentUsage: AgentRunUsage | null = null;

	deps.logs.begin({
		streamId,
		room: `project-runs:${project.id}`,
		buildMessage: (line) => ({
			type: WsMessageType.RunLog,
			projectId: project.id,
			runId: heartbeatRunId,
			taskId: task?.id ?? null,
			stream: line.stream,
			text: line.text,
		}),
		buildSnapshot: (text, trimmed) => ({
			type: WsMessageType.RunLog,
			projectId: project.id,
			runId: heartbeatRunId,
			taskId: task?.id ?? null,
			stream: 'stdout',
			text,
			replace: true,
			trimmed,
		}),
		onFlush: async (delta) => {
			// Append only the new log text as chunk rows (never rewrite the whole
			// log — the old full-blob UPDATE pattern left a dead TOAST copy per
			// flush). The running usage persists alongside so a crash mid-run still
			// leaves a non-zero token/cost snapshot, flagged partial until a clean
			// completion. One statement, so it is atomic without a transaction:
			// the broker re-sends the same delta after a failed flush, so chunk +
			// usage must land all-or-nothing to stay exactly-once, and every
			// transaction block serializes process-wide on both drivers.
			if (delta.length === 0 && !currentUsage) return;
			await appendRunLogChunks(deps.db, heartbeatRunId, delta, currentUsage);
		},
	});

	const emit = (stream: 'stdout' | 'stderr', text: string) =>
		deps.logs.emit(streamId, stream, text);

	/**
	 * Gives the rotating credential back, when this run took it.
	 *
	 * Released from two places, and idempotent so both are safe. Every exit that
	 * happens before the exec block is opened goes through one of the three
	 * finalizers below, and everything from the exec block onward is covered by
	 * that block's own `finally`. Splitting it this way is what lets the lock be
	 * taken before a container is claimed: a waiter that gives up, aborts or gets
	 * requeued must not still be holding it.
	 */
	let releaseCredentialLock: (() => void) | null = null;

	const finalizeFailure = async (message: string): Promise<RunResult> => {
		releaseCredentialLock?.();
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
			stderr: message,
			durationMs,
			heartbeatRunId,
		};
	};

	/**
	 * The signal the run actually executes under: the caller's, plus the run's own
	 * fatal conditions.
	 *
	 * The caller owns an `AbortSignal` it can cancel or time out; the runner has
	 * one condition of its own that is just as terminal and that nothing could
	 * previously act on - the tunnel dying, which leaves a perfectly healthy
	 * container with no route to Hezo. Deriving rather than reaching into the
	 * caller's controller keeps ownership where it is, and forwarding
	 * `signal.reason` verbatim keeps `runAbortReason` reading exactly what it read
	 * before for every case that already existed.
	 */
	const runAbort = new AbortController();
	if (signal) {
		if (signal.aborted) runAbort.abort(signal.reason);
		else signal.addEventListener('abort', () => runAbort.abort(signal.reason), { once: true });
	}

	const finalizeAbort = async (): Promise<RunResult> => {
		releaseCredentialLock?.();
		const durationMs = Date.now() - startTime;
		await deps.logs.end(streamId);
		const reason = runAbortReason(runAbort.signal);
		const status = abortedRunStatus(reason);
		await updateHeartbeatRun(
			deps.db,
			heartbeatRunId,
			{
				status,
				exitCode: -1,
				durationMs,
				error: abortErrorMessage(reason),
			},
			runBroadcast,
		);
		return {
			success: false,
			exitCode: -1,
			stderr: abortErrorMessage(reason) ?? 'Aborted',
			durationMs,
			heartbeatRunId,
			timedOut: reason === 'run_timeout',
		};
	};

	/**
	 * The terminal verdict for a thrown run failure.
	 *
	 * The **signal** decides the status, not the shape of the thrown error. Only
	 * Docker's exec reliably rejects with an `AbortError` when its attach is torn
	 * down; a managed backend's exec may reject with anything or resolve outright,
	 * and keying on the error name there recorded a timed-out run as `failed` while
	 * still stamping it with the timeout's own message - measured against the live
	 * Daytona API. An error with no abort reason behind it is a genuine failure; a
	 * bare abort (user cancel, shutdown) is still `cancelled`.
	 *
	 * Shared with the setup window, which needs the same answer: a shutdown landing
	 * inside `buildRunContext` is a cancellation, not a failure, and recording it as
	 * one would put an unactionable row in the Errored view on every restart.
	 */
	const throwVerdict = (
		error: unknown,
	): { status: HeartbeatRunStatus; message: string; timedOut: boolean } => {
		const isAbort = error instanceof Error && error.name === 'AbortError';
		const reason = runAbortReason(runAbort.signal);
		return {
			status: reason
				? abortedRunStatus(reason)
				: isAbort
					? HeartbeatRunStatus.Cancelled
					: HeartbeatRunStatus.Failed,
			message:
				abortErrorMessage(reason) ?? (error instanceof Error ? error.message : String(error)),
			timedOut: reason === 'run_timeout',
		};
	};

	/**
	 * Spend one strike of the lost-run budget, then retry or escalate.
	 *
	 * Counted the way the orphan detector counts it, so a transport loss, a failed
	 * tunnel start and a vanished driver converge on one ceiling rather than each
	 * retrying forever. Best-effort: failing to queue the retry must never replace
	 * the real error already on the row.
	 */
	const spendLostRunStrike = async (): Promise<void> => {
		try {
			const bumped = await deps.db.query<{ process_loss_retry_count: number }>(
				`UPDATE heartbeat_runs SET process_loss_retry_count = process_loss_retry_count + 1
				 WHERE id = $1 RETURNING process_loss_retry_count`,
				[heartbeatRunId],
			);
			await retryOrEscalateLostRun(deps.db, {
				runId: heartbeatRunId,
				memberId: agent.id,
				teamId: runTeamId,
				taskId: task?.id ?? null,
				priorRetries: Math.max(0, (bumped.rows[0]?.process_loss_retry_count ?? 1) - 1),
			});
		} catch (e) {
			log.error(`Run ${heartbeatRunId}: could not queue a transport retry:`, e);
		}
	};

	let provider: AiProvider;
	let runtimeType: AgentRuntime;
	// Null on the agent-override path: the override names only a provider, and
	// which CLI that provider runs on is a property of the credential, resolved
	// below once one is loaded. The task-pinned path already resolved against a
	// specific credential, so it constrains the lookup to a matching one.
	let requiredRuntime: AgentRuntime | null = null;
	if (agent.model_override_provider) {
		provider = agent.model_override_provider;
		const adapter = PROVIDER_RUNTIME_ADAPTERS[provider];
		if (!adapter) {
			return finalizeFailure(
				`This agent's model override references provider "${provider}", which is no longer supported. Clear the override in the agent's settings.`,
			);
		}
		runtimeType = adapter.runtime;
	} else {
		const resolved = await resolveRuntimeForTask(deps.db, task?.runtime_type ?? null);
		// The reason comes from the resolver, which is the only place that knows
		// whether nothing is configured, the designated default is unusable, or the
		// task's runtime pin has no credential behind it.
		if (!resolved.ok) return finalizeFailure(resolved.reason);
		runtimeType = resolved.runtime;
		provider = resolved.provider;
		requiredRuntime = resolved.runtime;
	}

	let credential = await getProviderCredentialAndModel(
		deps.db,
		deps.masterKeyManager,
		provider,
		requiredRuntime,
	);
	if (!credential) {
		return finalizeFailure(
			`No ${provider} credential configured. Add one in Settings > AI Providers.`,
		);
	}
	// The agent-override path chose a provider without knowing which CLI its
	// credential is set to run on, so settle that now — otherwise an override onto
	// a provider whose credential was switched would launch the default binary
	// with the other binary's env.
	if (!requiredRuntime) {
		runtimeType = effectiveRuntime(provider, credential.runtime) ?? runtimeType;
	}

	const modelOverride = agent.model_override_model ?? credential.defaultModel ?? null;

	if (signal?.aborted) return finalizeAbort();

	// Prove the host-side half of the run before the pool is touched.
	//
	// Same reasoning as the credential resolution above: a misconfigured instance
	// is an ordinary state, not an exceptional one, and it must not cost a
	// container. `validateInjection` is a hard failure that ends the run, and it
	// used to fire ~4s *after* a sandbox had been provisioned - which on a full
	// budget means after another project's container was retired to make room. One
	// bad connector header therefore cost two cold provisions per lap, forever.
	//
	// The dry run is the real descriptor list, the real adapter and the real home
	// paths; only the tunnel's loopback port is stand-in, because it is chosen by
	// an in-container probe and cannot exist yet. Nothing in an adapter or in
	// `validateInjection` reads a port, which a drift test pins across every
	// runtime rather than a comment asserting it here.
	//
	// The descriptors are loaded once and threaded into the run, so this costs no
	// extra query.
	let connectorDescriptors: McpDescriptor[];
	try {
		connectorDescriptors = await loadConnectorDescriptors(deps.db, project.id);
		const homePaths = RUNTIME_ADAPTERS[runtimeType].capabilities.requiresHomeDir
			? {
					hostHomeDir: getHostSubscriptionRootImpl(
						provider,
						runtimeType,
						deps.dataDir,
						runTeamId,
						project.id,
						heartbeatRunId,
					),
					containerHomeDir: getContainerSubscriptionRootImpl(provider, runtimeType, heartbeatRunId),
				}
			: { hostHomeDir: null, containerHomeDir: null };
		buildMcpInjection(
			runtimeType,
			[
				{
					kind: 'http',
					name: HEZO_MCP_SERVER_NAME,
					url: `${PREFLIGHT_TUNNEL_ENDPOINTS.hezoBaseUrl}/mcp`,
					// Shaped like the real signed token so the inlined-bearer check has
					// something to catch. The real one is minted later, with the run.
					bearerToken: PREFLIGHT_BEARER_TOKEN,
				},
				...connectorDescriptors,
			],
			{
				hostHomeDir: homePaths.hostHomeDir,
				containerHomeDir: homePaths.containerHomeDir,
				provider,
				runModel: modelOverride,
				projectDocSlugs: [],
				stopJudge: true,
				systemPrompt: null,
			},
		);
	} catch (e) {
		return finalizeFailure(
			`This run cannot be prepared: ${(e as Error).message} No container was started.`,
		);
	}

	/**
	 * Record that this run is parked waiting for container capacity.
	 *
	 * The run row stays `queued` — it was never marked running — and stays inside
	 * `runAgent`, which is what keeps it in the live-run registry and therefore
	 * invisible to the orphan pass. Same shape as the rotating-credential wait
	 * below: the reason is written so the run comment and the run detail page read
	 * honestly ("Queued - waiting for container capacity…") while blocked.
	 */
	const recordCapacityPark = async (): Promise<void> => {
		await deps.db.query(
			`UPDATE heartbeat_runs SET queued_reason = $1
			 WHERE id = $2 AND status = $3::heartbeat_run_status
			   AND queued_reason IS DISTINCT FROM $1`,
			[CAPACITY_PARK_QUEUED_REASON, heartbeatRunId, HeartbeatRunStatus.Queued],
		);
	};

	/**
	 * Give up waiting on the instance and hand the work back to the queue.
	 *
	 * Reached from both waits a run can sit in - container capacity, and the
	 * rotating provider credential - once either passes its ceiling. Neither is a
	 * failure: the instance is busy, not the agent. So the row is finalized
	 * `Cancelled` rather than `Failed`, and the caller re-queues the wakeup.
	 *
	 * Finalizing it is the load-bearing part. A row left `queued` here is
	 * abandoned: nothing returns to it, it still matches `isTaskBusyInDb` so it
	 * blocks the retry of the very wakeup it came from, and 120s later the orphan
	 * pass reaps it as `Orphaned: run never started` and counts it toward the
	 * lost-run escalation. A terminal row does none of that, so the requeued
	 * wakeup is free to dispatch on the next tick.
	 */
	const finalizeRequeue = async (
		reason: string,
		requeueReason: WakeupSkipReason,
	): Promise<RunResult> => {
		releaseCredentialLock?.();
		const message = `${reason} - returning this run to the queue.`;
		emit('stdout', `[runner] ${message}\n`);
		const durationMs = Date.now() - startTime;
		await deps.logs.end(streamId);
		await updateHeartbeatRun(
			deps.db,
			heartbeatRunId,
			{
				status: HeartbeatRunStatus.Cancelled,
				exitCode: -1,
				durationMs,
				error: message,
				// Deliberately NOT stamping `cancel_reason` here. Whether the work is
				// actually carried is not known until the caller settles the wakeup,
				// and the guard there can bite. Writing `handed_back` at this point
				// asserted an outcome before attempting it - the same defect the orphan
				// sweeper was restructured to avoid - and left it standing when the
				// handback failed. `JobManager.settleWakeupForRun` records it once the
				// answer is in, through the recorder the sweeper shares.
			},
			runBroadcast,
		);
		return {
			success: false,
			exitCode: -1,
			stderr: reason,
			durationMs,
			heartbeatRunId,
			requeued: true,
			requeueReason,
		};
	};

	// Human-friendly label for run-scoped logs (egress proxy, ssh-agent) and for
	// naming this run as a lock holder, since a run has no friendly identifier of
	// its own.
	const runLabel = task ? `${agent.slug}/${task.identifier}` : `${agent.slug}/progress-update`;

	// Rotation is a property of the CLI that rewrites the token file, so this is
	// judged on the resolved runtime rather than the provider's default. The
	// predicate is shared with the web, which warns an operator adding such a
	// credential that it will only ever run one agent at a time.
	if (credentialSerializesRuns(provider, runtimeType, credential.authMethod)) {
		// Taken **before** a container is claimed, and deliberately so. The lock is
		// held for a whole run, so a waiter can sit here for minutes; claiming first
		// meant every waiter pinned a container's memory for that entire wait, which
		// the pool counts as used and cannot reclaim. Worse, the container went idle
		// while its run waited, so the backend stopped it underneath and the run then
		// failed on the first call it made. A waiter now holds nothing - and, holding
		// nothing, it is not on any container a death can be attributed to (see
		// `JobManager.cancelLiveRunsForContainer`).
		const holder = credentialLockHolder(credential.configId);
		if (holder) {
			emit('stdout', `[runner] ${credentialWaitNotice(holder)}\n`);
		}
		// Records the true wait so the run comment reads honestly while blocked.
		await deps.db.query(
			`UPDATE heartbeat_runs SET queued_reason = $1
			 WHERE id = $2 AND status = $3::heartbeat_run_status`,
			[QueuedRunReason.CredentialSerialized, heartbeatRunId, HeartbeatRunStatus.Queued],
		);
		// Read here rather than carried on `AgentInfo`: only a rotating credential
		// reaches this block, so the extra round trip is on the slow path alone and
		// every other caller of `runAgent` is left unchanged.
		const timeoutRow = await deps.db.query<{ run_timeout_min: number }>(
			'SELECT run_timeout_min FROM member_agents WHERE id = $1',
			[agent.id],
		);
		try {
			releaseCredentialLock = await acquireCredentialLock(credential.configId, {
				signal: runAbort.signal,
				// See {@link credentialWaitMaxMs}: this waits on a whole other run, not
				// on the idle-reclaim cron, so it does not share the capacity park's
				// ceiling. `deps.capacityPark?.maxMs` still overrides it, which is what
				// lets a test drive either wait to its deadline quickly.
				timeoutMs:
					deps.capacityPark?.maxMs ?? credentialWaitMaxMs(timeoutRow.rows[0]?.run_timeout_min),
				owner: {
					label: runLabel,
					// The run page resolves its agent by slug or id alike.
					link: {
						projectSlug: project.slug,
						agentSlug: agent.slug ?? agent.id,
						runId: heartbeatRunId,
					},
				},
			});
		} catch (e) {
			if (runAbort.signal.aborted) return finalizeAbort();
			if (e instanceof KeyedLockTimeoutError) {
				// The label alone: this lands in the row's `error`, which the thread shows
				// as a one-line summary where a link has no home. The log line above
				// carries the link.
				const stillHeldBy = credentialLockHolder(credential.configId);
				return finalizeRequeue(
					`${stillHeldBy?.label ?? 'Another run'} still holds this provider credential`,
					WakeupSkipReason.CredentialBusy,
				);
			}
			// Finalized rather than rethrown: nothing above this catches, and a
			// throw here would leave the row `queued` with no driver - which is the
			// stranded-run shape the whole wait is arranged to avoid.
			return finalizeFailure(
				`Could not take the provider credential: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
		if (holder) emit('stdout', '[runner] Credential free, starting the run.\n');
		// The value read before the wait can be a rotation behind by now: the holder
		// this run queued behind rewrites the single-use token and stores the new
		// one on its way out. Read it again while holding the lock, so the mount
		// this run writes and the read-back it compares against are both current.
		const stored = await readAiProviderCredentialValue(
			deps.db,
			deps.masterKeyManager,
			credential.configId,
		);
		if (stored !== null && stored !== credential.value)
			credential = { ...credential, value: stored };
	}

	// Containers run on demand, and this run claims one **for itself**: the pool
	// ladder reuses a warm container that last served this task, else any warm
	// one, else resumes a suspended one, else provisions. What it never returns is
	// a container another run is using - that one-run-per-container rule is the
	// whole reason a memory blowout can no longer take down every sibling run in
	// the project. Serialized per project, so concurrent dispatches into the same
	// project cannot both provision.
	//
	// Claimed **after** the provider, runtime and credential are resolved, and not
	// before: those three resolve to a `finalizeFailure` on an instance that is
	// simply misconfigured (no credential, an override naming a retired provider),
	// which is a normal state rather than an exceptional one. Claiming first meant
	// every such wakeup provisioned a container and returned without giving it
	// back - and a leaked claim is unrecoverable, since the ladder skips a busy
	// member, the idle pass never stops one, and its memory counts against the
	// instance budget forever. On a credential-less instance that walked the budget
	// to exhaustion one wakeup at a time.
	if (project.container_status !== ContainerStatus.Running) {
		emit('stdout', '[runner] Starting the project container…\n');
	}
	let containerId: string;
	let releaseContainer: () => Promise<void> = async () => undefined;
	// Park rather than bail when the instance is at its memory budget. The wait
	// happens here, inside `runAgent`, for one reason: the run id is only in the
	// live-run registry while this call is in flight, and that registry is the
	// sole thing telling the orphan pass a queued row still has a driver. Return
	// to the caller and the row is unowned - reaped as a failure 120s later, and
	// replaced by a second run row when the wakeup redispatches. Same pattern as
	// the rotating-credential wait below.
	const parkPollMs = deps.capacityPark?.pollMs ?? CAPACITY_PARK_POLL_MS;
	const parkDeadline = Date.now() + (deps.capacityPark?.maxMs ?? CAPACITY_PARK_MAX_MS);
	let parked = false;
	try {
		let acquired: Awaited<ReturnType<typeof acquireRunContainer>> | undefined;
		while (!acquired) {
			try {
				acquired = await acquireRunContainer(
					{
						db: deps.db,
						docker: deps.docker,
						dataDir: deps.dataDir,
						wsManager: deps.wsManager,
						masterKeyManager: deps.masterKeyManager,
						logs: deps.logs,
						containerLogStreamer: deps.containerLogStreamer,
						sshAgentServer: deps.sshAgentServer,
						// A run that has to provision its container clones through the
						// provisioning bridge, which needs this to substitute the remote's
						// credential placeholder — the run's own allocation comes later and is
						// a different one.
						egressProxy: deps.egressProxy,
						egressCAPath: deps.egressCAPath,
					},
					project.id,
					task?.id ?? null,
				);
			} catch (e) {
				if (!(e instanceof PoolCapacityError)) throw e;
				if (Date.now() >= parkDeadline) {
					return finalizeRequeue(e.message, WakeupSkipReason.InstanceAtCapacity);
				}
				if (!parked) {
					// Once, not per poll: a line every 5s would make the run log the
					// new noise, and the wait itself is already on the row as
					// `queued_reason`.
					parked = true;
					emit('stdout', `[runner] ${e.message} - waiting for capacity.\n`);
					await recordCapacityPark();
				}
				await sleepUnlessAborted(parkPollMs, runAbort.signal);
				if (runAbort.signal.aborted) return finalizeAbort();
			}
		}
		if (parked) emit('stdout', '[runner] Capacity freed up, starting the run.\n');
		containerId = acquired.containerId;
		releaseContainer = acquired.release;
		// Before anything can go wrong inside it: from here on this run can be
		// ended by its container dying, and only a caller that knows where it
		// landed can tell that apart from a sibling container dying.
		onContainerAcquired?.(containerId);
		// Which container served this run, and the size it actually had. Written
		// into the log rather than rendered from the run row because the member row
		// is destroyed when the container is - the log is what still answers months
		// later. The viewer turns the id into a link to that container's page.
		if (acquired.allocation) {
			emit(
				'stdout',
				`[runner] ${formatContainerMetaLogLine({ containerId, ...acquired.allocation })}\n`,
			);
		}
	} catch (e) {
		// PoolCapacityError never reaches here — the acquire loop above parks on it
		// and only rethrows what it cannot wait out.
		const message = e instanceof Error ? e.message : String(e);
		await broadcastProjectUpdate(deps.db, deps.wsManager, project.team_id, project.id);
		return finalizeFailure(
			`Could not start the project container: ${message} See Settings > Containers for its log.`,
		);
	}
	// The run may have been aborted (e.g. timed out) while a slow provision ran.
	if (signal?.aborted) {
		await releaseContainer();
		return finalizeAbort();
	}
	const runningProject: RunningProjectInfo = {
		...project,
		container_id: containerId,
		container_status: ContainerStatus.Running,
	};

	// Everything past the claim runs inside a try/finally so every run-scoped
	// resource is always released — including when setup (sockets, proxy, tunnel,
	// context, worktrees, file writes) throws before the exec block. Leaking the
	// credential lock would queue every later run on this credential forever;
	// leaking the claim strands the container itself, which nothing reclaims.
	//
	// The three below are declared out here for the same reason, and each was
	// genuinely stranded by a throw between its acquisition and the point
	// `cleanupRunArtifacts` becomes reachable — `buildRunContext` is the realistic
	// thrower, and it sits directly between them. Each leak is quiet in its own
	// way: a live tunnel counts as activity on every backend, so the container
	// never goes idle and bills instead of erroring, and on a managed backend its
	// client keeps the run's three loopback ports, so the *next* run on that
	// pooled container dies with EADDRINUSE having lost MCP and egress entirely.
	// The ssh socket and the egress allocation each hold a host port.
	//
	// Every release here is idempotent, so the explicit cleanup paths below do not
	// double-free.
	let runTunnel: RunTunnel | null = null;
	let sshSocketAllocated = false;
	let egressProxyAllocated = false;
	try {
		// Two gates before the run becomes real, because waiting for a credential
		// and then a container takes long enough that the run can be ended from
		// underneath in the meantime.
		if (runAbort.signal.aborted) return finalizeAbort();

		const started = await markHeartbeatRunRunning(
			deps.db,
			heartbeatRunId,
			runBroadcast,
			{ aiProviderConfigId: credential.configId, provider },
			// Recorded here rather than at insert because the container is acquired
			// after the row exists. It is what lets a container's death fail exactly
			// the runs that were on it (see `failProjectRuns`).
			containerId,
		);
		// The second gate, and the one an abort cannot cover: the orphan pass reaps
		// a row without touching this run's signal. `markHeartbeatRunRunning` is
		// guarded on the row still being `queued`, so against a reaped row it
		// silently did nothing and the agent ran on anyway - a full run, billed to
		// the provider, that the UI had already reported as cancelled.
		if (!started) {
			const message = 'This run was ended before it could start; stopping without executing.';
			emit('stderr', `[runner] ${message}\n`);
			await deps.logs.end(streamId);
			return {
				success: false,
				exitCode: -1,
				stderr: message,
				durationMs: Date.now() - startTime,
				heartbeatRunId,
			};
		}

		// Detect the container's run-user once (cached). Drives every --user exec, the
		// ssh socket owner, and the chowns that give the run-user ownership of the
		// host-written config/worktree dirs. Defaults to root for an image with no
		// `node` user, which makes those chowns a harmless no-op.
		const runUser = await resolveContainerRunUser(deps.docker, containerId);

		// Both legs are allocated on the host first, then handed to the tunnel as
		// targets. Only after it is up are the container-facing descriptors built,
		// from its endpoints - so nothing here ever names an address the container
		// would have to reach by route.
		let sshSocketContainerPath: string | null = null;
		let sshSocketHostPath: string | null = null;
		let sshHostTcpPort = 0;
		let sshTokenHex: string | null = null;
		if (deps.sshAgentServer) {
			sshSocketHostPath = getRunSocketPath(deps.dataDir, heartbeatRunId);
			const allocated = await deps.sshAgentServer.allocateRunSocket(
				heartbeatRunId,
				{ teamId: agent.team_id, agentId: agent.id, label: runLabel },
				sshSocketHostPath,
			);
			sshSocketContainerPath = `/run/hezo/${heartbeatRunId}.sock`;
			sshHostTcpPort = allocated.tcpHostPort;
			sshTokenHex = allocated.tokenHex;
			sshSocketAllocated = true;
		}

		let egressHost: { host: string; port: number; token: string | null } | null = null;
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
				// A hosted connector refusing this run is reported in two lines: what
				// the run saw, right away, and what Hezo's own re-check of the
				// connector found, when it lands. The re-check writes the connector's
				// health through its sanctioned writer, so the Connectors page and its
				// banner follow from the same call; a verdict arriving after the log
				// closed goes to the server log instead of nowhere.
				onConnectorRejection: (event) => {
					emit('stderr', `\n[runner] WARNING: ${describeConnectorRejection(event, runtimeType)}\n`);
					trackBackground(
						recheckRejectedConnector(
							{ db: deps.db, masterKeyManager: deps.masterKeyManager, wsManager: deps.wsManager },
							event,
							{
								runId: heartbeatRunId,
								label: runLabel,
								teamId: project.team_id,
								projectId: project.id,
							},
						)
							.then((verdict) => {
								if (deps.logs.isActive(streamId)) emit('stderr', `[runner] ${verdict}\n`);
								else log.warn(`Run ${heartbeatRunId}: ${verdict}`);
							})
							.catch((e) => log.error(`Run ${heartbeatRunId}: connector re-check failed:`, e)),
					);
				},
			});
			egressAllocated = true;
			egressProxyAllocated = true;
			egressHost = {
				host: allocated.proxyHost,
				port: allocated.proxyPort,
				token: allocated.token,
			};
		}

		// The descriptors were loaded by the preflight above, before the container
		// was claimed - they resolve from the db and the project alone, and only the
		// `hezo` descriptor needs the tunnel's endpoints. They are needed here
		// because the tunnel's split-routing policy is built from the connector
		// hosts: the per-connector method allowlist is enforced *at the proxy*, so a
		// connector routed direct would skip its policy check even when no secret is
		// involved.

		// The tunnel is how a container reaches Hezo - the only how, on every
		// backend. Started here because it needs both allocations above: there is
		// nothing to point the ssh and proxy targets at until they exist.
		const tunnel: RunTunnel = await startRunTunnel({
			engine: deps.docker,
			containerId,
			runUser,
			files: deps.docker.files(containerId, CONTAINER_WORKSPACE_ROOT),
			configRelPath: join('.hezo', 'tunnel', `${heartbeatRunId}.json`),
			configContainerPath: `/workspace/.hezo/tunnel/${heartbeatRunId}.json`,
			addresses: {
				mcp: { host: '127.0.0.1', port: deps.serverPort },
				ssh: { host: '127.0.0.1', port: sshHostTcpPort },
				proxy: egressHost
					? { host: egressHost.host, port: egressHost.port }
					: { host: '127.0.0.1', port: 0 },
			},
			policy: await buildTunnelHostPolicy(deps.db, connectorDescriptors),
		});
		runTunnel = tunnel;
		// The tunnel is the container's only path to Hezo, so losing it mid-run
		// leaves the agent with no MCP tools, no egress proxy and no ssh agent for
		// the rest of its budget - and it cannot even call `report_no_work`, which
		// is itself an MCP tool. Fail the run at once and say why, rather than let
		// it run on to be recorded as having produced no output.
		tunnel.onClosed((why) => {
			emit(
				'stderr',
				`\n[runner] ${why} — failing the run: the container can no longer reach Hezo\n`,
			);
			if (!runAbort.signal.aborted) runAbort.abort('tunnel_lost');
		});
		const endpoints: RunEndpoints = tunnel.endpoints;

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

		const egressEnv: EgressEnvDescriptor | null = egressHost
			? {
					host: endpoints.proxyHost,
					port: endpoints.proxyPort,
					containerCAPath: '/usr/local/share/ca-certificates/hezo-egress.crt',
					token: egressHost.token,
				}
			: null;

		const context = await buildRunContext(
			deps,
			agent,
			task,
			runningProject,
			wakeupPayload,
			credential,
			provider,
			runtimeType,
			heartbeatRunId,
			modelOverride,
			sshSocketContainerPath,
			bridge,
			egressEnv,
			runUser,
			progressUpdate ?? null,
			endpoints,
			connectorDescriptors,
		);

		// Rooted at the workspace, which is what makes the prompt path relative and
		// so switchable; the absolute form is still needed for the env var the
		// container reads it from.
		const workspaceFiles = deps.docker.files(containerId, CONTAINER_WORKSPACE_ROOT);
		const promptRelPath = getPromptRelPath(heartbeatRunId);

		const pricing = deps.pricing;
		const priceFn = pricing
			? (model: string | undefined, tokens: CostTokens) => pricing.costCents(model, tokens)
			: undefined;
		const parser = createAgentStreamParser(runtimeType, priceFn, modelOverride);

		const persistRotatedAuth = async (): Promise<void> => {
			await persistRotatedSubscriptionAuth({
				db: deps.db,
				masterKeyManager: deps.masterKeyManager,
				engine: deps.docker,
				containerId,
				provider,
				credential,
				mount: context.subscriptionMount,
				onNotice: (text: string) => emit('stderr', `[runner] ${text}\n`),
			});
		};

		// Best-effort teardown of run-scoped artifacts. Each step is isolated so a
		// failed or slow release can never block the run result from reaching the
		// completion bookkeeping (lock release, idle flip, wakeup completion) —
		// a wedge here previously left agents stuck "running" forever.
		const cleanupRunArtifacts = async () => {
			const step = async (label: string, fn: () => void | Promise<void>) => {
				try {
					await fn();
				} catch (e) {
					log.error(`Run ${heartbeatRunId} artifact cleanup step '${label}' failed:`, e);
				}
			};
			// First, and unconditionally: a live channel counts as activity on every
			// backend, so a tunnel left open keeps the container from ever going
			// idle - a bill rather than an error, with nothing to surface it.
			await step('close-tunnel', () => tunnel?.close());
			await step('persist-rotated-auth', persistRotatedAuth);
			await step('remove-prompt', () => workspaceFiles.remove(promptRelPath));
			// Home-rooted config files carrying a per-run secret (Antigravity's
			// mcp_config.json holds the agent JWT): scrub them so the token does not
			// sit in the pooled container's home between runs.
			if (context.homeConfigScrubPaths.length > 0) {
				await step('scrub-home-config', async () => {
					const homeFiles = deps.docker.files(containerId, containerHomeDir(runUser));
					for (const rel of context.homeConfigScrubPaths) await homeFiles.remove(rel);
				});
			}
			// The tunnel's config, for the same reason as the prompt: a pooled
			// container serves run after run, so one file per run accumulates there
			// forever. It carries hostnames only - never a secret value - so this is
			// housekeeping rather than a scrub, but on a container with a 3 GB disk
			// budget nothing gets to grow without a bound.
			await step('remove-tunnel-config', () =>
				workspaceFiles.remove(join('.hezo', 'tunnel', `${heartbeatRunId}.json`)),
			);
			await step('remove-home-mount', async () => {
				// Removing the per-run home was never tidiness - it holds the provider
				// credential, so this is a scrub. It goes through the seam because on a
				// managed backend the directory is inside the sandbox, where a host
				// `rmSync` would silently no-op while looking like it worked.
				const dirToRemove =
					context.subscriptionMount?.containerDir ?? context.homeMount?.containerDir;
				if (!dirToRemove) return;
				await deps.docker.files(containerId, dirToRemove).removeDir('.');
			});
			await step('release-ssh-socket', async () => {
				if (deps.sshAgentServer) {
					await deps.sshAgentServer.releaseRunSocket(heartbeatRunId);
				}
			});
			await step('release-egress-proxy', async () => {
				if (deps.egressProxy && egressAllocated) {
					await deps.egressProxy.releaseRunProxy(heartbeatRunId);
				}
			});
			// Back into the pool, warm and idle, with this task recorded so the
			// task's next run gets the container whose worktree is already built.
			// Released here rather than only on the success path: a container held
			// by a failed run is a container no other run can ever have.
			await step('release-pool-container', () => releaseContainer());
		};

		if (runAbort.signal.aborted) {
			await cleanupRunArtifacts();
			return finalizeAbort();
		}

		try {
			if (runAbort.signal.aborted) throw new DOMException('Aborted', 'AbortError');

			// Progress-update runs only call MCP tools; they need no code worktree.
			const prep = task
				? await prepareWorktrees(
						deps,
						runningProject,
						task,
						heartbeatRunId,
						bridge,
						runUser,
						egressEnv,
						emit,
						signal,
					)
				: {
						workingDir: '/workspace',
						designatedRepo: null as RepoRow | null,
						worktrees: [] as WorktreeRef[],
						clones: [] as CloneRef[],
						branch: null as string | null,
						executor: null as GitExecutor | null,
						recoveryFailed: new Set<string>(),
					};

			if (runAbort.signal.aborted) throw new DOMException('Aborted', 'AbortError');

			// Before the write, so an undeliverable prompt fails the run by name rather
			// than as a bare `Argument list too long` from the exec's shell.
			assertPromptDeliverable(context.runtimeType, context.taskPrompt);

			// Through SandboxFiles rather than a host write: the container reads this
			// file, so on a backend whose container is not on this machine the write
			// has to go through the provider's file API. Nothing else about it changes.
			await workspaceFiles.write(promptRelPath, context.taskPrompt);

			const redactedCmd = context.cmd.map((arg) => arg.replace(/Bearer [^"\s]+/g, 'Bearer ***'));
			const promptSuffix =
				context.promptDelivery === 'arg'
					? ` "$(cat ${context.promptFilePath})"`
					: context.promptDelivery === 'file'
						? ' < /dev/null'
						: ` < ${context.promptFilePath}`;
			const invocationCommand = `$ ${redactedCmd.map(shellQuoteArg).join(' ')}${promptSuffix}`;

			await deps.db.query(
				`UPDATE heartbeat_runs SET invocation_command = $1, working_dir = $2 WHERE id = $3`,
				[invocationCommand, prep.workingDir, heartbeatRunId],
			);

			emit('stdout', `${invocationCommand}\n`);

			// Scanned incrementally rather than over a retained transcript: the raw
			// exec output is the full stream-json stream and never kept (see
			// ExecStartOpts.onChunk).
			const backgroundTermination = new BackgroundTerminationDetector();

			// The runtime states its per-server tool counts once, in the session-init
			// event at the very start of the stream, so this is persisted mid-run
			// rather than on the completion path - a run that dies later still leaves
			// behind what it was given. Written once: `init` fires once, and a repeat
			// write would be a no-op UPDATE leaving a dead tuple behind.
			let wroteMcpToolCounts = false;
			const persistMcpToolCounts = async () => {
				if (wroteMcpToolCounts) return;
				const counts = parser.getMcpToolCounts();
				if (!counts) return;
				wroteMcpToolCounts = true;
				try {
					await deps.db.query(
						`UPDATE heartbeat_runs SET mcp_tool_counts = $1::jsonb WHERE id = $2`,
						[JSON.stringify(counts), heartbeatRunId],
					);
				} catch (e) {
					// Diagnostic state only. A run must never fail because we could not
					// record what its tool list looked like.
					log.warn('could not record MCP tool counts', {
						runId: heartbeatRunId,
						error: (e as Error).message,
					});
				}
			};

			const onChunk = async (chunk: ExecLogChunk) => {
				backgroundTermination.push(chunk.stream, chunk.text);
				const rendered =
					chunk.stream === 'stdout' ? parser.onStdout(chunk.text) : parser.onStderr(chunk.text);
				if (rendered) emit(chunk.stream, rendered);
				// Surface the latest running usage to the log flush so it's persisted
				// crash-safely (see currentUsage / onFlush above).
				currentUsage = parser.getUsage();
				await persistMcpToolCounts();
			};

			// Unelevated: the agent writes into the bind-mounted worktree, and those
			// files must stay owned by the run user rather than root.
			const execOutcome = await dockerSandboxHandle(deps.docker, containerId, runUser).exec({
				cmd: context.execCmd,
				env: context.env,
				workingDir: prep.workingDir,
				// The derived signal, so a tunnel that dies mid-run tears the exec down
				// instead of leaving it to burn the rest of the budget toolless.
				signal: runAbort.signal,
				onChunk,
			});
			const tail = parser.flush();
			if (tail) emit('stdout', tail);
			const durationMs = Date.now() - startTime;
			const exitedClean = execOutcome.exitCode === 0;

			// Report auto-pushes that were denied during the run. The post-commit hook
			// is deliberately non-fatal, so without this the human sees a run that
			// "succeeded" while its commits never left the container — the exact shape
			// of a repo the connected GitHub account can read but not write.
			for (const clone of prep.clones) {
				const pushErrors = await readPushErrors(clone);
				if (!pushErrors) continue;
				emit(
					'stderr',
					`[system] auto-push failed during this run in ${clone.containerPath} — ` +
						`commits are local only. Check the connected GitHub account's write access ` +
						`to this repository.\n${pushErrors}\n`,
				);
			}

			// Before the scan: a branch `origin` accepted and no longer advertises is
			// either a merged pull request tidied up after, or work deleted off the remote.
			// Only the git host can tell those apart, and the scan below reads both as
			// safe - so ask, and drop the delivery record when the answer is that nothing
			// merged it. That turns the branch back into ordinary undelivered work, with
			// nothing downstream needing a second case for it.
			await reviewRetractedWork(deps, prep, emit);

			// Whether committed work is about to be left behind in this container only.
			//
			// Decided on a REF COMPARISON, not on the push-error log above: that log is
			// append-only within a run and cleared at prep, so a push that failed at
			// commit 3 and succeeded at commit 5 leaves a non-empty log with nothing
			// actually unpushed. `findUnpushedWork` asks the authoritative question -
			// is the local `hezo/<task>` tip reachable from a remote-tracking ref -
			// which the log cannot answer.
			//
			// Three things follow from a positive finding, and all of them matter only
			// once a project has more than one container (nothing fails at pool size 1,
			// which is why no existing test caught this): the run is not a success, the
			// commits are copied out to the bundle vault so a later run on a DIFFERENT
			// container can pick them up, and the container is pinned against suspend
			// and destroy for as long as it holds the only copy.
			const unpushed =
				prep.executor && prep.branch && prep.clones.length > 0
					? await findUnpushedWork(prep.executor, prep.clones, prep.branch)
					: { work: [], complete: false };
			// The vault decides the PIN; `origin` decides the RUN. Separating the two is
			// the point of the vault: a copy Hezo holds means the container is no longer
			// the only place the work exists, so it may be released - but the work still
			// has not reached the human's git host, so the run must still fail and say
			// so. Conflating them would let a vaulted run read as a success.
			const stranded = await vaultUnpushedWork(deps, project, containerId, unpushed, prep, emit);
			await setPoolMemberUnpushedFlag(
				deps.db,
				containerId,
				// `complete: false` means the check could not answer, so it may neither
				// fail the run nor release a pin an earlier run set.
				stranded ? true : unpushed.work.length > 0 ? false : unpushed.complete ? false : null,
			);
			const unpushedError =
				unpushed.work.length > 0 ? describeUnpushedWork(unpushed.work) : undefined;

			// Grok and Kimi Code emit no usage on their streams; recover it from the
			// file each writes into the per-run home mount, then scrub that file (both
			// can carry the provider credential). Falls back to null (⇒ $0) if the log
			// is missing/unparseable; the home mount is removed at cleanup anyway.
			const runUsage = await recoverOffStreamRunUsage(
				runtimeType,
				context.homeMount ? deps.docker.files(containerId, context.homeMount.containerDir) : null,
				priceFn,
				(msg) => log.error(`Run ${heartbeatRunId}: ${msg}`),
			);

			// A clean exit is only a real success if the run produced persisted
			// output: a Hezo write (comment/task/doc/blocker/…, flagged on the run
			// row by the MCP tool layer) or a code change in a worktree. A run that
			// exits 0 having written nothing — e.g. a model that drifts into plan
			// mode and only describes a plan — is a no-op, not a success, and is
			// marked failed so it surfaces and is retried rather than silently
			// counting as servicing the task.
			//
			// The exception is a run that explicitly declared it had nothing to do
			// via the `report_no_work` MCP tool (reported_no_work). That is a
			// legitimate idle wake (e.g. a planning task whose sub-tasks are still
			// open), so it counts as a success even though it wrote nothing.
			let producedOutput = false;
			let reportedNoWork = false;
			let noWorkReason: string | null = null;
			if (exitedClean) {
				const flagged = await deps.db.query<{
					produced_output: boolean;
					reported_no_work: boolean;
					no_work_reason: string | null;
				}>(
					'SELECT produced_output, reported_no_work, no_work_reason FROM heartbeat_runs WHERE id = $1',
					[heartbeatRunId],
				);
				const hezoWrite = flagged.rows[0]?.produced_output ?? false;
				// A dirty worktree counts as output **only** if the run could reach Hezo
				// at all. Without that qualifier a run whose MCP server never connected -
				// so it could not read a task, post a comment, or even call
				// `report_no_work`, all of which are MCP tools - graded as a success on
				// the strength of a scratch file, with no Hezo-side record of anything.
				// A terminal error captured from the runtime's own report is exactly the
				// signal for "nothing this run did was persisted anywhere Hezo can see".
				const reachedHezo = hezoWrite || parser.getTerminalError() === null;
				producedOutput =
					hezoWrite ||
					(reachedHezo &&
						prep.executor !== null &&
						(await anyWorktreeChanged(prep.executor, prep.worktrees)));
				reportedNoWork = flagged.rows[0]?.reported_no_work ?? false;
				noWorkReason = flagged.rows[0]?.no_work_reason ?? null;
			}

			// Deterministic handoff-delivery net. An agent that ends its turn with its
			// reply in its FINAL MESSAGE rather than a create_comment call strands the
			// work: a run's final message is logged, never posted, so it reaches nobody.
			// Three stranded forms are handled here, differently:
			//   (1) an active `@`-mention the run never posted as a comment — the agent
			//       wrote an explicit, unambiguous wake, so deliver the message verbatim
			//       via postAgentComment (admin inbox / agent wakeup), flipping the run
			//       to a success. This is the deterministic backstop to the completeness
			//       stop-hook judge (best-effort, model-dependent).
			//   (2) a NAME-ONLY address that reads like an ask — the unlinked bold/
			//       leading-line form (`**slug** — … when you resume …`) or the passive
			//       `@@slug` one (`Ready for @@slug review.`) — the wakes-no-one trap in
			//       both its spellings. We do NOT auto-deliver or rewrite the agent's words
			//       to force a wake (that guesses intent and overreaches). create_comment
			//       already warns the agent interactively on both, but the final-message
			//       path skips that check, so surface the same warning in the run log; the
			//       handoff is left undelivered.
			//   (3) a plain DIRECT ANSWER (no mention, no ask) to whoever addressed this
			//       agent by replying to or @-mentioning it — the "give me the link" case,
			//       and the review-handoff one where a teammate @-mentions the reviewer and
			//       the verdict ends up only in the final message. The asker expects the
			//       answer in the thread, so post it verbatim as a reply to the waking
			//       comment. Scoped to wakes where the run posted no comment of its own, so
			//       it never turns a routine work-summary into thread noise; agent-authored
			//       wakes qualify only via an active mention, which is also what makes the
			//       delivery non-looping (see the branch itself).
			// Best-effort: a failure here must never throw out of the run-completion path.
			// Runs on every runtime, including OpenCode, which has no stop-hook judge.
			//
			// A run that called `report_no_work` is excluded outright. Every form above
			// is a HANDOFF the agent failed to deliver, and an agent that declared it
			// had nothing to do handed nothing over - its final message is a status
			// note. Delivering it posts a comment the agent decided not to write, fans
			// it out to the @admin inbox on every idle wake, and flips
			// `produced_output`, grading the no-op as productive work and hiding it
			// from the no-work backoff that damps the next dispatch.
			if (exitedClean && task && !reportedNoWork) {
				try {
					const finalMessage = parser.getFinalAssistantMessage();
					if (finalMessage?.trim()) {
						const activeMentions = extractMentionSlugs(finalMessage);
						// Name-only asks — a handoff written in a form that wakes nobody —
						// scoped to the run team's roster + HQ instance agents + @admin (the
						// slugs a mention here can wake). Both spellings count: the bare/bold
						// name (`**slug** — …`) and the passive `@@slug`, which renders as a
						// delivered-looking chip and is the likelier of the two to end a
						// verdict report ("Ready for @@marketing-lead review.").
						const roster = await resolveWarnableSlugs(deps.db, runTeamId, agent.id);
						const nameOnlyAsks = Array.from(
							new Set([
								...detectUnlinkedTeammateAsks(finalMessage, roster),
								...detectPassiveTeammateAsks(finalMessage, roster),
							]),
						);
						// A run woken by a human addressing this agent directly (reply to its
						// comment / @-mention) is expected to answer in the thread. The waking
						// comment id lets us both check its author is human (not an agent — we
						// don't auto-deliver agent-to-agent chatter) and thread the reply under it.
						const wakingCommentId =
							typeof wakeupPayload?.comment_id === 'string' ? wakeupPayload.comment_id : null;
						const directQuestionWake =
							(wakeupPayload?.source === WakeupSource.Reply ||
								wakeupPayload?.source === WakeupSource.Mention) &&
							wakingCommentId !== null;
						if (activeMentions.length > 0 || nameOnlyAsks.length > 0 || directQuestionWake) {
							// Text comments this run posted, with their task, used to skip a mention
							// it already delivered (the same extractor fireCommentWakeups uses) and to
							// tell whether it already answered this task's thread (case 3).
							const posted = await deps.db.query<{ task_id: string; content: unknown }>(
								`SELECT task_id, content FROM task_comments WHERE created_by_run_id = $1 AND content_type = 'text'`,
								[heartbeatRunId],
							);
							const delivered = new Set<string>();
							for (const c of posted.rows) {
								for (const slug of extractMentionSlugs(c.content)) delivered.add(slug);
							}

							if (activeMentions.length > 0 || nameOnlyAsks.length > 0) {
								// (1) Deliver stranded active mentions verbatim.
								const undeliveredActive = activeMentions.filter((slug) => !delivered.has(slug));
								if (undeliveredActive.length > 0) {
									await postAgentComment({
										db: deps.db,
										wsManager: deps.wsManager,
										teamId: runTeamId,
										projectId: project.id,
										taskId: task.id,
										authorMemberId: agent.id,
										createdByRunId: heartbeatRunId,
										text: finalMessage,
									});
									// The run delivered a real comment, so it is no longer a no-op:
									// flip the local flag (drives `success` below) and the row column
									// (what the MCP write path sets) so status and produced_output agree.
									await deps.db.query(
										'UPDATE heartbeat_runs SET produced_output = true WHERE id = $1',
										[heartbeatRunId],
									);
									producedOutput = true;
									// The comment just posted IS the final message, so every active
									// mention in it is now delivered. Record that before (2) runs: a
									// final message can carry both spellings for the same teammate
									// (a passive line-opening address plus a mention elsewhere), and
									// without this (2) would warn that a handoff was "NOT delivered"
									// one statement after delivering it.
									for (const slug of activeMentions) delivered.add(slug);
									emit(
										'stdout',
										`\n[runner] auto-delivered stranded handoff (@${undeliveredActive.join(', @')}) from the run's final message as a comment\n`,
									);
								}

								// (2) Warn about a stranded name-only ask — do NOT deliver or rewrite.
								const strandedAsks = nameOnlyAsks.filter((slug) => !delivered.has(slug));
								if (strandedAsks.length > 0) {
									const named = strandedAsks.map((s) => `**${s}**`).join(', ');
									const fixes = strandedAsks.map((s) => `@${s}`).join(', ');
									emit(
										'stdout',
										`\n[runner] WARNING: this run's final message addresses ${named} without an active @-mention — a bare or bold name, a passive @@<name>, or a sign-off gate like "awaiting <name> sign-off" / "ready for <name> review", renders as inert text or a delivered-looking chip and wakes no one, so the handoff was NOT delivered. Post a comment with an active mention (${fixes}) to reach them.\n`,
									);
								}
							} else if (directQuestionWake && !posted.rows.some((c) => c.task_id === task.id)) {
								// (3) Someone addressed this agent directly and the run posted no comment
								// on this task — the answer is stranded in the final message. Deliver it
								// when the ask was unambiguous: any human/admin reply or mention, or a
								// TEAMMATE'S ACTIVE @-MENTION. That last case is the review-handoff one —
								// a teammate @-mentions the reviewer, the reviewer does the whole review
								// and ends the run with its verdict only in the final message, so the
								// task sits in `review` with nobody woken. An agent's *reply* wake stays
								// excluded as the routine chatter it usually is.
								//
								// Admitting agent mentions is safe for a structural reason, not a
								// heuristic one: this branch only runs when the final message carries no
								// active mention, so a comment auto-delivered here can never produce a
								// Mention wakeup — fireCommentWakeups will at most fire an explicit
								// *reply* wakeup on it. The next hop therefore arrives as
								// Reply-authored-by-an-agent, which this branch skips, so two agents can
								// never auto-deliver back and forth at each other.
								const asker = await deps.db.query<{ from_agent: boolean }>(
									`SELECT EXISTS (
										SELECT 1 FROM member_agents ma WHERE ma.id = tc.author_member_id
									 ) AS from_agent
									 FROM task_comments tc WHERE tc.id = $1`,
									[wakingCommentId],
								);
								const askerRow = asker.rows[0];
								const askIsDeliverable =
									askerRow !== undefined &&
									(askerRow.from_agent === false || wakeupPayload?.source === WakeupSource.Mention);
								if (askIsDeliverable) {
									await postAgentComment({
										db: deps.db,
										wsManager: deps.wsManager,
										teamId: runTeamId,
										projectId: project.id,
										taskId: task.id,
										authorMemberId: agent.id,
										createdByRunId: heartbeatRunId,
										parentCommentId: wakingCommentId ?? undefined,
										text: finalMessage,
									});
									await deps.db.query(
										'UPDATE heartbeat_runs SET produced_output = true WHERE id = $1',
										[heartbeatRunId],
									);
									producedOutput = true;
									emit(
										'stdout',
										`\n[runner] auto-delivered the run's final message as a reply — it answered a direct question but posted no comment\n`,
									);
								}
							}
						}
					}
				} catch (e) {
					log.error(`Run ${heartbeatRunId} handoff-delivery guardrail failed:`, e);
				}
			}

			// Structural "no-wake exit" backstop — the one check in this file that
			// reads no prose at all.
			//
			// The two guardrails above and create_comment's advisories all classify
			// TEXT, so each new phrasing that strands a handoff needs new vocabulary.
			// This one asks a question the system can answer from its own state: did
			// this run end having woken NOBODY, on a task it left open, after naming a
			// teammate in a form that notifies no one? That combination is what a
			// stranded handoff actually IS, whatever words carried it.
			//
			// It also covers the structural hole the net above cannot reach: that net
			// only inspects the run's FINAL MESSAGE, and create_comment only inspects
			// one comment at a time, so nothing looks at what a run achieved in
			// aggregate — which is exactly where a passively-addressed ask posted as a
			// comment lives.
			//
			// The aggregate is PER TASK, not per run. A run comments on whatever tasks
			// it touches, so "did this run wake anyone" answered run-wide lets a run
			// that woke a teammate on its own task strand a handoff on another one and
			// still pass clean — the shape of the incident this scoping came from. Each
			// task the run commented on is judged on its own comments, its own wakes and
			// its own status; the run's own task is always judged, since its handoff can
			// live in the final message with no comment posted at all.
			//
			// Warn-only, deliberately: the standing posture is that the system never
			// fabricates a wake from a non-`@` signal.
			if (exitedClean && task) {
				try {
					const posted = await deps.db.query<{
						task_id: string;
						content: unknown;
						parent_comment_id: string | null;
					}>(
						`SELECT task_id, content, parent_comment_id FROM task_comments
						 WHERE created_by_run_id = $1 AND content_type = 'text'`,
						[heartbeatRunId],
					);
					// The run's own task is always judged, even with no comment on it:
					// that is where a handoff stranded in the final message lives, and the
					// final message is outward-facing on that task alone (it is not
					// addressed to any other task's thread).
					const findings = await detectNoWakeExits(deps.db, {
						selfMemberId: agent.id,
						comments: posted.rows,
						extraOutward: new Map([[task.id, [parser.getFinalAssistantMessage() ?? '']]]),
						runId: heartbeatRunId,
					});
					for (const finding of findings) {
						emit('stdout', `\n[runner] WARNING: ${formatNoWakeExitWarning(finding, 'this run')}\n`);
					}
				} catch (e) {
					log.error(`Run ${heartbeatRunId} no-wake exit check failed:`, e);
				}
			}

			// Stray-project-doc net. Project docs live in the database, and every
			// prompt says so, but an agent that reaches for the Write tool anyway
			// gets no error: writing a fresh path SUCCEEDS, so the DB doc silently
			// stays stale and a shadow copy lands in the repo. This is the
			// deterministic backstop for that - it reaches every runtime, including
			// the ones with no blockable tool hook at all.
			//
			// Warn, never auto-ingest: the file's relationship to the doc is a guess
			// (newer? older? a partial draft?), and guessing wrong overwrites real
			// work. Same posture as the name-only-ask branch above.
			//
			// Scope is deliberately narrow: an untracked `.md` whose basename matches
			// an ACTIVE project-doc slug in this project. A tracked file of the same
			// name is a genuine repo file (a repo may legitimately carry its own
			// spec.md) and is left alone. A doc-shaped file with a name no doc uses
			// is not flagged - that would be guesswork, and this net is worth more
			// being trusted than being exhaustive.
			if (exitedClean && project && prep.executor && prep.worktrees.length > 0) {
				try {
					const slugs = await deps.db.query<{ slug: string }>(
						`SELECT slug FROM documents
						 WHERE type = 'project_doc' AND project_id = $1 AND archived_at IS NULL`,
						[project.id],
					);
					const docSlugs = new Set(slugs.rows.map((r) => r.slug.toLowerCase()));
					if (docSlugs.size > 0) {
						const strays: string[] = [];
						for (const wt of prep.worktrees) {
							const changed = await worktreeChangedPaths(prep.executor, wt.loc);
							for (const p of changed) {
								const base = p.split('/').pop() ?? p;
								if (!base.toLowerCase().endsWith('.md')) continue;
								if (!docSlugs.has(base.toLowerCase())) continue;
								if (await worktreeTracksPath(prep.executor, wt.loc, p)) continue;
								strays.push(p);
							}
						}
						if (strays.length > 0) {
							emit(
								'stderr',
								`\n[runner] WARNING: this run wrote ${strays.join(', ')} to the repo, but ${
									strays.length === 1 ? 'that filename is' : 'those filenames are'
								} a project doc - project docs live in the database, not the filesystem, so the file changed nothing anyone will read and the real doc is now stale. Re-apply the change with write_project_doc (or edit_project_doc for part of one) and drop the file from the worktree.\n`,
							);
						}
					}
				} catch (e) {
					log.error(`Run ${heartbeatRunId} stray-project-doc check failed:`, e);
				}
			}

			// A clean exit where the runtime force-terminated still-running background
			// work is NOT a success: the run abandoned unfinished work (e.g. a
			// deep-research Workflow that never got to synthesize its report) even
			// though it exits 0 and may have written something earlier. Fail it so it
			// surfaces and is retried rather than silently counting as done.
			const backgroundWorkTerminated =
				exitedClean &&
				Boolean(RUNTIME_ADAPTERS[runtimeType].terminatesBackgroundWork) &&
				backgroundTermination.finish();

			const success =
				exitedClean &&
				(producedOutput || reportedNoWork) &&
				!backgroundWorkTerminated &&
				!unpushedError;
			const backgroundError = backgroundWorkTerminated
				? 'run ended with background tasks still running — the runtime terminated the unfinished work before it completed, so the run abandoned incomplete work'
				: undefined;
			const noOutputError =
				exitedClean && !producedOutput && !reportedNoWork && !backgroundWorkTerminated
					? 'run produced no output (no code changes, comments, tasks, documents, or other writes)'
					: undefined;
			// A process a signal destroyed reports nothing at all: it emits no terminal
			// event for the parser to capture, and the two errors above are gated on a
			// clean exit. Without this the run row's error is empty and the only trace
			// of an out-of-memory kill is a bare `Killed` in the log.
			//
			// The memory cap is read only once a signal is in hand, so a run that exits
			// normally pays no extra query.
			const signalError =
				(signalFromExitCode(execOutcome.exitCode)
					? describeSignalExit(execOutcome.exitCode, {
							memoryLimitGib: await projectContainerMemoryGb(deps.db, project.id),
						})
					: null) ?? undefined;
			// A failed run's terminal error (e.g. a provider billing/auth rejection)
			// otherwise lives only in the log; surface it on the run row so the board
			// shows why the run failed instead of a bare "failed".
			const terminalError = success ? null : parser.getTerminalError();
			// The backstop that keeps a failed run from reporting nothing. Every cause
			// above is conditional: two are gated on a clean exit, one on a signal, and
			// the last on the runtime having reported something the parser recognises. A
			// CLI that exits non-zero having said nothing intelligible - a rejected
			// credential, an argument the CLI refused, a runtime whose parser extracts no
			// terminal error - matches none of them, and without this the row carries a
			// status and an exit code but no reason. It claims only what is certain: the
			// exit code is the one fact such a run always leaves behind.
			const unexplainedExitError =
				!success && !exitedClean
					? `agent CLI exited with code ${execOutcome.exitCode} without reporting a reason - see the log above for anything the CLI printed`
					: undefined;
			// Ordered by what the human has to act on. Stranded commits come first
			// because they are the only one where the fix is time-sensitive: the work
			// exists in exactly one container.
			//
			// `terminalError` outranks `noOutputError` because it is the *cause* and
			// the other is the symptom: a run whose MCP server never connected, or
			// whose provider rejected the credential, produced no output precisely
			// because of that - and reporting "produced no output" first sends the
			// reader after the model instead of the transport.
			//
			// `signalError` outranks `terminalError` by that same rule one rung up:
			// nothing the runtime reported mid-stream caused the kernel to destroy the
			// process, and the kill is the later and dispositive fact. Demoting the
			// terminal error costs the log nothing, because both of its writers already
			// push their own line into the stream as they detect it.
			//
			// Its position relative to `backgroundError` and `noOutputError` is
			// arbitrary - both are gated on a clean exit and so cannot co-occur with a
			// signal. It stays below `unpushedError` deliberately, at the accepted cost
			// that a run that committed and was then killed reports the stranded
			// commits and leaves the signal to the exit-code column.
			if (unpushedError) emit('stderr', `\n[runner] ${unpushedError}\n`);
			else if (backgroundError) emit('stderr', `\n[runner] ${backgroundError}\n`);
			else if (signalError) emit('stderr', `\n[runner] ${signalError}\n`);
			else if (terminalError) emit('stderr', `\n[runner] ${terminalError}\n`);
			else if (noOutputError) emit('stderr', `\n[runner] ${noOutputError}\n`);
			else if (reportedNoWork && !producedOutput)
				emit('stdout', `\n[runner] no work to do${noWorkReason ? ` — ${noWorkReason}` : ''}\n`);
			else if (unexplainedExitError) emit('stderr', `\n[runner] ${unexplainedExitError}\n`);

			await deps.logs.end(streamId);
			await updateHeartbeatRun(
				deps.db,
				heartbeatRunId,
				{
					status: success ? HeartbeatRunStatus.Succeeded : HeartbeatRunStatus.Failed,
					exitCode: execOutcome.exitCode,
					durationMs,
					error:
						unpushedError ??
						backgroundError ??
						signalError ??
						terminalError ??
						noOutputError ??
						unexplainedExitError ??
						undefined,
					// Grok's usage comes from the debug log (runUsage); every other
					// runtime reports it on the stream (parser.getUsage()).
					usage: runUsage ?? parser.getUsage(),
					// The stream ran to its terminal event, so this usage is final, not a
					// mid-run snapshot — clear the partial flag any earlier flush set.
					usagePartial: false,
				},
				runBroadcast,
			);

			await cleanupRunArtifacts();
			return { success, exitCode: execOutcome.exitCode, stderr: '', durationMs, heartbeatRunId };
		} catch (error) {
			const durationMs = Date.now() - startTime;
			const isAbort = (error as Error).name === 'AbortError';
			const reason = runAbortReason(runAbort.signal);
			// Same verdict the setup window records, from one implementation - see
			// `throwVerdict`, which carries the reasoning.
			const { status, message: errorMessage } = throwVerdict(error);

			// Aborting the exec only tears down its attach stream — Docker leaves the
			// agent CLI running in the container, so a user-terminated or timed-out run
			// keeps burning tokens and writing to the workspace despite reading as
			// cancelled. Hard-kill the run's whole process tree so the abort is what the
			// UI promises: immediate, with in-progress work lost. Skipped when the
			// container itself died (`container_*`) — the process is already gone with
			// it — and best-effort so a kill failure never masks the run result.
			if (isAbort && reason !== 'container_stopped' && reason !== 'container_error') {
				try {
					await deps.docker.killRunProcesses(containerId, heartbeatRunId);
				} catch (killError) {
					log.error(
						`Run ${heartbeatRunId}: failed to kill container processes on abort:`,
						killError,
					);
				}
			}

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
					// Persist whatever the parser captured before the throw/abort; leave
					// usage_partial as the last flush set it (true once any usage landed).
					usage: parser.getUsage(),
				},
				runBroadcast,
			);

			// A lost output stream is the infrastructure losing the run, not the agent
			// failing it: the channel carrying stdout died while the command was still
			// going. That is the same class as the run's driver dying, which already
			// has a bounded retry that carries the previous attempt's log tail
			// forward and escalates to an approval once it stops being worth
			// retrying - so it takes that path instead of burning the agent's turn on
			// a transport fault.
			//
			// Read from the shared classifier rather than a local `instanceof`, so the
			// exec path and the setup window agree on what a retry is for and widening
			// the set is one row rather than a second condition here.
			if (classifyRunFailure(error) === RunFailureClass.Transient) await spendLostRunStrike();

			await cleanupRunArtifacts();
			return {
				success: false,
				exitCode: -1,
				stderr: errorMessage,
				durationMs,
				heartbeatRunId,
				timedOut: reason === 'run_timeout',
			};
		}
	} catch (error) {
		// Every throw between the container claim and the exec lands here: the
		// credential lock, `markHeartbeatRunRunning`, the run-user probe, the ssh and
		// egress allocations, the connector load, the tunnel, `buildRunContext`.
		//
		// Before this the only handler was the `finally` below. It released the run's
		// resources and let the error leave `runAgent`, so the row stayed `running`
		// with no error on it - and nothing downstream could then tell the truth.
		// `postFailurePing` reads the row and returns early on a non-terminal status,
		// so the task thread said nothing at all, and 30s later the orphan pass
		// recorded that the process was no longer running when the process was alive
		// and had thrown. The row is the record of what happened, so it is written
		// here, by the code that holds the actual error.
		//
		// Returning rather than rethrowing is load-bearing: it routes into the
		// job manager's normal completion path, so the wakeup settles, the failure
		// ping fires and the next task is chained - all against a terminal row.
		//
		// `cleanupRunArtifacts` is deliberately not called: it is declared inside the
		// exec block and is not in scope. The `finally` below is what releases the
		// tunnel, both host ports and the container claim on this path, which is the
		// job it was written for.
		const verdict = throwVerdict(error);
		const durationMs = Date.now() - startTime;
		log.error(`Run ${heartbeatRunId} failed before the agent could start:`, error);
		emit('stderr', `\n[runner] ${verdict.message}\n`);
		await deps.logs.end(streamId);
		await updateHeartbeatRun(
			deps.db,
			heartbeatRunId,
			{
				status: verdict.status,
				exitCode: -1,
				durationMs,
				error: verdict.message,
			},
			runBroadcast,
		);
		// Only a failure the infrastructure caused earns a recovery retry. A
		// configuration error reproduces identically on every attempt, and the retry
		// that used to be minted for one - by the orphan pass, on a row this path had
		// abandoned - turned a single bad MCP injection into hundreds of failed runs
		// on one task, each having claimed a container first.
		if (
			verdict.status === HeartbeatRunStatus.Failed &&
			classifyRunFailure(error) === RunFailureClass.Transient
		) {
			await spendLostRunStrike();
		}
		return {
			success: false,
			exitCode: -1,
			stderr: verdict.message,
			durationMs,
			heartbeatRunId,
			timedOut: verdict.timedOut,
		};
	} finally {
		releaseCredentialLock?.();
		// These outlive every explicit cleanup path above, so this is the only
		// release that covers a throw in setup. All idempotent, so the success
		// path's own releases - including the one that records task affinity - are
		// not undone here. Each is isolated: a failed release must not stop the
		// others, since between them they hold a container, two host ports and an
		// exec that keeps the container awake.
		for (const [label, release] of [
			['tunnel', () => runTunnel?.close()],
			[
				'ssh-socket',
				() => (sshSocketAllocated ? deps.sshAgentServer?.releaseRunSocket(heartbeatRunId) : null),
			],
			[
				'egress-proxy',
				() => (egressProxyAllocated ? deps.egressProxy?.releaseRunProxy(heartbeatRunId) : null),
			],
			[
				// A scrub, not tidiness: the per-run home carries the run CLI's own
				// model-provider credential in plaintext, the one exception to the rule
				// that no confidential value enters a run. `cleanupRunArtifacts` removes
				// it on every path that reaches it, but it is declared inside the exec
				// block and reads `context` - so a throw in setup, where the files are
				// already written, left the credential on a container the pool hands to
				// the next run. Derived rather than read off `context` for that reason;
				// both home builders produce this same directory.
				'per-run-home',
				async () => {
					if (!containerId) return;
					const dir = getContainerSubscriptionRootImpl(provider, runtimeType, heartbeatRunId);
					if (!dir) return;
					await deps.docker.files(containerId, dir).removeDir('.');
				},
			],
			['pool-container', () => releaseContainer()],
		] as const) {
			try {
				await release();
			} catch (e) {
				log.error(`Run ${heartbeatRunId} final release of '${label}' failed:`, e);
			}
		}
	}
}

function failedResult(stderr: string, startTime: number): RunResult {
	return { success: false, exitCode: -1, stderr, durationMs: Date.now() - startTime };
}

function abortedResult(startTime: number): RunResult {
	return failedResult('Aborted', startTime);
}

export function shellQuoteArg(arg: string): string {
	if (arg === '') return "''";
	if (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(arg)) return arg;
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

interface WorktreeRef {
	loc: WorktreeLoc;
	headBefore: string | null;
}

/** Whether any of a run's worktrees has an uncommitted change or an advanced branch tip. */
async function anyWorktreeChanged(
	executor: GitExecutor,
	worktrees: WorktreeRef[],
): Promise<boolean> {
	for (const wt of worktrees) {
		if (await worktreeHasChanges(executor, wt.loc, wt.headBefore)) return true;
	}
	return false;
}

/**
 * Decide what became of commits `origin` accepted and no longer advertises, and
 * void the delivery record for the ones nothing merged.
 *
 * The accepted-tip marker exists so that merging a pull request and deleting its
 * branch - the workflow the role prompts ask for - is not reported as stranded work.
 * The cost of that is one thing it cannot see on its own: a branch pushed and then
 * deleted **without** being merged looks locally identical, and its commits really
 * have left the remote. Git has nothing left to distinguish them by, because a
 * squash merge preserves no per-commit identity on the default branch, so this asks
 * the git host the one question refs cannot answer.
 *
 * **Only a definite `not_merged` acts.** `unknown` - no connection, a locked vault,
 * a throttled or unreachable host - reports and leaves everything alone, because the
 * primary durability question already answered *yes* (the commits did reach the
 * remote), and turning "we could not ask" into a failed run would reinstate the
 * false positive the marker was added to remove.
 *
 * The host call is reached at all only when a clone is in that state, which on the
 * ordinary path (branch still on the remote, or its tip already merged into a
 * fetched default branch) is never - so a run pays nothing for this until there is
 * something to ask about.
 */
async function reviewRetractedWork(
	deps: RunnerDeps,
	prep: { executor: GitExecutor | null; clones: CloneRef[]; branch: string | null },
	emit: (stream: 'stdout' | 'stderr', text: string) => void,
): Promise<void> {
	const { executor, branch } = prep;
	if (!executor || !branch) return;

	for (const clone of prep.clones) {
		const delivery = await countBranchDelivery(executor, clone, branch);
		if (!delivery?.retracted) continue;

		const sha = await readPushedMarker(executor, clone, branch);
		if (!sha) continue;

		const repoName = basename(clone.containerPath);
		const verdict = await checkRepoCommitMerged(deps, clone.repoId, sha);
		if (verdict === 'merged') continue;
		if (verdict === 'unknown') {
			emit(
				'stderr',
				`[system] ${repoName}: ${branch} is no longer on origin and it could not be ` +
					`confirmed whether its work was merged — treating the ${delivery.retracted} ` +
					`commit(s) origin accepted as delivered.\n`,
			);
			continue;
		}

		await voidPushedMarker(executor, clone, branch);
		emit(
			'stderr',
			`[system] ${repoName}: ${branch} was deleted from origin without being merged — ` +
				`its ${delivery.retracted} commit(s) are no longer on the remote.\n`,
		);
	}
}

/**
 * Copy a run's undelivered commits into the bundle vault, and drop stored bundles
 * whose work has since reached the remote.
 *
 * Returns whether any clone is **still** the only place its commits exist - which
 * is exactly the condition the container pin encodes. A clone whose work was
 * vaulted is not stranded (Hezo holds a copy); a clone whose bundle could not be
 * built, was too large, or could not be moved is, and the pin keeps its container
 * alive until a later run gets the work out.
 *
 * Both halves report into the run log rather than throwing: this runs at finalize,
 * where the run is already being failed for the unpushed work itself, and a
 * recovery failure must sharpen that error rather than replace it with a stack.
 */
async function vaultUnpushedWork(
	deps: RunnerDeps,
	project: { id: string },
	containerId: string,
	unpushed: UnpushedWorkScan,
	prep: {
		executor: GitExecutor | null;
		clones: CloneRef[];
		branch: string | null;
		recoveryFailed: Set<string>;
	},
	emit: (stream: 'stdout' | 'stderr', text: string) => void,
): Promise<boolean> {
	// No executor means no clone was prepared, so the scan found nothing and there
	// is nothing to copy - but an unanswerable scan still may not clear a pin.
	if (!prep.executor || !prep.branch) return unpushed.work.length > 0;
	const vault = createBundleVault(deps.dataDir);
	let stranded = false;

	for (const item of unpushed.work) {
		const repoName = basename(item.repo.containerPath);
		const key = { projectId: project.id, repoName, branch: item.branch };
		const saved = await saveRecoveryBundle(
			vault,
			deps.docker.files(containerId, item.repo.containerPath),
			prep.executor,
			item.repo,
			key,
		);
		if (saved.ok) {
			emit(
				'stderr',
				`[system] ${repoName}: kept a recovery copy of ${item.commits} unpushed ` +
					`commit(s) on ${item.branch} — a later run will pick them up, but they are ` +
					`still not on the remote.\n`,
			);
		} else {
			stranded = true;
			emit(
				'stderr',
				`[system] ${repoName}: could not keep a recovery copy (${saved.reason}) — this ` +
					`container is held open because it has the only copy of ${item.commits} ` +
					`commit(s) on ${item.branch}.\n`,
			);
		}
	}

	// The invalidation half. A clone that answered "nothing unpushed" has its work
	// on the remote, so any bundle stored for it is a stale copy of safe work -
	// the one condition under which the vault drops anything.
	if (unpushed.complete) {
		const withWork = new Set(unpushed.work.map((w) => w.repo.containerPath));
		for (const clone of prep.clones) {
			if (withWork.has(clone.containerPath)) continue;
			// "This clone has nothing unpushed" only implies "the work reached
			// origin" when this clone actually *has* the work. If a stored bundle
			// could not be applied, the commits live solely in that bundle and the
			// scan is trivially clean here - dropping it then destroys the only
			// remaining copy, which is the precise failure the vault exists to
			// prevent. Keep it and let a later run, on a container where the restore
			// works, be the one that clears it.
			if (prep.recoveryFailed.has(clone.containerPath)) continue;
			await releaseRecoveryBundle(vault, {
				projectId: project.id,
				repoName: basename(clone.containerPath),
				branch: prep.branch,
			});
		}
	}
	return stranded;
}

async function prepareWorktrees(
	deps: RunnerDeps,
	project: RunningProjectInfo,
	task: TaskInfo,
	heartbeatRunId: string,
	bridge: BridgeRunnerArgs | null,
	runUser: ContainerRunUser,
	/**
	 * The run's egress proxy as the container reaches it. Prep clones and
	 * fetches authenticate with a placeholder only the proxy can substitute, so
	 * without this a private repo is refused upstream as a bad token — the same
	 * failure a provisioning clone hits without its own allocation.
	 */
	egress: EgressEnvDescriptor | null,
	emit: (stream: 'stdout' | 'stderr', text: string) => void,
	signal?: AbortSignal,
): Promise<{
	workingDir: string;
	designatedRepo: RepoRow | null;
	worktrees: WorktreeRef[];
	/** Each prepared repo's clone — where the auto-push hook records failed pushes. */
	clones: CloneRef[];
	/** The task branch every prepared worktree is on, or null when no repo was prepared. */
	branch: string | null;
	executor: GitExecutor | null;
	/**
	 * Clones (by container path) that had a stored recovery bundle which could
	 * **not** be applied. Carried to finalize because it is the one thing that
	 * makes "this clone has nothing unpushed" uninformative: the commits exist,
	 * they are just not here - so the vault must not drop its copy.
	 */
	recoveryFailed: Set<string>;
}> {
	const emitSystem = (stream: 'stdout' | 'stderr', text: string) =>
		emit(stream, `[system] ${text}\n`);

	const repos = await deps.db.query<RepoRow>(
		`SELECT id, repo_identifier FROM repos
		 WHERE project_id = $1 ORDER BY created_at ASC`,
		[project.id],
	);

	if (repos.rows.length === 0) {
		emitSystem('stdout', '(no repos linked to project — running in /workspace)');
		return {
			workingDir: '/workspace',
			designatedRepo: null,
			worktrees: [],
			clones: [],
			branch: null,
			executor: null,
			recoveryFailed: new Set<string>(),
		};
	}

	return withProjectGitLock(project.id, async () => {
		// Declared before the first early return: it is a pure function of the task,
		// and every exit from here reports which branch the run's work is on.
		const branchName = `hezo/${task.identifier}`;
		// Repos whose stored recovery bundle could not be applied this run. See the
		// field's docstring on the return type - it is what stops finalize reading
		// "nothing unpushed here" as "the work reached origin".
		const recoveryFailed = new Set<string>();
		// All git runs inside the project container; the host only does the bind-mount
		// filesystem checks. Remote ops authenticate over HTTPS with a placeholder the
		// egress proxy substitutes, so they carry the run's proxy env — the same
		// entries the agent CLI gets, from the same builder. The team's git identity
		// (+ signing) is passed so the worktree catch-up merge can record a (verified)
		// merge commit; the run team owns this, matching the agent's own in-container
		// commits.
		const gitIdentityEnv = await buildGitIdentityEnv(deps.db, deps.masterKeyManager, {
			projectId: project.id,
			teamId: project.team_id,
		});
		const gitPrepEnv = egress
			? [...gitIdentityEnv, ...buildEgressProxyEnv(egress)]
			: gitIdentityEnv;
		// The run id doubles as the exec scope marker so an abandoned prep op's
		// git/ssh/bridge tree stays killable; the agent CLI hasn't started yet, so
		// a prep-abort marker kill can only hit prep's own processes.
		const executor = ContainerGitExecutor.forPrep(
			deps.docker,
			project.container_id,
			bridge,
			runUser,
			heartbeatRunId,
			gitPrepEnv,
			signal,
		);

		emitSystem('stdout', '(syncing repos...)');
		const syncRes = await ensureProjectRepos(
			deps.db,
			{ id: project.id, team_id: project.team_id },
			deps.dataDir,
			executor,
			emitSystem,
		);
		if (syncRes.cloned.length > 0) {
			emitSystem('stdout', `(cloned ${syncRes.cloned.length} repo(s) on demand)`);
		}
		if (syncRes.repaired.length > 0) {
			emitSystem('stdout', `(repaired ${syncRes.repaired.length} repo(s) with a broken origin)`);
		}

		if (signal?.aborted) {
			return {
				workingDir: '/workspace',
				designatedRepo: null,
				worktrees: [],
				clones: [],
				branch: branchName,
				executor,
				recoveryFailed,
			};
		}

		const workspaceRoot = getWorkspacePath(deps.dataDir, project.team_id, project.id);
		const worktreesRoot = getWorktreesPath(deps.dataDir, project.team_id, project.id);
		const taskWorktreeRoot = join(worktreesRoot, task.identifier);
		const containerWorktreeRoot = `${CONTAINER_WORKTREES_ROOT}/${task.identifier}`;
		mkdirSync(taskWorktreeRoot, { recursive: true });
		// Also create the root from inside the container and confirm it is visible
		// there. The host mkdir above may not have propagated into the container yet
		// (bind-mount propagation lag, most visibly right after a reprovision), and the
		// chown below is skipped for a root run-user — so without this the in-container
		// `git worktree add` can fail with ENOENT on the worktree path. The readiness
		// check retries until the dir stats as present in the container's namespace.
		await ensureContainerDirReady(deps.docker, project.container_id, containerWorktreeRoot);
		// Give the run-user ownership so the in-container `git worktree add` (run as
		// the run-user) can populate it. No-op when the run-user is root.
		await chownToRunUser(deps.docker, project.container_id, runUser, [containerWorktreeRoot]);

		// Addressed inside the container, with the seam rooted there. A host path
		// would only line up while the container is on this machine.
		const repoLocOf = (name: string): RepoLoc => {
			const containerPath = `${CONTAINER_WORKSPACE_ROOT}/${name}`;
			return { containerPath, files: deps.docker.files(project.container_id, containerPath) };
		};
		const wtLocOf = (name: string): WorktreeLoc => {
			const containerPath = `${CONTAINER_WORKTREES_ROOT}/${task.identifier}/${name}`;
			return { containerPath, files: deps.docker.files(project.container_id, containerPath) };
		};

		const worktreeErrors = new Map<string, string>();
		for (const repo of repos.rows) {
			if (signal?.aborted) break;
			const repoName = repoNameFromIdentifier(repo.repo_identifier);
			const repoLoc = repoLocOf(repoName);

			if (!(await repoLoc.files.exists('.git'))) {
				worktreeErrors.set(repo.id, 'repo is not cloned');
				emitSystem('stderr', `(skipping worktree for ${repoName} — not cloned)`);
				continue;
			}

			// Install/refresh the auto-push post-commit hook so every commit the agent
			// makes this run is pushed to origin immediately — committed work then
			// survives an aborted or timed-out run instead of dying with the ephemeral
			// worktree. Idempotent and best-effort (never throws). Clearing the hook's
			// error log here scopes what the run reports at finalize to this run's own
			// failed pushes.
			await ensurePushHook(repoLoc);
			await clearPushErrors(repoLoc);

			// Bootstrap a connected repo that has no commits yet: `git worktree add`
			// can't branch off an unborn HEAD, so an empty remote would otherwise fail
			// worktree prep below with "clone is empty (no commits fetched)". Seed a
			// minimal README initial commit and push it so the repo has a default branch;
			// the fetch just below then materializes its `origin/*` tracking refs. No-op
			// when the remote already has commits.
			const seed = await seedInitialCommitIfEmpty(executor, repo.repo_identifier, repoLoc, true);
			if (seed.seeded) {
				emitSystem('stdout', `seeded initial commit for ${repoName} (remote was empty)`);
			} else if (seed.error) {
				emitSystem('stderr', `could not seed initial commit for ${repoName}: ${seed.error}`);
			}

			emitSystem('stdout', `git fetch ${repoName}...`);
			const fetchRes = await fetchRepo(executor, repoLoc);
			if (fetchRes.success) {
				emitSystem('stdout', `git fetch ${repoName} done`);
			} else {
				emitSystem('stderr', `git fetch ${repoName} failed: ${fetchRes.error ?? '?'}`);
			}

			// Keep the clone's local default branch (the "main codebase") current with
			// the remote — a clean fast-forward, since the clone holds no local commits
			// on its default.
			const ffWarn = await fastForwardLocalDefault(executor, repoLoc);
			if (ffWarn) emitSystem('stderr', `${repoName}: ${ffWarn}`);

			// Recover commits an earlier run left in a DIFFERENT container because its
			// push was denied. This is the half of the durability story that only
			// matters once a project has more than one container: without it, run 2
			// silently starts from a remote that never received run 1's work.
			//
			// Strictly after the origin fetch above: the stored bundle is a delta whose
			// prerequisites are the remote tips, so git refuses to apply it to a clone
			// that has not caught up. That ordering is enforced by git, not just by
			// this comment.
			const recovered = await restoreRecoveryBundle(
				createBundleVault(deps.dataDir),
				deps.docker.files(project.container_id, repoLoc.containerPath),
				executor,
				repoLoc,
				{ projectId: project.id, repoName, branch: branchName },
			);
			if (!recovered.ok) {
				// A bundle exists for this branch and this clone does not have its
				// commits. Recorded so finalize does not mistake "nothing unpushed
				// here" for "the work is safely on origin" and drop the only copy.
				recoveryFailed.add(repoLoc.containerPath);
				emitSystem('stderr', `${repoName}: ${recovered.reason}`);
			} else if (recovered.bytes !== null) {
				emitSystem(
					'stdout',
					`${repoName}: recovered commits an earlier run could not push (${recovered.bytes} bytes)`,
				);
			}

			emitSystem('stdout', `git worktree ${repoName}...`);
			const wt = await ensureTaskWorktreeWithRetry(
				executor,
				repoLoc,
				wtLocOf(repoName),
				branchName,
				async () => {
					// A transient bind-mount ENOENT right after a reprovision — re-assert the
					// worktree root is visible in-container before git retries the add.
					await ensureContainerDirReady(deps.docker, project.container_id, containerWorktreeRoot);
					emitSystem('stderr', `git worktree ${repoName}: mount not ready, retrying`);
				},
			);
			if (!wt.success) {
				worktreeErrors.set(repo.id, wt.error ?? 'unknown');
				emitSystem('stderr', `git worktree for ${repoName} failed: ${wt.error ?? 'unknown'}`);
			} else {
				if (wt.created) {
					emitSystem('stdout', `git worktree add ${repoName} @ ${branchName}`);
				}
				// Bring any recovered commits onto the task branch itself. Fetching them
				// above made them present (so nothing is lost); this is what makes them
				// the agent's starting point rather than a ref it would have to know to
				// look for. Fast-forward only, and non-fatal either way.
				const replayed = await fastForwardFromRecovery(executor, wtLocOf(repoName), branchName);
				if (replayed.warning) {
					emitSystem('stderr', `${repoName}: ${replayed.warning}`);
				} else if (replayed.merged) {
					emitSystem('stdout', `${repoName}: replayed recovered commits onto ${branchName}`);
				}

				// Catch the task branch up to the freshly-fetched trunk so a resumed run
				// starts from current default instead of forcing the agent to merge by
				// hand. A merge failure is non-fatal — the worktree is still usable and
				// the agent reconciles — so it never enters worktreeErrors.
				const caughtUp = await mergeDefaultIntoWorktree(executor, repoLoc, wtLocOf(repoName));
				if (caughtUp.warning) {
					emitSystem('stderr', `${repoName}: ${caughtUp.warning}`);
				} else if (caughtUp.merged) {
					emitSystem('stdout', `${repoName}: caught up ${branchName} to origin default`);
				}
			}
		}

		if (signal?.aborted) {
			return {
				workingDir: '/workspace',
				designatedRepo: null,
				worktrees: [],
				clones: [],
				branch: branchName,
				executor,
				recoveryFailed,
			};
		}

		const designated = project.designated_repo_id
			? repos.rows.find((r) => r.id === project.designated_repo_id)
			: null;
		const primary = designated ?? repos.rows[0];
		const primaryName = repoNameFromIdentifier(primary.repo_identifier);

		// The run executes with this worktree as its cwd; proceeding without it
		// would only surface later as an opaque container chdir failure.
		const primaryError = worktreeErrors.get(primary.id);
		if (primaryError) {
			throw new Error(`cannot prepare worktree for ${primaryName}: ${primaryError}`);
		}

		const workingDir = `${CONTAINER_WORKTREES_ROOT}/${task.identifier}/${primaryName}`;

		// Capture each prepared worktree's location + pre-run commit so the completion
		// path can detect whether the run produced any code change.
		const worktrees: WorktreeRef[] = [];
		const clones: CloneRef[] = [];
		for (const repo of repos.rows) {
			if (worktreeErrors.has(repo.id)) continue;
			const repoName = repoNameFromIdentifier(repo.repo_identifier);
			const loc = wtLocOf(repoName);
			if (!(await loc.files.exists('.git'))) continue;
			worktrees.push({ loc, headBefore: await getWorktreeHead(executor, loc) });
			clones.push({ ...repoLocOf(repoName), repoId: repo.id });
		}

		// Reclaim the worktrees of finished tasks before the agent starts. Worktrees
		// are deliberately kept after a run (a task gets many runs and reusing its
		// worktree is the common case), so a container that serves twenty tasks
		// accumulates twenty worktrees and their node_modules. On the operator's own
		// daemon that only costs disk; a managed sandbox has a few GB in total, and
		// package caches cannot be moved onto the shared store, so this is the only
		// lever on that budget.
		//
		// Bounded per repo so a long backlog costs a predictable amount per run, and
		// best-effort: reclaimed disk is never worth failing a run over. Only tasks
		// that are terminal or gone are touched, and committed work survives on the
		// `hezo/<identifier>` branch ref regardless.
		try {
			const gc = await collectFinishedWorktrees(
				deps.db,
				executor,
				project.id,
				clones,
				undefined,
				undefined,
				// Never this run's own worktree: a run on a closed task (a comment,
				// a mention, a Coach review) would otherwise have prep delete the
				// directory it just set as the working directory.
				task.identifier,
			);
			if (gc.removed.length > 0) {
				emitSystem(
					'stdout',
					`(reclaimed ${gc.removed.length} finished task worktree(s)${gc.deferred ? ', more remain for the next run' : ''})`,
				);
			}
		} catch (e) {
			log.error(`Run ${heartbeatRunId}: worktree GC failed:`, e);
		}

		// Measure what the container is using *after* the GC above, so the figure
		// the pool recycles on reflects the disk that is actually unavailable
		// rather than what a reclaim was about to free. A container at the ceiling
		// is replaced on the next acquire instead of reused, because one that fills
		// up mid-run fails that run partway through.
		//
		// Null means the measurement could not be taken, which leaves the previous
		// figure alone - reporting an unmeasurable container as empty would defeat
		// the rung entirely.
		try {
			const used = await deps.docker.diskUsedBytes(project.container_id, CONTAINER_WORKSPACE_ROOT);
			if (used !== null) await setPoolMemberDiskUsage(deps.db, project.container_id, used);
		} catch (e) {
			log.error(`Run ${heartbeatRunId}: disk measurement failed:`, e);
		}

		return {
			workingDir,
			designatedRepo: primary ?? null,
			worktrees,
			clones,
			branch: branchName,
			executor,
			recoveryFailed,
		};
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
	db: Db,
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
	/** Absolute signed download URL fetchable from inside the run container. */
	url: string;
}

export async function loadAgentAttachmentsForComments(
	db: Db,
	commentIds: string[],
	masterKeyManager: MasterKeyManager,
	assetOrigin: string,
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
			url: await signAgentAssetUrl(row.id, masterKeyManager, assetOrigin),
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

export interface RenderableComment {
	id: string;
	content_type: string;
	content: Record<string, unknown>;
	author_name: string;
	created_at: string;
	reactions: ReactionGroup[] | undefined;
	attachments: AgentAttachment[];
}

/**
 * Load a task's comments for injection into a run prompt. With `opts.limit` set, returns the
 * newest N comments in chronological (oldest-first) order — used for the "Recent Comments"
 * head-start block in every task run. With no limit, returns the full thread oldest-first —
 * used by the Coach review. Each row is enriched with its reactions and signed attachment
 * download URLs.
 */
export async function loadCommentHistory(
	db: Db,
	taskId: string,
	masterKeyManager: MasterKeyManager,
	assetOrigin: string,
	opts: { limit?: number; categories?: readonly ThreadRowCategory[] } = {},
): Promise<RenderableComment[]> {
	const { limit, categories } = opts;
	const params: unknown[] = [taskId];
	// Without a category filter the newest few rows on a busy task are routinely
	// three run markers, which reads as an empty thread and sends the agent off to
	// walk the whole history looking for the part that was actually said.
	const category = categories ? commentCategoryPredicate('ic', categories, params) : null;
	const limitSql = limit != null ? ` LIMIT $${params.push(limit)}` : '';
	const rows = await db.query<{
		id: string;
		content_type: string;
		content: Record<string, unknown>;
		author_name: string;
		created_at: string;
	}>(
		`SELECT ic.id, ic.content_type, ic.content,
		        COALESCE(ma.title, m.display_name, 'Admin') AS author_name,
		        ic.created_at::text
		 FROM task_comments ic
		 LEFT JOIN members m ON m.id = ic.author_member_id
		 LEFT JOIN member_agents ma ON ma.id = ic.author_member_id
		 WHERE ic.task_id = $1${category ? ` AND ${category}` : ''}
		 ORDER BY ic.created_at ${limit != null ? 'DESC' : 'ASC'}${limitSql}`,
		params,
	);
	// The limited query pulls the newest N (DESC); flip back to chronological for rendering.
	const ordered = limit != null ? [...rows.rows].reverse() : rows.rows;

	const reactionsByComment = await loadReactionsForTask(db, taskId);
	const attachmentsByComment = await loadAgentAttachmentsForComments(
		db,
		ordered.map((c) => c.id),
		masterKeyManager,
		assetOrigin,
	);

	return ordered.map((c) => ({
		...c,
		reactions: reactionsByComment.get(c.id),
		attachments: attachmentsByComment.get(c.id) ?? [],
	}));
}

/** Where an agent's catch-up read should start, and how much is waiting there. */
export interface CatchUpContext {
	/** When this agent's previous run on this task finished. */
	since: string;
	/** Conversation and event rows added since, excluding this run's own writes. */
	newRows: number;
	/** How many of those were something someone wrote. */
	newComments: number;
}

/**
 * What has happened on a task since this agent last finished a run on it.
 *
 * Returns null on an agent's first run on a task, where there is no "since" to
 * name and the whole thread genuinely is the context. Served as one index seek
 * by `idx_runs_member_task_finished`.
 */
export async function loadCatchUpSinceLastRun(
	db: Db,
	memberId: string,
	taskId: string,
	currentRunId: string,
): Promise<CatchUpContext | null> {
	const r = await db.query<{ since: string; new_rows: string; new_comments: string }>(
		`WITH last_run AS (
		   SELECT hr.finished_at FROM heartbeat_runs hr
		   WHERE hr.member_id = $1 AND hr.task_id = $2 AND hr.id <> $3
		     AND hr.finished_at IS NOT NULL
		   ORDER BY hr.finished_at DESC LIMIT 1
		 )
		 SELECT lr.finished_at::text AS since,
		        count(c.id) FILTER (
		          WHERE c.content_type <> 'run'::comment_content_type
		        )::text AS new_rows,
		        count(c.id) FILTER (
		          WHERE c.content_type = 'text'::comment_content_type
		        )::text AS new_comments
		 FROM last_run lr
		 LEFT JOIN task_comments c
		   ON c.task_id = $2 AND c.created_at > lr.finished_at
		  AND (c.created_by_run_id IS DISTINCT FROM $3)
		 GROUP BY lr.finished_at`,
		[memberId, taskId, currentRunId],
	);
	const row = r.rows[0];
	if (!row) return null;
	return {
		since: row.since,
		newRows: Number(row.new_rows),
		newComments: Number(row.new_comments),
	};
}

/**
 * Serialize loaded comments into the `[timestamp] Author (type): text` block shared by the
 * Coach review's full history and the task prompt's Recent Comments. When `wakingCommentId`
 * matches a row, that line is tagged so the agent can see which comment triggered the run.
 */
export function renderCommentHistory(
	comments: RenderableComment[],
	opts: { wakingCommentId?: string } = {},
): string {
	return comments
		.map((c) => {
			const text =
				c.content_type === 'text' ? extractCommentText(c.content) : JSON.stringify(c.content);
			const tag =
				opts.wakingCommentId && c.id === opts.wakingCommentId
					? '  ← the comment that woke you'
					: '';
			const base = `[${c.created_at}] ${c.author_name} (${c.content_type}): ${text}${tag}`;
			const reactionLine = formatReactionLine(c.reactions);
			const attachmentLines = c.attachments.map(
				(a) =>
					`  attachment: ${a.original_filename} (${a.content_type}, ${a.byte_size} bytes) → download: ${a.url}`,
			);
			const extra = [reactionLine, ...attachmentLines].filter((l): l is string => l !== null);
			return extra.length > 0 ? `${base}\n${extra.join('\n')}` : base;
		})
		.join('\n');
}

export interface CommentWakeContext {
	authorName: string;
	excerpt: string;
	commentId: string;
}

/**
 * Load the single comment that woke an assignee-comment run (`WakeupSource.Comment`) so it can
 * be quoted verbatim in the prompt. The mention/reply paths have their own richer handoffs; this
 * covers the plain assignee wake, whose payload carries `comment_id` but which rendered no
 * reference to it before.
 */
export async function loadCommentWakeContext(
	db: Db,
	wakeupPayload: Record<string, unknown>,
): Promise<CommentWakeContext | null> {
	const commentId = typeof wakeupPayload.comment_id === 'string' ? wakeupPayload.comment_id : null;
	if (!commentId) return null;
	const row = await db.query<{ content: Record<string, unknown>; author_name: string | null }>(
		`SELECT ic.content,
		        COALESCE(ma.title, m.display_name, 'Admin') AS author_name
		 FROM task_comments ic
		 LEFT JOIN members m ON m.id = ic.author_member_id
		 LEFT JOIN member_agents ma ON ma.id = ic.author_member_id
		 WHERE ic.id = $1`,
		[commentId],
	);
	if (row.rows.length === 0) return null;
	return {
		authorName: row.rows[0].author_name ?? 'Admin',
		excerpt: extractCommentText(row.rows[0].content).trim(),
		commentId,
	};
}

export interface BuildTaskPromptContext {
	mentionContext?: MentionContext | null;
	replyContext?: ReplyContext | null;
	commentWakeContext?: CommentWakeContext | null;
	spawnedFrom?: SpawnedFromTask | null;
	openSubTasks?: OpenSubTask[];
	recentComments?: RenderableComment[];
	wakingCommentId?: string;
	catchUp?: CatchUpContext | null;
}

/** How many of a task's most recent comments to inline in every run prompt as a head-start. */
export const RECENT_COMMENTS_LIMIT = 3;

/** One due goal handed to the Captain in a progress-update run. */
export interface ProgressUpdateGoal {
	id: string;
	title: string;
	measurement: string;
	actions: string;
	progress_percent: number;
	health: string;
	status_blurb: string;
	check_frequency: string;
	target_date: string | null;
}

export interface ProgressUpdateContext {
	/** Due goals. May be empty — a progress-update run does not require goals. */
	goals: ProgressUpdateGoal[];
	/**
	 * Deterministically-selected tasks that moved since the last look, as raw material for the
	 * summary. Optional so a caller that only wants the goal half (tests, previews) need not
	 * build them.
	 */
	activityCandidates?: ProgressActivityCandidates;
}

/** One candidate group rendered into the prompt, with what its tasks tell the Captain. */
const ACTIVITY_COLUMN_PROMPTS: {
	kind: ProgressActivityKind;
	heading: string;
	answers: string;
}[] = [
	{
		kind: 'actioned',
		heading: 'Recently actioned (being worked now)',
		answers: 'what is being accomplished here, and how far it has got',
	},
	{
		kind: 'created',
		heading: 'Recently created (newly filed)',
		answers: 'what this sets out to accomplish, and why it is outstanding',
	},
	{
		kind: 'closed',
		heading: 'Recently closed (finished)',
		answers: 'what was accomplished - the outcome that matters to the project',
	},
];

/**
 * Render the candidate tasks as compact prompt lines. Tolerates a missing or partial candidates
 * object — this is a pure formatter, and a group with nothing in it should render as "nothing
 * yet" rather than throw.
 */
function renderActivityCandidates(candidates?: Partial<ProgressActivityCandidates>): string[] {
	const parts: string[] = [];
	for (const col of ACTIVITY_COLUMN_PROMPTS) {
		const rows = candidates?.[col.kind] ?? [];
		parts.push(`### ${col.heading}`);
		parts.push(`These tell you: *${col.answers}.*`);
		if (rows.length === 0) {
			parts.push('- (nothing yet)');
		} else {
			for (const r of rows) {
				const meta = [r.status, r.actor].filter(Boolean).join(' · ');
				parts.push(
					`- \`${r.identifier}\` ${r.title}${meta ? ` — ${meta}` : ''}` +
						(r.excerpt ? `\n  > ${r.excerpt.replace(/\s+/g, ' ').trim()}` : ''),
				);
			}
		}
		parts.push('');
	}
	return parts;
}

/**
 * The system prompt plus its separator, or nothing at all when the runtime takes
 * the system prompt through an instructions file instead
 * (RUNTIME_SYSTEM_PROMPT_FILE). Emitting the separator on its own would open the
 * prompt with a stray rule and read as a truncated message.
 */
function systemPromptParts(systemPrompt: string): string[] {
	return systemPrompt ? [systemPrompt, '', '---', ''] : [];
}

/**
 * The user-message body for a Captain progress-update run. No task is attached.
 *
 * The run's primary job is refreshing the project's **progress summary** — the narrative at the
 * top of the project dashboard — which happens on every progress-update run whether or not the
 * project has goals. Goal assessment is the *second* section and is emitted only when goals are
 * actually due, so a project that has never set one still gets a maintained summary.
 */
export function buildProgressUpdatePrompt(
	systemPrompt: string,
	ctx: ProgressUpdateContext,
): string {
	const parts = [...systemPromptParts(systemPrompt), '## Progress Update', ''];
	parts.push(
		"Refresh this project's progress summary. Call `update_project_progress` **once**, with a " +
			'`summary`. It overwrites the whole summary, so include everything that should remain.',
	);
	parts.push('');
	parts.push(
		'The summary is the high-level read: where the project stands, what has taken place, and what ' +
			'is being planned. Lead with the key points in **bold**, then a short narrative. Pitch it at ' +
			'what the work means for the project — what was accomplished, what is being accomplished, ' +
			'what is outstanding. Do **not** name individual tasks — no identifiers at all — because the ' +
			'dashboard lists the specific work beneath your summary. Do not narrate mechanics (branches, ' +
			"CI, who commented when, review round-trips), and do not paste a task's own progress " +
			'summary or description.',
	);
	parts.push('');
	parts.push(
		'The tasks below are what moved since you last looked. Read them as raw material and write ' +
			'from them; they are not a list to reproduce.',
	);
	parts.push('');
	parts.push('## What moved');
	parts.push('');
	parts.push(...renderActivityCandidates(ctx.activityCandidates));

	// Goals are an optional layer on top of progress: this section only exists when some are due.
	if (ctx.goals.length > 0) {
		parts.push('---');
		parts.push('');
		parts.push('## Goals due for a check');
		parts.push('');
		parts.push(
			`${ctx.goals.length} goal${ctx.goals.length === 1 ? ' is' : 's are'} also due for a progress check. ` +
				'For each goal below, assess real progress toward the objective — read the relevant tasks, ' +
				'comments, and repo state; do not just count tasks. Then call `update_goal_progress` once per ' +
				'goal with a fresh `progress_percent` (0-100), a `health` (on_track / at_risk / off_track, ' +
				'weighing progress against any target date), and a one-paragraph `status_blurb` describing where ' +
				"the goal stands and the next step needed. The blurb renders as markdown on the goal's own page — " +
				'reference tasks by their identifier (e.g. `HM-51`, which auto-links) and link PRs or other URLs ' +
				'as markdown links (e.g. `[PR #502](https://github.com/owner/repo/pull/502)`). Do not lower a ' +
				'percentage without explaining why in the blurb. A goal at 100% is not finished for tracking ' +
				'purposes: progress can drop back below 100 if the measurement is no longer met, and some goals ' +
				'are never-ending and measured continuously forever — so re-assess a 100% goal exactly like any ' +
				'other and record your honest current estimate, even if that means lowering it (with the reason ' +
				'in the blurb). When a goal needs a push, you can either comment on an existing in-flight task ' +
				'(`create_comment`) to steer or unblock it, or file new task(s) (with `goal_id` set) when a ' +
				'concrete next step is actually missing — existing backlog or in-flight work often already ' +
				'covers the goal. Never re-open a closed task (done/cancelled are terminal and the system will ' +
				'refuse it); if work must be redone, file a new task that references the old one by identifier.',
		);
		parts.push('');
		for (const g of ctx.goals) {
			parts.push(`### ${g.title}  \`${g.id}\``);
			parts.push(
				`- Current: ${g.progress_percent}% · health ${g.health} · checked ${g.check_frequency}` +
					(g.target_date ? ` · deadline ${g.target_date}` : ''),
			);
			if (g.status_blurb) parts.push(`- Last status: ${g.status_blurb}`);
			parts.push(`- Achieved when: ${g.measurement || 'Not specified.'}`);
			if (g.actions) parts.push(`- Suggested actions: ${g.actions}`);
			parts.push('');
		}
	}
	return parts.join('\n');
}

export function buildTaskPrompt(
	systemPrompt: string,
	task: TaskInfo,
	wakeupPayload?: Record<string, unknown>,
	ctx: BuildTaskPromptContext = {},
): string {
	const { mentionContext, replyContext, commentWakeContext, spawnedFrom, recentComments } = ctx;
	const openSubTasks = ctx.openSubTasks ?? [];
	const parts = systemPromptParts(systemPrompt);

	if (replyContext && wakeupPayload?.source === WakeupSource.Reply) {
		parts.push(...renderReplyHandoff(task, replyContext));
	} else if (mentionContext && wakeupPayload?.source === WakeupSource.Mention) {
		parts.push(...renderMentionHandoff(task, mentionContext));
	} else if (commentWakeContext && wakeupPayload?.source === WakeupSource.Comment) {
		parts.push(...renderCommentWakeHandoff(task, commentWakeContext));
	}

	parts.push(`## Current Task: ${task.identifier} — ${task.title}`);
	parts.push(`**Priority:** ${task.priority}`);
	parts.push(`**Status:** ${task.status}`);
	if (spawnedFrom?.parentLine) parts.push(spawnedFrom.parentLine);
	if (spawnedFrom?.spawnLine) parts.push(spawnedFrom.spawnLine);
	if (openSubTasks.length > 0) {
		parts.push(
			'**Open sub-tasks** (already delegated — route new instructions to these tasks, do not do their work yourself):',
		);
		for (const sub of openSubTasks) {
			parts.push(
				`- ${sub.identifier} — ${sub.title} (${sub.status}, assigned to ${sub.assignee_name ?? 'unassigned'})`,
			);
		}
	}
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

	if (recentComments && recentComments.length > 0) {
		parts.push('');
		parts.push(`### Recent Comments (latest ${RECENT_COMMENTS_LIMIT})`);
		parts.push(renderCommentHistory(recentComments, { wakingCommentId: ctx.wakingCommentId }));
		parts.push('');
		parts.push(
			ctx.catchUp
				? `These are only the most recent comments, and they are shown here in full. Before you start, catch up on the rest with \`list_comments(task_id: "${task.identifier}", since: "${ctx.catchUp.since}")\` — see "Since your last run" below. Note \`list_comments\` excerpts long comments: a row with \`text_truncated: true\` is showing only the first \`excerpt_chars\` of its body in \`content.text\`, so read that comment with \`get_comment\` before acting on it rather than assuming the excerpt is the whole thing.`
				: 'These are only the most recent comments, and they are shown here in full. Before you start, call `list_comments` to read the thread — earlier comments may carry instructions that change this task. Note `list_comments` excerpts long comments: a row with `text_truncated: true` is showing only the first `excerpt_chars` of its body in `content.text`, so read that comment with `get_comment` before acting on it rather than assuming the excerpt is the whole thing.',
		);
	}

	if (ctx.catchUp) {
		parts.push('');
		parts.push('### Since your last run');
		parts.push(
			`Your previous run on this task finished at ${ctx.catchUp.since}. Since then this task has ${ctx.catchUp.newRows} new thread ${ctx.catchUp.newRows === 1 ? 'row' : 'rows'}, ${ctx.catchUp.newComments} of them written by someone.`,
		);
		parts.push(
			`Read them with \`list_comments(task_id: "${task.identifier}", since: "${ctx.catchUp.since}")\` and page that to the end. That is your catch-up: you have already seen everything before it, so re-reading the whole thread costs a great deal and tells you nothing new. Read further back only when you need older context for a specific question.`,
		);
	}

	if (wakeupPayload?.previous_failure) {
		const pf = wakeupPayload.previous_failure as Record<string, unknown>;
		parts.push('');
		parts.push(`## Retry Attempt ${wakeupPayload.retry_count}/${wakeupPayload.max_retries}`);
		parts.push('The previous attempt FAILED. Analyze the error and try a different approach.');
		if (pf.exit_code !== undefined && pf.exit_code !== null) {
			// A bare number gives the retrying agent nothing to analyse; naming the
			// signal tells it the previous attempt was destroyed rather than that it
			// returned an error, which is a different thing to try differently.
			const signal = typeof pf.exit_code === 'number' ? signalFromExitCode(pf.exit_code) : null;
			parts.push(`**Exit code:** ${pf.exit_code}${signal ? ` (killed by ${signal.name})` : ''}`);
		}
		if (pf.stderr_tail) parts.push(`**Error output:**\n\`\`\`\n${pf.stderr_tail}\n\`\`\``);
		if (pf.stdout_tail) parts.push(`**Last output:**\n\`\`\`\n${pf.stdout_tail}\n\`\`\``);
	}

	parts.push('');
	parts.push('Work on this task. Post comments via the Agent API to report progress.');

	return parts.join('\n');
}

function renderCommentWakeHandoff(task: TaskInfo, ctx: CommentWakeContext): string[] {
	const excerptBlock = ctx.excerpt
		? ctx.excerpt
				.split('\n')
				.map((line) => `> ${line}`)
				.join('\n')
		: '> (empty)';
	return [
		'## New Comment on Your Task',
		`${ctx.authorName} commented on ${task.identifier}, which woke this run — their full comment:`,
		'',
		excerptBlock,
		'',
		'Read it carefully: it may add or change the instructions for this task. Then review the rest of the thread (see Recent Comments below, and `list_comments` for the full history) before you act.',
		'',
		'---',
		'',
	];
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
		'### Your open tasks',
		ticketList,
		'',
		'### How to handle this mention',
		`Follow the **Handling an @-mention** rules in the @-Mentions, Linking & Handoffs section of your system prompt. The triggering task referenced in those rules is ${task.identifier}; when creating a sub-task, use \`parent_task_id = ${task.id}\`.`,
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
	db: Db,
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
		'### Tasks referenced by the reply',
		referenced,
		'',
		'### How to handle this reply',
		'1. Read the reply and any referenced tasks.',
		`2. If more responses to the same original comment are still expected (you mentioned multiple agents), you may choose to wait — another reply wakeup will arrive and you'll see the latest state then.`,
		`3. If your original comment (quoted above) announced what you would do once this reply arrived — a delegation fan-out, a set of updates, steps contingent on the answer — that announced plan is now due: carry it out this run, or post a comment explicitly revising or retracting it with the reason (e.g. the answer collapsed the scope). Do not merely acknowledge the answer, and do not do a smaller piece than announced and close as if the plan completed.`,
		`4. Otherwise, update your own plan or post a follow-up comment on ${task.identifier} as appropriate. Do not re-mention the responder unless you need another round-trip.`,
		'5. End the turn.',
		'',
		'---',
		'',
	];
}

export interface SpawnedFromTask {
	parentLine: string | null;
	spawnLine: string | null;
}

export async function loadSpawnedFromTask(db: Db, task: TaskInfo): Promise<SpawnedFromTask | null> {
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
			parentLine: `**Parent task:** ${parent.identifier} — ${parent.title}`,
			spawnLine: null,
		};
	}
	return {
		parentLine: parent ? `**Parent task:** ${parent.identifier} — ${parent.title}` : null,
		spawnLine: spawningTask
			? `**Spawned from:** ${spawningTask.identifier} — ${spawningTask.title} (provenance only; this task is your own work)`
			: null,
	};
}

/** A non-terminal sub-task of the ticket a run is on — work already delegated out. */
export interface OpenSubTask {
	identifier: string;
	title: string;
	status: string;
	assignee_name: string | null;
}

/** Cap on the sub-tasks listed in the prompt; a fan-out wider than this is already unusual. */
const OPEN_SUB_TASKS_LIMIT = 20;

/**
 * The current ticket's still-open sub-tasks, so the run prompt can say what this
 * agent has already delegated. `loadSpawnedFromTask` renders the ticket's lineage
 * *upward* (parent / spawned-from); this is the downward half, and it is what makes
 * the "route new instructions to the delegate, don't absorb their work" rule in
 * SHARED_INSTRUCTIONS checkable from the prompt rather than from memory. One extra
 * query per run start (not per request), bounded by OPEN_SUB_TASKS_LIMIT.
 */
export async function loadOpenSubTasks(db: Db, task: TaskInfo): Promise<OpenSubTask[]> {
	const terminal = terminalStatusParams(2, true);
	const r = await db.query<OpenSubTask>(
		`SELECT i.identifier, i.title, i.status::text AS status, m.display_name AS assignee_name
		 FROM tasks i
		 LEFT JOIN members m ON m.id = i.assignee_id
		 WHERE i.parent_task_id = $1
		   AND i.status NOT IN (${terminal.placeholders})
		 ORDER BY i.created_at ASC
		 LIMIT ${OPEN_SUB_TASKS_LIMIT}`,
		[task.id, ...terminal.values],
	);
	return r.rows;
}

/**
 * Render a compact, chronological summary of the task's agent runs (container
 * executions) for the Coach review prompt — metadata only, never the log text
 * (which can be huge). The Coach pulls a specific run's log on demand with the
 * `get_run_log` MCP tool. Returns '' when the task has no runs.
 */
async function loadRunSummaries(db: Db, taskId: string, teamId: string): Promise<string> {
	const r = await db.query<{
		id: string;
		status: string;
		exit_code: number | null;
		started_at: string | null;
		log_length: number;
		agent_title: string | null;
		agent_slug: string | null;
	}>(
		`SELECT hr.id, hr.status, hr.exit_code, hr.started_at,
		        ${runLogLengthSql('hr.id')} AS log_length,
		        ma.title AS agent_title, ma.slug AS agent_slug
		 FROM heartbeat_runs hr
		 LEFT JOIN member_agents ma ON ma.id = hr.member_id
		 WHERE hr.task_id = $1 AND hr.team_id = $2
		 ORDER BY hr.started_at ASC`,
		[taskId, teamId],
	);
	return r.rows
		.map((run) => {
			const agent = run.agent_title ? `${run.agent_title} (${run.agent_slug})` : 'unknown agent';
			const exit = run.exit_code === null ? '—' : String(run.exit_code);
			const started = run.started_at ?? '—';
			return `- ${agent} — status ${run.status}, exit ${exit}, started ${started}, log ${run.log_length} chars (run ${run.id})`;
		})
		.join('\n');
}

export async function buildCoachReviewPrompt(
	db: Db,
	systemPrompt: string,
	task: TaskInfo,
	teamId: string,
	masterKeyManager: MasterKeyManager,
	assetOrigin: string,
): Promise<string> {
	// The whole thread goes into this prompt server-side, so it never meets the
	// tool-result cap. Run markers are dropped because `loadRunSummaries` below
	// reports the same executions with their outcome attached.
	const comments = await loadCommentHistory(db, task.id, masterKeyManager, assetOrigin, {
		categories: DEFAULT_THREAD_ROW_CATEGORIES,
	});
	const runLog = await loadRunSummaries(db, task.id, teamId);

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

	const commentLog = renderCommentHistory(comments);

	const agentList = involvedAgents.rows
		.map((a) => `- ${a.title} (slug: ${a.slug}, id: ${a.id})`)
		.join('\n');

	const parts = [
		...systemPromptParts(systemPrompt),
		`## Review Completed Task: ${task.identifier} — ${task.title}`,
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
		...(runLog ? ['### Agent Runs', runLog, ''] : []),
		'### Your Task',
		'Review this completed task. Analyze the comment history for patterns where agents struggled,',
		'received feedback, had work rejected, or needed multiple attempts. When the comments do not fully',
		'explain what happened — a silent plan-vs-outcome gap, an unclear failure, an approach abandoned',
		'without explanation — call `get_run_log(run_id)` on a run listed under Agent Runs to inspect what',
		'the agent actually did in its container, not just what it reported. For each improvement opportunity,',
		"use `get_agent_system_prompt` with `placeholders: false` to read the affected agent's raw prompt",
		'(you need the `{{…}}` placeholders intact for a safe round-trip), then use `update_agent_system_prompt`',
		'to add a specific rule to their `## Learned Rules` section. When a lesson applies to EVERY agent on the',
		'team (a shared convention, standard, or fact), put it in the project Custom Prompt with',
		'`update_project_custom_prompt` instead of editing each prompt one by one. Updates apply immediately and a',
		'revision snapshot is recorded so the admin can roll back if needed.',
		'',
		'If the task completed smoothly without significant rework or feedback, no changes are needed.',
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
	/** Null for progress-update runs, which are not tied to a task. */
	taskId: string | null;
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
		// Carry the project so the client invalidates the run's *own* project, not
		// whichever project the team_id fallback happens to resolve to. Without it a
		// run in any project on the team invalidates every team project's task list.
		project_id: ctx.projectId,
		member_id: ctx.memberId,
		status,
	});
}

export interface TriggeredBy {
	member_id: string | null;
	name: string;
}

/**
 * The run this one replaces, and whether it inherits that run's retry budget.
 *
 * Only the lost-run chain spends the budget. A container coming back, a server
 * restart and a human pressing Retry are one-shot recoveries already bounded by
 * their own guards - none can feed itself, so none may be throttled by a ceiling
 * the lost-run chain filled.
 */
export interface ReplacedRun {
	runId: string;
	inheritsLossBudget: boolean;
}

export async function createHeartbeatRun(
	db: Db,
	agent: AgentInfo,
	runTeamId: string,
	task: TaskInfo | null,
	broadcast: HeartbeatRunBroadcast,
	wakeupId: string,
	triggeredBy: TriggeredBy | null = null,
	kind: HeartbeatRunKind = HeartbeatRunKind.Task,
	replaces: ReplacedRun | null = null,
): Promise<string> {
	const { runId, statusFlippedToInProgress } = await withTransaction(db, async () => {
		// The retry budget is read from the replaced **row**, not from the wakeup
		// payload that named it. Both columns existed and neither was ever written:
		// `retry_of_run_id` had no writer at all, and a retried run took the schema
		// default of 0 for `process_loss_retry_count` - so `priorRetries` was always
		// 0, `0 + 1 < MAX_RETRIES` was always true, and the escalation branch in
		// `retryOrEscalateLostRun` could not be reached. The chain had no end.
		//
		// Reading the row rather than the payload is what makes the ceiling
		// unforgeable: a coalesced or hand-edited `retry_count` cannot reset it, and
		// the worst a wrong `run_id` can do is name a real run and inherit its count.
		const runResult = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, wakeup_id, status, kind,
			                             retry_of_run_id, process_loss_retry_count)
			 VALUES ($1, $2, $3, $4, $5::heartbeat_run_status, $6::heartbeat_run_kind, $7,
			         CASE WHEN $8::boolean
			              THEN COALESCE((SELECT prior.process_loss_retry_count
			                               FROM heartbeat_runs prior WHERE prior.id = $7), 0)
			              ELSE 0 END)
			 RETURNING id`,
			[
				agent.id,
				runTeamId,
				task?.id ?? null,
				wakeupId,
				HeartbeatRunStatus.Queued,
				kind,
				replaces?.runId ?? null,
				replaces?.inheritsLossBudget ?? false,
			],
		);
		const runId = runResult.rows[0].id;

		// Progress-update runs have no task — no Run comment to anchor and no status to flip.
		if (!task) return { runId, statusFlippedToInProgress: false };

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
	if (broadcast.wsManager && task) {
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
				project_id: broadcast.projectId,
				status: TaskStatus.InProgress,
			});
		}
	}
	if (statusFlippedToInProgress && task) {
		await recordStatusChange(
			db,
			broadcast.teamId,
			task.id,
			TaskStatus.Backlog,
			TaskStatus.InProgress,
			agent.id,
			null,
			broadcast.wsManager,
		);
	}
	return runId;
}

async function markHeartbeatRunRunning(
	db: Db,
	runId: string,
	broadcast: HeartbeatRunBroadcast,
	adapter: { aiProviderConfigId: string | null; provider: AiProvider | null },
	containerId: string | null,
): Promise<boolean> {
	// Stamp the resolved AI adapter config on the run so recordRunCostAndEnforce
	// can attribute the run's cost to it without re-resolving, and the container
	// so a container's death can fail only the runs it was actually carrying.
	//
	// `queued_reason` is cleared on the way past: it describes what the run was
	// waiting for, so carrying it onto a started row - and from there onto the
	// terminal one - states a wait that ended as though it were the outcome.
	const result = await db.query<{ id: string }>(
		`UPDATE heartbeat_runs
		    SET status = $1::heartbeat_run_status, started_at = now(),
		        ai_provider_config_id = $4, provider = $5::ai_provider,
		        container_id = $6, queued_reason = NULL
		  WHERE id = $2 AND status = $3::heartbeat_run_status
		  RETURNING id`,
		[
			HeartbeatRunStatus.Running,
			runId,
			HeartbeatRunStatus.Queued,
			adapter.aiProviderConfigId,
			adapter.provider,
			containerId,
		],
	);
	// Guarded on the row still being `queued`, so whoever declared an outcome
	// first owns it. Reporting whether it applied is what lets the caller stop:
	// a run reaped or cancelled while it waited would otherwise sail past this
	// no-op and execute in full against a terminal row.
	if (result.rows.length === 0) return false;
	broadcastHeartbeatRunChange(broadcast, runId, HeartbeatRunStatus.Running, 'UPDATE');
	return true;
}

async function updateHeartbeatRun(
	db: Db,
	runId: string,
	update: {
		status: string;
		exitCode: number;
		durationMs: number;
		error?: string;
		usage?: AgentRunUsage | null;
		/**
		 * Whether the persisted usage is a mid-run snapshot. `false` on a clean
		 * completion (terminal event seen → authoritative); omit to leave the flag
		 * as the last periodic flush set it (true once any usage landed).
		 */
		usagePartial?: boolean | null;
	},
	broadcast: HeartbeatRunBroadcast,
): Promise<void> {
	// Guarded on a non-terminal status, so whoever declared the outcome first owns
	// it. Several writers can reach one run - the runner's own catches, the
	// container-death sweep, an operator terminate, the orphan pass - and the first
	// to land is the one that actually observed the run; a later write would
	// replace a specific cause with a vaguer one, and under MVCC an unconditional
	// re-stamp also leaves a dead tuple behind. Same shape as
	// `markHeartbeatRunRunning` and `failProjectRuns`.
	const applied = await db.query<{ id: string }>(
		`UPDATE heartbeat_runs
		 SET status = $1::heartbeat_run_status,
		     started_at = COALESCE(started_at, now()),
		     finished_at = now(),
		     exit_code = $2,
		     error = COALESCE($3, error),
		     input_tokens = COALESCE($4, input_tokens),
		     output_tokens = COALESCE($5, output_tokens),
		     cost_cents = COALESCE($6, cost_cents),
		     usage_partial = COALESCE($7, usage_partial)
		     -- cancel_reason is deliberately absent from this SET list. A cancel
		     -- attribution says WHO stopped the run, and this finalizer is never that
		     -- party: terminateHeartbeatRun backfills operator_terminated while the
		     -- abort is still cascading, and the orphan sweeper records its own
		     -- through recordHandbackOutcome. Leaving the column out entirely is what
		     -- makes their writes survive, rather than a COALESCE direction a later
		     -- simplification could quietly reverse.
		 WHERE id = $8
		   AND status IN ($9::heartbeat_run_status, $10::heartbeat_run_status)
		 RETURNING id`,
		[
			update.status,
			update.exitCode,
			update.error ?? null,
			update.usage?.inputTokens ?? null,
			update.usage?.outputTokens ?? null,
			update.usage?.costCents ?? null,
			update.usagePartial ?? null,
			runId,
			HeartbeatRunStatus.Queued,
			HeartbeatRunStatus.Running,
		],
	);
	if (applied.rows.length > 0) {
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
	} else {
		// Logged only when the two verdicts disagree, so the ordinary idempotent
		// case - the same path finalizing twice - stays quiet.
		const current = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		const settled = current.rows[0]?.status;
		if (settled && settled !== update.status) {
			log.warn(
				`Run ${runId}: kept terminal status '${settled}'; dropped a later '${update.status}'`,
			);
		}
	}

	// Outside the guard: tokens burned are burned whoever declared the outcome.
	// Run completion is the canonical cost event: record the run's total spend as a
	// single cost_entries row (guarded on positive usage so failure/abort paths and
	// retries — which carry no usage — never double-insert), then reactively pause
	// the agent if this pushed it (or its project) over any budget window.
	await recordRunCostAndEnforce(db, runId, update.usage ?? null, broadcast);
}

/**
 * Insert the run's cost into `cost_entries` and pause the agent if now over
 * budget. Best-effort: a failure here logs and continues — it must not turn a
 * completed run into a failed one. Exported so startup reconciliation can charge
 * the surviving cost of a run the server killed mid-flight (see
 * `JobManager.reconcileOnStartup`).
 */
export async function recordRunCostAndEnforce(
	db: Db,
	runId: string,
	usage: AgentRunUsage | null,
	broadcast: HeartbeatRunBroadcast,
): Promise<void> {
	if (!usage || usage.costCents <= 0) return;
	try {
		// The resolved AI adapter config was stamped on the run at start
		// (markHeartbeatRunRunning); read it back to attribute this cost to it.
		const runRow = await db.query<{
			ai_provider_config_id: string | null;
			provider: AiProvider | null;
		}>(`SELECT ai_provider_config_id, provider FROM heartbeat_runs WHERE id = $1`, [runId]);
		const adapter = runRow.rows[0] ?? { ai_provider_config_id: null, provider: null };

		const entry = await recordRunCost(db, {
			memberId: broadcast.memberId,
			taskId: broadcast.taskId ?? null,
			projectId: broadcast.projectId ?? null,
			amountCents: usage.costCents,
			description: `Agent run ${runId}`,
			aiProviderConfigId: adapter.ai_provider_config_id,
			provider: adapter.provider,
		});
		if (entry && broadcast.wsManager) {
			broadcastRowChange(
				broadcast.wsManager,
				wsRoom.team(broadcast.teamId),
				'cost_entries',
				'INSERT',
				entry,
			);
		}

		const block = await checkOverBudget(db, broadcast.memberId, broadcast.projectId ?? null);
		if (block) {
			await pauseAgentForBudget(
				db,
				broadcast.memberId,
				broadcast.teamId,
				block,
				broadcast.wsManager,
			);
		}
	} catch (e) {
		log.error({ err: e, runId }, 'failed to record run cost / enforce budget');
	}
}

/**
 * Emit `agent_run.started` once the run row exists. Looks up the wakeup's source
 * and a light triggered-by hint for the audit trail.
 */
async function emitRunStarted(
	deps: RunnerDeps,
	runId: string,
	agent: AgentInfo,
	task: TaskInfo | null,
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
		taskId: task?.id ?? null,
		agentMemberId: agent.id,
		triggerSource,
		triggeredBy,
	});
}
