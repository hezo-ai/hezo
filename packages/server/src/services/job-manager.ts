import {
	AgentAdminStatus,
	type AgentRuntime,
	AgentRuntimeStatus,
	type AiProvider,
	BUDGET_PAUSE_STATUSES,
	CAPTAIN_AGENT_SLUG,
	CONTAINER_IDLE_TIMEOUT_MIN,
	CommentContentType,
	ContainerStatus,
	DEFAULT_TEAM_ID,
	HeartbeatRunKind,
	HeartbeatRunStatus,
	INSTANCE_AGENT_SLUGS,
	RepoSetupStatus,
	TaskPriority,
	TERMINAL_TASK_STATUSES,
	UpdateState,
	WakeupSkipReason,
	WakeupSource,
	WakeupStatus,
	wsRoom,
} from '@hezo/shared';
import { Cron } from 'cron-async';
import { runtimeConfig } from '../config/runtime';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import type { DomainEventBus } from '../events/bus';
import { trackBackground } from '../lib/background';
import { broadcastRowChange } from '../lib/broadcast';
import type { StorageBackend } from '../lib/db-info';
import { shouldDeferWakeupForBlockers } from '../lib/dependencies';
import { ref } from '../lib/log-ref';
import { getDefaultRamCapPerContainerGb } from '../lib/system-meta';
import { logger } from '../logger';
import { getLatestInfo } from '../routes/updates';
import { exitToApplyUpdate } from '../runtime-control';
import {
	type ProgressUpdateContext,
	type RunnerDeps,
	type RunResult,
	recordRunCostAndEnforce,
	runAgent,
} from './agent-runner';
import {
	pauseAgentForBudget,
	reconcileBudgetPause,
	setAgentIdleIfNoActiveRuns,
} from './agent-runtime-status';
import { checkOverBudget } from './budget';
import type { ContainerLogStreamer } from './container-logs';
import {
	type ContainerDeps,
	type ContainerExitReason,
	type ContainerTransition,
	destroyContainer,
	ensureProjectContainerRunning,
	executeRetirementPlan,
	failProjectRuns,
	findIdleContainerCandidates,
	findStaleIdleMembers,
	findStaleIdleMembersInProject,
	isProjectIdleForContainerStop,
	provisionContainer,
	reconcilePoolMembers,
	type StaleIdleMember,
	stopContainerGracefully,
	syncAllContainerStatuses,
	teardownContainer,
	verifyContainerWorkspace,
	wakeAgentsWithPendingWork,
	withContainerLifecycleLock,
} from './containers';
import type { ContainerEngine, ContainerProcessInfo } from './docker';
import type { EgressProxy } from './egress';
import { getDueGoals } from './goals';
import { heartbeatIntervalFloorMin } from './heartbeat-schedule';
import type { LogStreamBroker } from './log-stream-broker';
import { refreshModelPins } from './model-pins';
import { noWorkCooldownActive, parkedOnAdminAsk } from './no-work-backoff';
import { detectOrphans, healStaleRunState, STALE_STATE_GRACE_SECONDS } from './orphan-detector';
import type { PricingService } from './pricing';
import { collectCandidateRunIds, decideSweepKills } from './process-sweeper';
import { buildProgressActivityCandidates } from './project-activity';
import { ensureRepoSetupAction } from './repo-setup';
import {
	getActiveContainers,
	isTaskBusyInDb,
	projectContainerMemoryGb,
	reclaimableForOthers,
	sumProjectContainerMemoryGb,
} from './run-concurrency';
import { recordHandbackOutcome } from './run-handback';
import { reclaimBusyPoolMembers } from './sandbox/pool-db';
import type { SshAgentServer } from './ssh-agent';
import { reportTelemetry } from './telemetry';
import { ensureUpdateStaged, isSupervisedWorker, readUpdateState } from './updater';
import {
	absorbQueuedTaskWakeups,
	assignmentWakeupAlreadyServed,
	createProgressUpdateWakeup,
	createWakeup,
	type SettlementIntent,
	settleWakeupForRun,
} from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('job-manager');

const MAX_CONSECUTIVE_FAILURE_PINGS = 3;
// A run cut off by its wall-clock time limit auto-queues a same-task continuation. This caps
// how many consecutive timeouts we re-queue through before parking the task, so a task that
// never fits its run window can't loop forever; a non-timeout run in between resets the streak.
const MAX_CONSECUTIVE_TIMEOUT_CONTINUATIONS = 5;
// How stale the progress summary may get before the Captain rebuilds it, independently of goals.
// Matches the default daily goal cadence, and is deliberately conservative: paired with the
// "has anything changed since?" guard in `isProgressSnapshotDue`, it means an active project
// gets at most one progress run a day from this path and a dormant one gets none.
const PROGRESS_REFRESH_INTERVAL_HOURS = 24;
const FAILURE_PING_ERROR_MAX_LEN = 500;
/**
 * The outcomes that must never post a failure notice: a cancel is the user's own
 * doing, and a success has nothing to report.
 */
const NON_PINGING_STATUSES: HeartbeatRunStatus[] = [
	HeartbeatRunStatus.Succeeded,
	HeartbeatRunStatus.Cancelled,
];

const FAILURE_TERMINAL_STATUSES: HeartbeatRunStatus[] = [
	HeartbeatRunStatus.Failed,
	HeartbeatRunStatus.TimedOut,
];

const cronLog = {
	trace: (msg: unknown) => log.debug(msg),
	debug: (msg: unknown) => log.debug(msg),
	error: (msg: unknown) => log.error(msg),
};

/** Identifies the agent-run dispatch a launchTask entry belongs to, so the
 * stale-state sweep can correlate the in-memory entry with its run rows and
 * release the dispatch guards if the completion path never lands. */
interface RunDispatchContext {
	memberId: string;
	taskId: string;
	projectId: string;
	/** This dispatch will lazy-start the project's container — it holds a
	 * pending-container-start slot until the run settles. */
	pendingContainerStart?: boolean;
}

/**
 * What the capacity gate decided, and the fact the dispatch after it needs.
 *
 * `hasSpareContainer` is "this project has a member a run may take", which is
 * also exactly "this dispatch will not create a container". Carrying it out of
 * the gate keeps that judgement in one place; the alternative - re-deriving it
 * from `projects.container_status` at the dispatch - is a different question
 * wearing the same clothes, and answered wrong under a pool.
 */
interface CapacityVerdict {
	blocked: boolean;
	hasSpareContainer: boolean;
}

interface RunningTask {
	key: string;
	abortController: AbortController;
	promise: Promise<unknown>;
	startedAt: number;
	timeoutId: ReturnType<typeof setTimeout>;
	runContext?: RunDispatchContext;
	/** Set when the stale-state sweep already released this entry's dispatch
	 * guards, so the task's own settle handler doesn't double-release. */
	reaped: boolean;
}

export interface LiveRun {
	runId: string;
	memberId: string;
	/** Null for progress-update runs, which are not tied to a task. */
	taskId: string | null;
	projectId: string;
	teamId: string;
	taskKey: string;
	/**
	 * The container this run is executing in, filled in once the pool hands one
	 * over. Null until then: a run is registered when its row is created, which
	 * is before it has claimed anything - so this is genuinely unknown for a
	 * moment rather than merely unset.
	 */
	containerId: string | null;
}

export type DispatchNowResult =
	| { dispatched: true }
	| {
			dispatched: false;
			reason:
				| 'task_busy'
				| 'instance_at_capacity'
				| 'agent_busy'
				| 'blocked'
				| 'not_queued'
				| 'not_found';
	  };

/** Why a progress-update ("Run now") dispatch did or didn't start. `no_captain`/`captain_disabled`/
 * `no_project` only arise on the manual `dispatchProgressUpdateNow` path; `not_due` only on the
 * scheduled path, which is the only one that runs the due-check. */
export type ProgressUpdateDispatchReason =
	| 'no_project'
	| 'no_captain'
	| 'captain_disabled'
	| 'not_due'
	| 'agent_busy'
	| 'instance_at_capacity'
	| 'over_budget'
	| 'launch_conflict';

/** Outcome of a single dispatch attempt (`tryDispatchProgressUpdate`). Never queues. */
export type TryProgressUpdateResult =
	| { dispatched: true }
	| { dispatched: false; reason: ProgressUpdateDispatchReason };

/** What the manual `dispatchProgressUpdateNow` path returns to the route: a single
 * attempt outcome, or — for a transient conflict — a queued wakeup that runs when
 * the Captain frees up. */
export type ProgressUpdateDispatchResult =
	| TryProgressUpdateResult
	| { queued: true; wakeupId: string };

/**
 * The one thing the idle pass needs from the assistant: park a session whose
 * container is about to go down, while that container is still up.
 *
 * Without it the container is suspended first and the session finds out by its
 * tunnel dying - the *failure* path. That reported "closed unexpectedly", tore
 * the session down as `crashed` instead of parking it as `suspended` (losing the
 * resume-in-place path entirely), and left the provider's PTY session undeleted
 * because the DELETE raced the sandbox already stopping.
 */
export interface ChatSessionPark {
	/** No-op unless a live session is pinned to exactly this container. */
	parkForContainerSuspend(containerId: string): Promise<void>;
}

export interface JobManagerDeps {
	db: Db;
	docker: ContainerEngine;
	masterKeyManager: MasterKeyManager;
	serverPort: number;
	dataDir: string;
	wsManager: WebSocketManager;
	events?: DomainEventBus;
	logs: LogStreamBroker;
	containerLogStreamer: ContainerLogStreamer;
	sshAgentServer?: SshAgentServer;
	egressProxy?: EgressProxy | null;
	egressCAPath?: string;
	pricing?: PricingService;
	/**
	 * Storage backend, so the log-compaction drain knows whether it may VACUUM
	 * FULL to reclaim disk (embedded only). Defaults to 'embedded' when omitted.
	 */
	storageBackend?: StorageBackend;
	/** Anonymous daily usage telemetry. Omitted/disabled → the cron is not registered. */
	telemetry?: { enabled: boolean; endpoint: string };
	/**
	 * Park a live assistant session before its container is taken down.
	 *
	 * A narrow port rather than the `ChatSessionManager` itself: the idle pass
	 * needs one verb from it, and the manager is constructed after this one, so
	 * it is attached with {@link JobManager.setChatSessions} once both exist.
	 */
	chatSessions?: ChatSessionPark;
	/**
	 * Install staged updates automatically (`--auto-install-updates` /
	 * `HEZO_AUTO_INSTALL_UPDATES`): restart onto a staged newer binary without
	 * waiting for an operator's "Install & restart". Omitted/false → the
	 * auto-install cron is not registered.
	 */
	autoInstallUpdates?: boolean;
	/**
	 * Test seams for the auto-install path — both defaults are process-global
	 * (the supervised-worker gate reads env/execPath; the restart trigger shuts
	 * the runtime down and exits the process).
	 */
	isSupervisedWorker?: () => boolean;
	requestUpdateRestart?: () => Promise<void>;
}

/**
 * Deferrals released per wakeups tick by {@link JobManager.releaseSatisfiedDeferrals}.
 *
 * Bounded because the scan is unindexed on the payload reason and this runs
 * every five seconds; a backlog drains over a few ticks rather than in one long
 * statement. Comfortably above what a single repo setup can strand.
 */
const DEFERRAL_RELEASE_LIMIT = 20;
// Daily model-pricing refresh from the pricepertoken.com catalog. Failures
// log and leave the existing rows — the boot-time refresh / next tick retries.
// Daily re-read of each configured provider's model catalog, moving the pinned
// default a NEW credential starts on. Existing configs are never touched. An
// hour after the pricing refresh so a newly pinned model already has a rate row.
// Daily check for a newer release; when auto-update is enabled and one is found,
// download+verify+stage it so an operator "Update & restart" is instant.
// Frequent because it is cheap (reads the local state file; no network) — it exists so a
// deferred install (agent runs in flight at staging time) retries minutes later, not next day.
// Anonymous daily usage telemetry report — runs at 5am UTC, after the update
// check, when telemetry is enabled (opt-out, default on).
// How often to re-evaluate budget-paused agents. Spend is summed over rolling
// UTC windows, so a daily/weekly/monthly window rolling over silently frees an
// agent's budget with no event — this sweep notices and lifts the reactive
// pause so the heartbeat scheduler (which skips paused agents) resumes it.
// Re-refresh OAuth tokens on the clock, not only when an agent run happens to
// make a proxied call. `refreshExpiringTokens` is otherwise reached ONLY from the
// egress substitution path, so on an idle instance nothing renews a token and
// nothing notices when a grant dies - the operator's first signal was a run log
// mentioning a "known gap". Five minutes rather than seconds: the watched state
// (a token nearing expiry, a grant the provider killed) changes on the scale of
// an hour, each candidate costs a provider round-trip, and the resolver's own
// failure backoff already tops out at 15 minutes, so it - not this cadence - is
// what bounds retries against a permanently dead connection.
/** Connections re-checked per tick — a bound, not a target; ordered soonest-to-
 *  expire, so the next tick continues where this one stopped. */
const CONNECTOR_HEALTH_BATCH_LIMIT = 25;
/** Simultaneous provider round-trips per tick. */
const CONNECTOR_HEALTH_CONCURRENCY = 5;
/** Must exceed the tick, or a token expiring between ticks lapses before renewal. */
const CONNECTOR_HEALTH_HORIZON_MS = 10 * 60_000;
/** Uncredentialed hosted connectors re-proved per tick. Smaller than the token
 *  batch: each is a full MCP handshake against a third party, and the ordering
 *  is oldest-evidence-first, so the next tick continues where this one stopped. */
const CONNECTOR_PROBE_BATCH_LIMIT = 10;
/** Simultaneous MCP handshakes per tick. */
const CONNECTOR_PROBE_CONCURRENCY = 3;
/** How stale probe evidence may get before it is re-gathered. Hours rather than
 *  minutes: what it watches is a provider deciding its public server now wants
 *  auth, which is a deployment, and each check costs that provider a handshake. */
const CONNECTOR_PROBE_INTERVAL_MS = 6 * 60 * 60_000;
// Container status reconciliation and orphaned-run detection. These run on a
// fixed wall-clock tick rather than reacting to an event, so they keep firing
// even while nothing is happening. The defaults (1s / 30s) keep the dashboard
// snappy in production, but on a CPU-starved CI runner three 1Hz crons
// (wakeups, heartbeats, container-sync) compound into sustained load that
// slows page loads enough to time out browser/component specs. Both are env-
// configurable so the E2E server can dial them down — see playwright.config.ts.

/**
 * Idle-container reaper cadence: once a minute (offset to :15 to avoid the
 * top-of-minute pile-up with other jobs). The state it watches — "did the idle
 * window elapse" — changes on minute granularity, so a faster tick would only
 * burn queries. Env-overridable so E2E can dial it down.
 */

/** Containers stopped per idle-stop tick — a bound, not a target; the next
 * tick continues where this one stopped. */
const IDLE_STOP_BATCH_LIMIT = 10;

/** Archived projects retired per boot. A backlog only shrinks, so a later boot
 * finishes what this one did not; the bound is there so a teardown that keeps
 * failing cannot turn every startup into a full engine sweep. */
const ARCHIVED_RETIREMENT_SCAN_LIMIT = 25;

/**
 * Orphaned-container sweep cadence: every 10 minutes. What it watches - a
 * container this instance created that no project points at any more - only
 * appears after a crash or a lost provider response, so a fast tick would burn
 * provider API calls for nothing. It exists because on a managed backend an
 * orphan bills until somebody notices, which fails as a cost rather than as an
 * error and so needs a sweep rather than an alert.
 */
// The reactive budget pauses, which the heartbeat scheduler must not wake (the
// budget-resume sweep lifts them back to `idle` once the window rolls over).
// Disabled agents are filtered separately via `admin_status`. Postgres array
// literal for the `<> ALL(...)` / `= ANY(...)` enum-array params.
const BUDGET_PAUSE_STATUSES_PG = `{${BUDGET_PAUSE_STATUSES.join(',')}}`;
// Drain tick for agent run-log compaction. Cheap when idle (a single
// `system_meta` read); only does work while a compaction pass is active, which
// the operator starts from the DB panel. Frequent so a started pass makes
// visible progress and resumes promptly after a restart.

// Database housekeeping: refresh planner statistics on the embedded backend and
// sweep terminal scheduler bookkeeping. Nightly, off-peak - neither is urgent,
// and both are cheap enough that the point is only to stop them never running.
// Statistics drift on the scale of days, not seconds.

/** Rate limit on the "job is overrunning its interval" warning. */
const SKIP_WARN_INTERVAL_MS = 60_000;
// Lower bound on how often a heartbeat can fire (`heartbeatIntervalFloorMin`,
// from ./heartbeat-schedule) is shared with the agents API's computed
// `next_heartbeat_at` so the UI countdown matches the cadence enforced here.
// Quiet window after a run completes before that agent is eligible for another
// heartbeat. Prevents back-to-back runs when the configured interval is shorter
// than the run itself.

export class JobManager {
	private cron: Cron;
	private runningTasks = new Map<string, RunningTask>();
	private liveRuns = new Map<string, LiveRun>();
	/** Set by {@link stopAcceptingWork}; makes `launchTask` refuse new work. */
	private draining = false;
	private guards = new Map<string, boolean>();
	/**
	 * Containers the last orphan sweep found unreferenced. One sighting is not
	 * enough to destroy on (see `reapOrphanedContainers`), so the set carries
	 * across ticks. Bounded by the number of containers this instance owns, and
	 * replaced wholesale each pass rather than accumulated.
	 */
	private suspectedOrphanContainers: ReadonlySet<string> = new Set();
	/** Ticks dropped since the last warning, per job — see guarded(). */
	private skippedTicks = new Map<string, number>();
	private skipWarnedAt = new Map<string, number>();
	// Tasks currently held by a dispatched run. Populated synchronously in activateAgent
	// before launchTask, cleared in the launchTask finally. Closes the race window between
	// dispatch and createHeartbeatRun where the DB-backed check is not yet authoritative.
	private activeTaskRuns = new Set<string>();
	// Refcount of dispatched runs per project, scoped at the project level so the
	// number of concurrent runs entering a project's shared container never
	// exceeds its configured ceiling. Incremented synchronously in activateAgent
	// before launchTask and decremented in the launchTask finally — this closes
	// the race window where the DB-backed count is not yet authoritative. A Set
	// would be wrong here: with several runs in flight, the first to finish would
	// free the guard for the rest.
	private activeProjectRuns = new Map<string, number>();
	/** Projects whose container is being lazy-started by an in-flight dispatch —
	 * counted against the active-container cap before the DB row reads Running. */
	private pendingContainerStarts = new Map<string, number>();
	private deps: JobManagerDeps;
	private started = false;

	constructor(deps: JobManagerDeps) {
		this.deps = deps;
		this.cron = new Cron();
	}

	registerLiveRun(run: LiveRun): void {
		this.liveRuns.set(run.runId, run);
	}

	unregisterLiveRun(runId: string): void {
		this.liveRuns.delete(runId);
	}

	/**
	 * Record which container a registered run ended up in.
	 *
	 * Separate from registration because the order is fixed the other way: a run
	 * exists as a row, and is cancellable, before the pool has decided what it
	 * will execute in.
	 */
	attachLiveRunContainer(runId: string, containerId: string): void {
		const run = this.liveRuns.get(runId);
		if (run) run.containerId = containerId;
	}

	getLiveRunIds(): Set<string> {
		return new Set(this.liveRuns.keys());
	}

	getLiveRunsForProject(projectId: string): LiveRun[] {
		return Array.from(this.liveRuns.values()).filter((r) => r.projectId === projectId);
	}

	cancelLiveRun(runId: string, reason?: ContainerExitReason): boolean {
		const run = this.liveRuns.get(runId);
		if (!run) return false;
		this.cancelTask(run.taskKey, reason);
		this.liveRuns.delete(runId);
		return true;
	}

	/**
	 * Abort the in-process runs one dead container was carrying - and only those.
	 *
	 * The in-memory half of {@link failProjectRuns}. A live run whose container is
	 * still null has not claimed one: it is parked on the credential lock or on
	 * capacity, holding nothing, and its row is still `queued`. It cannot be on
	 * the container that died, so it is left to finish its wait; the surplus-idle
	 * pass retiring the project's spare container underneath such a waiter is the
	 * intended memory behaviour, not a reason to end the run. The DB half only
	 * touches `running` rows, which always carry their container by then, so the
	 * two halves still describe the same set.
	 */
	cancelLiveRunsForContainer(
		projectId: string,
		containerId: string,
		reason: ContainerExitReason,
	): number {
		const runs = this.getLiveRunsForProject(projectId).filter((r) => r.containerId === containerId);
		for (const run of runs) {
			this.cancelTask(run.taskKey, reason);
			this.liveRuns.delete(run.runId);
		}
		return runs.length;
	}

	/**
	 * Dispatch a single queued wakeup immediately, bypassing the cron's
	 * coalescing window. Applies the exact per-wakeup gating `processWakeups`
	 * does — task busy, project at capacity, and source-gated dependency blockers
	 * — so the run rules and the scheduler's blocker policy stay respected. The
	 * in-memory `activeTaskRuns`/`activeProjectRuns` guards (checked inside
	 * `isTaskBusy`/`isProjectAtCapacity` and set synchronously by `activateAgent`)
	 * make back-to-back calls race-safe. Returns a discriminated result the
	 * route maps to 200 / 409 / 404.
	 */
	async dispatchWakeupNow(wakeupId: string): Promise<DispatchNowResult> {
		const { db } = this.deps;
		const lookup = await db.query<{
			id: string;
			member_id: string;
			team_id: string;
			source: string;
			payload: Record<string, unknown>;
			status: string;
		}>(
			`SELECT id, member_id, team_id, source, payload, status
			 FROM agent_wakeup_requests WHERE id = $1`,
			[wakeupId],
		);
		const wakeup = lookup.rows[0];
		if (!wakeup) return { dispatched: false, reason: 'not_found' };
		if (wakeup.status !== WakeupStatus.Queued) return { dispatched: false, reason: 'not_queued' };

		const wakeupTaskId =
			typeof wakeup.payload?.task_id === 'string' ? wakeup.payload.task_id : null;

		if (wakeupTaskId) {
			if (await this.isTaskBusy(wakeup.payload)) {
				await this.markWakeupSkipped(
					wakeup.id,
					WakeupSkipReason.TaskBusy,
					wakeupTaskId,
					wakeup.team_id,
					wakeupTaskId,
				);
				return { dispatched: false, reason: 'task_busy' };
			}
			const project = await this.resolveProjectForTask(wakeupTaskId);
			if ((await this.isContainerCapacityBlocked(project?.id ?? null)).blocked) {
				await this.markWakeupSkipped(
					wakeup.id,
					WakeupSkipReason.InstanceAtCapacity,
					wakeupTaskId,
					wakeup.team_id,
					null,
				);
				return { dispatched: false, reason: 'instance_at_capacity' };
			}
			if (project && (await this.isAgentBusyInProject(wakeup.member_id, project.id))) {
				await this.markWakeupSkipped(
					wakeup.id,
					WakeupSkipReason.AgentRunning,
					wakeupTaskId,
					wakeup.team_id,
					null,
				);
				return { dispatched: false, reason: 'agent_busy' };
			}
			if (await shouldDeferWakeupForBlockers(db, wakeup.source, wakeupTaskId)) {
				await db.query(
					`UPDATE agent_wakeup_requests
					 SET status = $1::wakeup_status, payload = payload || $2::jsonb
					 WHERE id = $3`,
					[WakeupStatus.Deferred, JSON.stringify({ reason: 'blocked' }), wakeup.id],
				);
				return { dispatched: false, reason: 'blocked' };
			}
		}

		// Race-safe claim — the 5s dispatcher may have flipped queued->claimed
		// between the lookup and here. The conditional WHERE guards against it.
		const claimed = await db.query<{ id: string }>(
			`UPDATE agent_wakeup_requests
			 SET status = $1::wakeup_status,
			     claimed_at = now(),
			     last_skipped_at = NULL,
			     last_skipped_reason = NULL,
			     last_skipped_blocker_task_id = NULL
			 WHERE id = $2 AND status = $3::wakeup_status
			 RETURNING id`,
			[WakeupStatus.Claimed, wakeup.id, WakeupStatus.Queued],
		);
		if (claimed.rows.length === 0) return { dispatched: false, reason: 'not_queued' };

		if (wakeupTaskId) {
			const refreshed = await db.query<Record<string, unknown>>(
				'SELECT * FROM tasks WHERE id = $1',
				[wakeupTaskId],
			);
			if (refreshed.rows[0]) {
				broadcastRowChange(
					this.deps.wsManager,
					wsRoom.team(wakeup.team_id),
					'tasks',
					'UPDATE',
					refreshed.rows[0],
				);
			}
		}

		try {
			await this.activateAgent(
				wakeup.member_id,
				wakeup.team_id,
				wakeup.id,
				wakeup.payload,
				wakeup.source,
			);
		} catch (error) {
			log.error(`activateAgent threw for run-now wakeup ${wakeup.id}:`, error);
			await db
				.query('UPDATE agent_wakeup_requests SET status = $1::wakeup_status WHERE id = $2', [
					WakeupStatus.Failed,
					wakeup.id,
				])
				.catch(() => {});
			throw error;
		}

		return { dispatched: true };
	}

	/**
	 * Attach the assistant park hook after construction.
	 *
	 * The chat manager is built after this one (it takes no job manager, this
	 * takes one verb from it), so the edge is closed here rather than by
	 * reordering two constructors around a dependency neither really has.
	 */
	setChatSessions(chatSessions: ChatSessionPark): void {
		this.deps.chatSessions = chatSessions;
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

	start(): void {
		if (this.started) return;
		this.started = true;
		// Read once here, not at module scope: this file is imported before
		// `index.ts` publishes the resolved config, so a module-level read would
		// capture the defaults and silently ignore the operator's file.
		const { jobs } = runtimeConfig();
		this.cron.createJob('wakeups', {
			cron: jobs.wakeupCron,
			log: cronLog,
			onTick: () => this.guarded('wakeups', () => this.processWakeups()),
		});
		this.cron.createJob('heartbeats', {
			cron: jobs.heartbeatCron,
			log: cronLog,
			onTick: () => this.guarded('heartbeats', () => this.processScheduledHeartbeats()),
		});
		this.cron.createJob('orphan-detection', {
			cron: jobs.orphanDetectionCron,
			log: cronLog,
			onTick: () => this.guarded('orphan-detection', () => this.detectOrphanedRuns()),
		});
		this.cron.createJob('container-sync', {
			cron: jobs.containerSyncCron,
			log: cronLog,
			onTick: () => this.guarded('container-sync', () => this.syncContainerStatuses()),
		});
		this.cron.createJob('container-idle-stop', {
			cron: jobs.containerIdleStopCron,
			log: cronLog,
			onTick: () => this.guarded('container-idle-stop', () => this.stopIdleContainers()),
		});
		this.cron.createJob('orphan-container-sweep', {
			cron: jobs.orphanContainerSweepCron,
			log: cronLog,
			onTick: () => this.guarded('orphan-container-sweep', () => this.reapOrphanedContainers()),
		});
		this.cron.createJob('inbox-archive', {
			cron: jobs.inboxArchiveCron,
			log: cronLog,
			onTick: () => this.guarded('inbox-archive', () => this.archiveInboxItems()),
		});
		this.cron.createJob('log-compaction', {
			cron: runtimeConfig().logCompaction.cron,
			log: cronLog,
			onTick: () => this.guarded('log-compaction', () => this.compactRunLogs()),
		});
		this.cron.createJob('budget-resume', {
			cron: jobs.budgetResumeCron,
			log: cronLog,
			onTick: () => this.guarded('budget-resume', () => this.processBudgetResumes()),
		});
		this.cron.createJob('connector-health', {
			cron: jobs.connectorHealthCron,
			log: cronLog,
			onTick: () => this.guarded('connector-health', () => this.sweepConnectorHealth()),
		});
		this.cron.createJob('db-maintenance', {
			cron: jobs.dbMaintenanceCron,
			log: cronLog,
			onTick: () => this.guarded('db-maintenance', () => this.runDbMaintenance()),
		});
		this.cron.createJob('update-check', {
			cron: jobs.updateCheckCron,
			log: cronLog,
			onTick: () => this.guarded('update-check', () => this.checkForUpdate()),
		});
		if (this.deps.autoInstallUpdates && (this.deps.isSupervisedWorker ?? isSupervisedWorker)()) {
			this.cron.createJob('auto-install-update', {
				cron: jobs.autoInstallCron,
				log: cronLog,
				onTick: () => this.guarded('auto-install-update', () => this.autoInstallStagedUpdate()),
			});
		}
		if (this.deps.pricing) {
			this.cron.createJob('pricing-refresh', {
				cron: jobs.pricingRefreshCron,
				log: cronLog,
				onTick: () => this.guarded('pricing-refresh', () => this.refreshPricing()),
			});
		}
		this.cron.createJob('model-pin-refresh', {
			cron: jobs.modelPinRefreshCron,
			log: cronLog,
			onTick: () => this.guarded('model-pin-refresh', () => this.refreshModelPins()),
		});
		if (this.deps.telemetry?.enabled) {
			this.cron.createJob('telemetry', {
				cron: jobs.telemetryCron,
				log: cronLog,
				onTick: () => this.guarded('telemetry', () => this.runTelemetry()),
			});
		}
		log.info('Job manager started.');
	}

	launchTask(
		key: string,
		fn: (signal: AbortSignal) => Promise<unknown>,
		timeoutMs: number,
		runContext?: RunDispatchContext,
	): boolean {
		// A shutdown in progress must not take new work: the wakeup cron fires every
		// five seconds, so without this a drain would keep being handed fresh runs
		// by the very scheduler it is waiting out.
		if (this.draining) return false;
		if (this.runningTasks.has(key)) return false;
		const ac = new AbortController();

		const timeoutId = setTimeout(() => {
			log.warn(`Task ${key} timed out after ${timeoutMs}ms`);
			// Tagged reason so runAgent finalizes the run as `timed_out` (not `cancelled`) and
			// onAgentComplete queues a same-task continuation. `cancelTask`/shutdown/the reaper
			// abort without a reason → `cancelled`; container death aborts `container_*` → `failed`.
			ac.abort('run_timeout');
		}, timeoutMs);

		const entry: RunningTask = {
			key,
			abortController: ac,
			promise: Promise.resolve(),
			startedAt: Date.now(),
			timeoutId,
			runContext,
			reaped: false,
		};
		entry.promise = trackBackground(
			fn(ac.signal).finally(() => {
				clearTimeout(timeoutId);
				// The sweep may have reaped this entry and a fresh launch may
				// occupy the key, so only release what still belongs to us.
				if (this.runningTasks.get(key) === entry) this.runningTasks.delete(key);
				if (runContext && !entry.reaped) this.releaseRunDispatch(runContext);
			}),
		);

		this.runningTasks.set(key, entry);
		return true;
	}

	private releaseRunDispatch(ctx: RunDispatchContext): void {
		this.activeTaskRuns.delete(ctx.taskId);
		this.releaseProjectRun(ctx.projectId);
		if (ctx.pendingContainerStart) this.releasePendingContainerStart(ctx.projectId);
	}

	cancelTask(key: string, reason?: unknown): boolean {
		const task = this.runningTasks.get(key);
		if (!task) return false;
		clearTimeout(task.timeoutId);
		task.abortController.abort(reason);
		return true;
	}

	isTaskRunning(key: string): boolean {
		return this.runningTasks.has(key);
	}

	/**
	 * True when this agent already holds a dispatched run for any project. Used
	 * by the heartbeat scheduler to skip redundant idle pings while a task-driven
	 * run is in flight (heartbeats don't carry a project so we can't fall back to
	 * the per-project guard).
	 */
	isMemberRunning(memberId: string): boolean {
		const prefix = `${memberId}:`;
		for (const key of this.runningTasks.keys()) {
			if (key.startsWith(prefix)) return true;
		}
		return false;
	}

	getRunningTasks(): Map<string, RunningTask> {
		return new Map(this.runningTasks);
	}

	/**
	 * Stop scheduling and refuse new dispatches.
	 *
	 * Separate from {@link shutdown} so a drain can sit between them. Aborting and
	 * clearing the registries in one step, as `shutdown` does, leaves the abort
	 * nowhere to land: the DB closes while the runs it just cancelled are still
	 * writing their terminal rows.
	 */
	/**
	 * How many agent runs are in flight right now.
	 *
	 * The same figure `autoInstallStagedUpdate` gates on, exposed so the update
	 * banner shows one definition of busy rather than inventing a second.
	 */
	inFlightRunCount(): number {
		return this.runningTasks.size;
	}

	stopAcceptingWork(): void {
		this.draining = true;
		this.cron.shutdown();
	}

	/**
	 * Abort every in-flight run and wait, bounded, for its completion path to
	 * write a terminal row. Returns what was still in flight at the deadline, so
	 * the caller can name it rather than exiting silently on unfinished work.
	 *
	 * Ordering is the caller's and it matters: `killLiveRunProcesses()` goes
	 * first, so the in-container tree is already dead and the abort lands in
	 * milliseconds rather than waiting on an exec that will never end.
	 */
	async drainRunningRuns(deadlineMs: number): Promise<LiveRun[]> {
		const entries = [...this.runningTasks.values()];
		if (entries.length === 0) return [];
		log.info(`Shutdown: draining ${entries.length} in-flight run(s), up to ${deadlineMs}ms`);
		for (const task of entries) {
			clearTimeout(task.timeoutId);
			task.abortController.abort('server_shutdown');
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			Promise.allSettled(entries.map((e) => e.promise)),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, deadlineMs);
			}),
		]);
		if (timer) clearTimeout(timer);
		const stillRunning = new Set(
			entries.filter((e) => this.runningTasks.get(e.key) === e).map((e) => e.key),
		);
		return [...this.liveRuns.values()].filter((r) => stillRunning.has(r.taskKey));
	}

	shutdown(): void {
		for (const task of this.runningTasks.values()) {
			clearTimeout(task.timeoutId);
			task.abortController.abort();
		}
		this.runningTasks.clear();
		this.liveRuns.clear();
		this.cron.shutdown();
		log.info('Job manager stopped.');
	}

	/**
	 * Reap every live run's in-container process tree by its run-id marker.
	 * Called from `shutdownRuntime` BEFORE `shutdown()` aborts the runs: the
	 * abort path's own kill (agent-runner) races `process.exit`, so a clean
	 * SIGTERM (an update restart) would otherwise strand the agent CLIs in the
	 * warm containers. Bounded — each marker kill is individually timed out and
	 * the whole pass races an 8s timer — so shutdown can never wedge on a dead
	 * Docker socket. Best-effort; the startup sweep is the crash-path backstop.
	 */
	async killLiveRunProcesses(): Promise<void> {
		const runs = [...this.liveRuns.values()];
		if (runs.length === 0) return;
		const projectIds = [...new Set(runs.map((r) => r.projectId))];
		const containers = await this.deps.db.query<{ id: string; container_id: string }>(
			`SELECT id, container_id FROM projects WHERE id = ANY($1::uuid[]) AND container_id IS NOT NULL`,
			[projectIds],
		);
		const containerByProject = new Map(containers.rows.map((r) => [r.id, r.container_id]));
		const kills = runs.flatMap((run) => {
			const containerId = containerByProject.get(run.projectId);
			if (!containerId) return [];
			return [
				this.deps.docker
					.killRunProcesses(containerId, run.runId)
					.catch((e) => log.warn(`Shutdown kill failed for run ${run.runId}:`, e)),
			];
		});
		if (kills.length === 0) return;
		await Promise.race([
			Promise.allSettled(kills),
			new Promise((resolve) => setTimeout(resolve, 8_000)),
		]);
		log.info(`Shutdown: reaped in-container processes for ${kills.length} live run(s)`);
	}

	/**
	 * Both halves of startup reconciliation, in order. The shape existing callers
	 * and tests already use.
	 */
	async reconcileOnStartup(): Promise<void> {
		await this.reconcileDatabaseOnStartup();
		await this.reconcileContainersOnStartup();
	}

	/**
	 * Reconcile DB state with the (now-empty) in-process run registry. Runs in
	 * `running` or `queued` state from the previous process were necessarily lost
	 * with that process — fail them, reset their agents to idle, release locks,
	 * broadcast, and enqueue recovery wakeups so work resumes.
	 *
	 * **Deliberately callable before the vault is unlocked.** It is raw SQL and
	 * broadcasts; nothing here decrypts anything or touches the container backend.
	 * Coming up locked after a restart is the intended behaviour, not a gap - but
	 * while this was behind the unlock hook, an instance that came up locked
	 * served stranded `running` rows and stuck-busy agents until a human arrived,
	 * with the orphan cron not started either.
	 *
	 * Idempotent by construction: every UPDATE is guarded by a status predicate,
	 * so a second call finds no rows and queues no wakeups.
	 */
	async reconcileDatabaseOnStartup(): Promise<void> {
		const { db, wsManager } = this.deps;

		const stranded = await db.query<{
			id: string;
			member_id: string;
			team_id: string;
			task_id: string | null;
			project_id: string | null;
			cost_cents: number;
			input_tokens: number;
			output_tokens: number;
		}>(
			`UPDATE heartbeat_runs hr
			 SET status = $1::heartbeat_run_status,
			     finished_at = COALESCE(finished_at, now()),
			     error = COALESCE(error, $2),
			     exit_code = COALESCE(exit_code, -1)
			 WHERE status IN ($3::heartbeat_run_status, $4::heartbeat_run_status)
			 RETURNING id, member_id, team_id, task_id, cost_cents, input_tokens, output_tokens,
			           (SELECT t.project_id FROM tasks t WHERE t.id = hr.task_id) AS project_id`,
			[
				HeartbeatRunStatus.Failed,
				'Server restarted while run in flight',
				HeartbeatRunStatus.Running,
				HeartbeatRunStatus.Queued,
			],
		);

		const resetAgents = await db.query<{ id: string; team_id: string }>(
			`UPDATE member_agents ma
			 SET runtime_status = $1::agent_runtime_status
			 FROM members m
			 WHERE ma.id = m.id
			   AND ma.runtime_status = $2::agent_runtime_status
			 RETURNING ma.id, m.team_id`,
			[AgentRuntimeStatus.Idle, AgentRuntimeStatus.Active],
		);

		await db.query('UPDATE execution_locks SET released_at = now() WHERE released_at IS NULL');

		// Same reasoning as the execution locks above, for the pool's own claims:
		// every in-flight run was just failed, so a member still marked busy is
		// holding a claim for a run that no longer exists. Nothing else reclaims one
		// - the ladder skips it, the idle pass ignores it, and its memory counts
		// against the budget - so a crash would otherwise cost a container for good.
		const reclaimed = await reclaimBusyPoolMembers(db);
		if (reclaimed.length > 0) {
			log.info(`Returned ${reclaimed.length} claimed container(s) to the pool after restart`);
		}

		for (const run of stranded.rows) {
			broadcastRowChange(wsManager, wsRoom.team(run.team_id), 'heartbeat_runs', 'UPDATE', {
				id: run.id,
				member_id: run.member_id,
				task_id: run.task_id,
				project_id: run.project_id,
				status: HeartbeatRunStatus.Failed,
				error: 'Server restarted while run in flight',
			});
		}

		for (const agent of resetAgents.rows) {
			broadcastRowChange(wsManager, wsRoom.team(agent.team_id), 'member_agents', 'UPDATE', {
				id: agent.id,
				runtime_status: AgentRuntimeStatus.Idle,
			});
		}

		for (const run of stranded.rows) {
			if (!run.task_id) continue;
			await createWakeup(db, run.member_id, run.team_id, WakeupSource.Timer, {
				reason: 'startup_recovery',
				task_id: run.task_id,
				previous_run_id: run.id,
			}).catch((e) => log.error('Failed to enqueue startup recovery wakeup:', e));
		}

		// A run the server killed mid-flight still burned tokens; its surviving
		// usage snapshot (flushed during the run, preserved by the UPDATE above) is
		// real spend that never reached cost_entries. Charge it to the provider
		// budget now so an interrupted run isn't free. recordRunCostAndEnforce is
		// guarded on cost_cents > 0 and these runs never completed, so it can't
		// double-insert. task_id-less runs (rare, non-task coordination) are skipped
		// since cost attribution is task/project-scoped.
		for (const run of stranded.rows) {
			if (!run.task_id || run.cost_cents <= 0) continue;
			const projectRow = await db.query<{ project_id: string | null }>(
				`SELECT project_id FROM tasks WHERE id = $1`,
				[run.task_id],
			);
			const projectId = projectRow.rows[0]?.project_id ?? undefined;
			await recordRunCostAndEnforce(
				db,
				run.id,
				{
					inputTokens: run.input_tokens,
					outputTokens: run.output_tokens,
					costCents: run.cost_cents,
				},
				{
					wsManager,
					teamId: run.team_id,
					projectId,
					taskId: run.task_id,
					memberId: run.member_id,
				},
			);
		}

		// Repo rows whose background setup (clone + designation) was in flight when
		// the previous process died. Their setup can't resume — the work was lost
		// with the process — so park them `failed`; POSTing the same repo again
		// reclaims a failed row and re-runs setup.
		const strandedRepos = await db.query<Record<string, unknown> & { team_id: string }>(
			`UPDATE repos r
			 SET setup_status = $1::repo_setup_status,
			     setup_error = 'Server restarted while repository setup was in flight'
			 FROM projects p
			 WHERE p.id = r.project_id AND r.setup_status = $2::repo_setup_status
			 RETURNING r.id, r.project_id, r.repo_identifier, r.host_type, r.oauth_connection_id,
			           r.created_at, r.setup_status, r.setup_error, p.team_id,
			           (p.designated_repo_id = r.id) AS is_designated`,
			[RepoSetupStatus.Failed, RepoSetupStatus.Pending],
		);
		for (const { team_id, ...repo } of strandedRepos.rows) {
			broadcastRowChange(wsManager, wsRoom.team(team_id), 'repos', 'UPDATE', repo);
		}

		if (stranded.rows.length > 0 || resetAgents.rows.length > 0 || strandedRepos.rows.length > 0) {
			log.info(
				`Startup reconciliation: failed ${stranded.rows.length} stranded run(s), reset ${resetAgents.rows.length} agent(s) to idle, failed ${strandedRepos.rows.length} interrupted repo setup(s)`,
			);
		}
	}

	/**
	 * The container-backend half of startup reconciliation.
	 *
	 * Split from the DB half because this one genuinely needs a connected engine,
	 * so it stays behind the unlock hook while the repair above runs at boot.
	 *
	 * Also self-heals projects stuck in `error` state whose underlying container
	 * is actually alive (e.g. from a prior false-positive transport-error trip).
	 */
	async reconcileContainersOnStartup(): Promise<void> {
		const { docker } = this.deps;
		// Ahead of every other container pass: the ones below adopt, restart and
		// re-provision from the same rows, so a retired project must be emptied
		// before they look at it.
		await this.retireArchivedProjectContainers(docker);
		await this.selfHealErroredContainers(docker);
		await this.restartStoppedRunningContainers(docker);
		await this.repairStaleContainerMounts(docker);
		await this.sweepDanglingContainerProcesses(docker);
		await this.sweepStaleTunnelClients(docker);
		await this.reapOrphanedContainersAtStartup();
	}

	/**
	 * Kill the tunnel clients a previous life of this process left listening.
	 *
	 * Safe here and nowhere else: at reconcile this process holds **no** tunnel,
	 * so every client alive in one of its containers is by definition stale. A
	 * container legitimately carries several at once during normal operation (a
	 * run, a chat turn, a provisioning git op) and they are indistinguishable from
	 * inside, which is why this is a startup pass rather than a cron.
	 *
	 * The orphan is Daytona-shaped but the sweep is not: closing a PTY there does
	 * not kill what runs on it, so a server stopped before its close path ran
	 * (every `ctrl-c` on a dev loop) abandons a client that goes on holding that
	 * sandbox's three loopback ports. The next tunnel into the container then dies
	 * on `EADDRINUSE` and the run loses MCP, egress and ssh entirely - reported
	 * only as a 30s bind timeout. It became reachable when containers started
	 * outliving the process (`reapOrphanedContainersAtStartup`): before that a
	 * restart abandoned the container too, so the orphan went with it.
	 *
	 * Enumerated by label rather than from `projects.container_id`, so pool members
	 * no project currently points at are swept too - they are the ones a later run
	 * is most likely to be handed.
	 */
	private async sweepStaleTunnelClients(docker: ContainerEngine): Promise<void> {
		if (!(await docker.ping())) {
			log.warn('Container backend not reachable at startup; skipping stale-tunnel sweep');
			return;
		}
		let containers: Array<{ Id: string }>;
		try {
			const { INSTANCE_LABEL } = await import('./sandbox/labels');
			const { getOrCreateInstanceId } = await import('./telemetry');
			const instanceId = await getOrCreateInstanceId(this.deps.db, this.deps.dataDir);
			containers = await docker.listContainersByLabel(`${INSTANCE_LABEL}=${instanceId}`);
		} catch (err) {
			log.warn('Stale-tunnel sweep could not list this instance’s containers:', err);
			return;
		}
		for (const c of containers) {
			await docker
				.killTunnelClients(c.Id)
				.catch((err) => log.warn(`Stale-tunnel sweep failed for container ${c.Id}:`, err));
		}
	}

	/**
	 * Reclaim the containers a previous life of this instance left behind, before
	 * the first run needs one.
	 *
	 * Every other startup pass above is DB-driven: it starts from a project row
	 * and looks outward, so a container the database has forgotten is invisible to
	 * all of them. That is exactly what a `--reset` leaves - and on a managed
	 * backend those sandboxes hold their disk against the account quota until
	 * something reclaims them, which is how a handful of dev restarts can fill it
	 * and make the *next* provision fail. (The instance id now outlives the
	 * database, so they still carry this instance's label and are ours to reap;
	 * see `getOrCreateInstanceId`.)
	 *
	 * **Destroys on the first sighting, unlike the cron.** The second-sighting rule
	 * guards one window - a container created but not yet recorded - and that
	 * window cannot be open here: reconciliation has just failed every stranded run
	 * and no run has started. The wait is not merely unnecessary, it defeats the
	 * sweep entirely for the case this exists to fix, because the suspicion set is
	 * in memory and a dev loop restarting every few minutes never reaches a second
	 * pass.
	 *
	 * Gated on this process owning the data dir's lock, which is what makes "no
	 * concurrent provisioning" true. The lock is embedded-only by design, so an
	 * external-database deployment - where two servers can share one instance id -
	 * gets no startup pass and keeps the conservative cron behaviour.
	 */
	private async reapOrphanedContainersAtStartup(): Promise<void> {
		const { readLiveInstanceLock } = await import('../db/instance-lock');
		if (readLiveInstanceLock(this.deps.dataDir)?.pid !== process.pid) {
			log.debug('Not the sole owner of this data dir; leaving orphans to the periodic sweep');
			return;
		}
		await this.reapOrphanedContainers({ atStartup: true }).catch((e) =>
			log.error('Startup orphan sweep failed:', e),
		);
	}

	/**
	 * Bring the HQ container up as early as possible after boot. The startup
	 * restart pass deliberately leaves `stopped` projects alone, but HQ — home of
	 * the always-on CEO and Coach — should be running whenever the instance is.
	 * `ensureProjectContainerRunning` no-ops when Docker confirms it is already
	 * running, starts a stopped container in place, and provisions a missing one,
	 * so this is safe to call unconditionally. Provisioning needs the master key
	 * (secrets/egress), so the caller runs this only after unlock; it is kicked
	 * fire-and-forget there so a slow image pull never delays the rest of startup.
	 */
	async ensureHqContainerRunning(): Promise<void> {
		const reachable = await this.deps.docker.ping();
		if (!reachable) {
			log.warn('Docker not reachable at startup; skipping HQ container warm-up');
			return;
		}
		// First-boot only: warm HQ when it has never been provisioned, so the first
		// CEO chat / onboarding message isn't stuck behind a minutes-long image
		// pull. Once a container exists (running or idle-stopped), lazy start covers
		// every later use in under a second — eagerly starting it here would just
		// wake a container the idle-stop cron reclaims minutes later.
		const hq = await this.deps.db.query<{ id: string }>(
			`SELECT id FROM projects
			 WHERE team_id = $1 AND is_internal = true AND container_id IS NULL`,
			[DEFAULT_TEAM_ID],
		);
		const hqProjectId = hq.rows[0]?.id;
		if (!hqProjectId) return;
		await ensureProjectContainerRunning(this.buildContainerDeps(), hqProjectId);
	}

	/**
	 * Tear down containers still held by an already-archived project.
	 *
	 * Archiving used to stop the project's newest container and leave it as a
	 * `suspended` pool member, so instances upgrading to the teardown behaviour
	 * carry containers no code path will ever reach again: the orphan sweep counts
	 * a suspended member as referenced, and the idle-stop cron deliberately keeps
	 * one warm member per project. They sit on the Containers page reading
	 * "Stopped" and, on a managed backend, are billed for.
	 *
	 * A startup pass rather than a cron: the set is finite and only shrinks, so
	 * there is nothing to watch for once it has run. Bounded anyway - a broken
	 * teardown must not turn every boot into an unbounded engine sweep.
	 */
	private async retireArchivedProjectContainers(docker: ContainerEngine): Promise<void> {
		const { db } = this.deps;

		const reachable = await docker.ping();
		if (!reachable) {
			log.warn('Docker not reachable at startup; skipping archived-project container retirement');
			return;
		}

		const stale = await db.query<{ id: string; slug: string; team_id: string }>(
			`SELECT p.id, p.slug, p.team_id
			 FROM projects p
			 WHERE p.archived_at IS NOT NULL
			   AND (p.container_id IS NOT NULL
			        OR EXISTS (SELECT 1 FROM container_pool_members m WHERE m.project_id = p.id))
			 LIMIT $1`,
			[ARCHIVED_RETIREMENT_SCAN_LIMIT],
		);

		for (const project of stale.rows) {
			try {
				// The workspace stays, exactly as it does on the archive route: these
				// projects are still restorable, and their unpushed commits live there.
				await teardownContainer(
					this.buildContainerDeps(),
					project.id,
					project.slug,
					project.team_id,
					{
						removeWorkspace: false,
					},
				);
				log.info(
					`Retired container(s) left behind by archived project ${ref(project.slug, project.id)}`,
				);
			} catch (err) {
				log.warn(
					`Failed to retire containers for archived project ${ref(project.slug, project.id)}:`,
					err,
				);
			}
		}
	}

	/**
	 * Bring projects whose DB says container_status = running back to actually-
	 * running. Covers the host-reboot / Docker-restart case where the server
	 * never got to mark the container as stopped. Missing containers are
	 * re-provisioned from scratch; stopped ones are started in place. Projects
	 * stopped deliberately — by the operator or by the idle-stop cron (both write
	 * container_status = stopped) — are left alone to lazy-start on demand.
	 */
	private async restartStoppedRunningContainers(docker: ContainerEngine): Promise<void> {
		const { db, wsManager, containerLogStreamer, logs } = this.deps;

		const reachable = await docker.ping();
		if (!reachable) {
			log.warn('Docker not reachable at startup; skipping container restart pass');
			return;
		}

		const candidates = await db.query<{
			id: string;
			team_id: string;
			slug: string;
			team_slug: string;
			container_id: string;
			container_status: string | null;
			docker_base_image: string;
			dev_ports: Array<{ container: number; host: number }>;
		}>(
			`SELECT p.id, p.team_id, p.slug, c.slug AS team_slug,
			        p.container_id, p.container_status, p.docker_base_image, p.dev_ports
			 FROM projects p
			 JOIN teams c ON c.id = p.team_id
			 WHERE p.container_status = $1::container_status AND p.container_id IS NOT NULL
			   AND p.archived_at IS NULL`,
			[ContainerStatus.Running],
		);

		let restarted = 0;
		let reprovisioned = 0;

		for (const row of candidates.rows) {
			try {
				const info = await docker.inspectContainer(row.container_id);

				if (info === null) {
					await provisionContainer(
						this.buildContainerDeps(),
						{
							id: row.id,
							team_id: row.team_id,
							slug: row.slug,
							docker_base_image: row.docker_base_image,
							container_id: row.container_id,
							container_status: row.container_status,
							dev_ports: row.dev_ports ?? [],
						},
						row.team_slug,
					);
					reprovisioned++;
					log.info(
						`Re-provisioned project ${ref(row.slug, row.id)} — container was missing from Docker`,
					);
					continue;
				}

				if (info.State.Running) continue;

				await docker.startContainer(row.container_id);
				await db.query(
					'UPDATE projects SET container_error = NULL, container_last_started_at = now() WHERE id = $1',
					[row.id],
				);
				containerLogStreamer.subscribe(row.id, row.container_id, logs, docker);
				broadcastRowChange(wsManager, wsRoom.team(row.team_id), 'projects', 'UPDATE', {
					id: row.id,
					container_status: ContainerStatus.Running,
					container_error: null,
				});
				await wakeAgentsWithPendingWork(db, row.id, row.team_id).catch((e) =>
					log.error(
						`Failed to wake agents after startup restart for project ${ref(row.slug, row.id)}:`,
						e,
					),
				);
				restarted++;
				log.info(
					`Restarted container ${ref(row.slug, row.container_id.slice(0, 12))} for project ${ref(row.slug, row.id)}`,
				);
			} catch (err) {
				log.error(
					`Failed to restart container for project ${ref(row.slug, row.id)} on startup:`,
					err,
				);
			}
		}

		if (restarted > 0 || reprovisioned > 0) {
			log.info(
				`Startup container restart: restarted ${restarted}, re-provisioned ${reprovisioned}`,
			);
		}
	}

	/**
	 * Containers that survived a server restart can have stale bind mounts on
	 * macOS Docker Desktop — they inspect as Running but every exec fails with
	 * "current working directory is outside of container mount namespace root".
	 * Probe each running container's `/workspace` and rebuild the broken ones
	 * so wakeups don't loop on an unrecoverable exec error.
	 */
	private async repairStaleContainerMounts(docker: ContainerEngine): Promise<void> {
		const { db } = this.deps;

		const running = await db.query<{
			id: string;
			team_id: string;
			slug: string;
			team_slug: string;
			container_id: string;
			container_status: string | null;
			docker_base_image: string;
			dev_ports: Array<{ container: number; host: number }>;
		}>(
			`SELECT p.id, p.team_id, p.slug, c.slug AS team_slug,
			        p.container_id, p.container_status, p.docker_base_image, p.dev_ports
			 FROM projects p
			 JOIN teams c ON c.id = p.team_id
			 WHERE p.container_status = $1::container_status AND p.container_id IS NOT NULL
			   AND p.archived_at IS NULL`,
			[ContainerStatus.Running],
		);

		for (const row of running.rows) {
			if (!row.container_id) continue;
			const ok = await verifyContainerWorkspace(docker, row.container_id);
			if (ok) continue;

			log.warn(
				`Container ${ref(row.slug, row.container_id.slice(0, 12))} for project ${ref(row.slug, row.id)} has unreachable /workspace mount — removing`,
			);
			// Removed, not replaced. Provisioning a fresh container here would race
			// the pool, which provisions one anyway on the next run that needs one -
			// and eagerly rebuilding meant a stale mount on an idle project paid for
			// a container nobody was waiting on.
			try {
				await destroyContainer(
					this.buildContainerDeps(),
					row.id,
					row.slug,
					row.team_id,
					row.container_id,
				);
			} catch (err) {
				log.error(`Failed to remove stale container for project ${ref(row.slug, row.id)}:`, err);
			}
		}
	}

	/**
	 * Fourth startup reconcile pass: reap dangling processes previous server
	 * lifetimes left inside the (deliberately warm-surviving) project containers.
	 * Docker can't kill an exec'd process, so any exec in flight when the server
	 * stopped — an agent CLI, a git fetch and its SSH-bridge tree, an npm install
	 * — keeps running in the container forever unless swept here.
	 *
	 * Runs after the stranded-run repair has already flipped previous-lifetime
	 * `running` runs to `failed`, so the status-aware policy in
	 * `decideSweepKills` sees them as non-succeeded and kills their trees, while
	 * background processes a *succeeded* run intentionally left (e.g. a dev
	 * server) are preserved. Legacy trees from versions predating the scope
	 * marker are caught by their bridge cmdline / `SSH_AUTH_SOCK=/run/hezo/` env.
	 * Best-effort per container: a container stopping mid-sweep just logs.
	 */
	private async sweepDanglingContainerProcesses(docker: ContainerEngine): Promise<void> {
		const { db } = this.deps;

		const reachable = await docker.ping();
		if (!reachable) {
			log.warn('Docker not reachable at startup; skipping dangling-process sweep');
			return;
		}

		const running = await db.query<{ id: string; slug: string; container_id: string }>(
			`SELECT p.id, p.slug, p.container_id
			 FROM projects p
			 WHERE p.container_status = $1::container_status AND p.container_id IS NOT NULL`,
			[ContainerStatus.Running],
		);
		if (running.rows.length === 0) return;

		const scans: Array<{ row: (typeof running.rows)[number]; procs: ContainerProcessInfo[] }> = [];
		for (const row of running.rows) {
			try {
				const procs = await docker.listHezoProcesses(row.container_id);
				if (procs.length > 0) scans.push({ row, procs });
			} catch (err) {
				log.warn(`Dangling-process scan failed for project ${ref(row.slug, row.id)}:`, err);
			}
		}
		if (scans.length === 0) return;

		// One batched lookup across every container: which scanned run ids belong
		// to runs that completed successfully (their leftovers are intentional).
		const candidateIds = collectCandidateRunIds(scans.flatMap((s) => s.procs));
		let succeeded = new Set<string>();
		if (candidateIds.length > 0) {
			const rows = await db.query<{ id: string }>(
				`SELECT id FROM heartbeat_runs
				 WHERE status = $1::heartbeat_run_status AND id = ANY($2::uuid[])`,
				[HeartbeatRunStatus.Succeeded, candidateIds],
			);
			succeeded = new Set(rows.rows.map((r) => r.id));
		}

		for (const { row, procs } of scans) {
			const kills = decideSweepKills(procs, succeeded);
			if (kills.length === 0) continue;
			try {
				await docker.killPids(row.container_id, kills);
				log.info(
					`Swept ${kills.length} dangling process(es) in container for project ${ref(row.slug, row.id)} (${procs.length - kills.length} preserved)`,
				);
			} catch (err) {
				log.warn(`Dangling-process kill failed for project ${ref(row.slug, row.id)}:`, err);
			}
		}
	}

	private async selfHealErroredContainers(docker: ContainerEngine): Promise<void> {
		const { db, wsManager, containerLogStreamer, logs } = this.deps;

		const reachable = await docker.ping();
		if (!reachable) {
			log.warn('Docker not reachable at startup; skipping container self-heal');
			return;
		}

		const candidates = await db.query<{
			id: string;
			team_id: string;
			slug: string;
			team_slug: string;
		}>(
			`SELECT p.id, p.team_id, p.slug, c.slug AS team_slug
			 FROM projects p
			 JOIN teams c ON c.id = p.team_id
			 WHERE (p.container_status = $1::container_status
			        OR (p.container_status IS NULL AND p.container_id IS NULL))
			   -- A null status with a null container id is exactly what an archived
			   -- project is left in, so without this the self-heal adopted a retired
			   -- project's container back by name and re-listed it.
			   AND p.archived_at IS NULL`,
			[ContainerStatus.Error],
		);

		for (const project of candidates.rows) {
			const name = `hezo-${project.slug}-${project.id.slice(0, 8)}`;
			let info: Awaited<ReturnType<ContainerEngine['findContainerByNamePrefix']>>;
			try {
				info = await docker.findContainerByNamePrefix(name);
			} catch (err) {
				log.warn(`Self-heal inspect failed for ${name}:`, err);
				continue;
			}
			if (info === null || !info.State.Running) continue;

			await db.query(
				`UPDATE projects
				 SET container_id = $1, container_status = $2::container_status,
				     container_last_started_at = now()
				 WHERE id = $3`,
				[info.Id, ContainerStatus.Running, project.id],
			);
			containerLogStreamer.subscribe(project.id, info.Id, logs, docker);
			broadcastRowChange(wsManager, wsRoom.team(project.team_id), 'projects', 'UPDATE', {
				id: project.id,
				container_id: info.Id,
				container_status: ContainerStatus.Running,
			});
			log.info(
				`Self-healed project ${ref(project.slug, project.id)} — re-attached to live container ${name}`,
			);
		}
	}

	/**
	 * Run a cron tick unless the previous one is still going.
	 *
	 * A skipped tick is reported, not silent. The overlap guard means a job that
	 * consistently overruns its period simply stops running at its stated cadence
	 * — container status goes stale, wakeups dispatch late — with nothing in the
	 * log to say so. That is how #186's stalled sync loop stayed invisible. The
	 * warning is rate-limited so a job that is merely slow for a while does not
	 * flood, while a job that is permanently behind keeps saying so.
	 */
	private async guarded(name: string, fn: () => Promise<void>): Promise<void> {
		if (this.guards.get(name)) {
			const now = Date.now();
			const lastWarned = this.skipWarnedAt.get(name) ?? 0;
			const skipped = (this.skippedTicks.get(name) ?? 0) + 1;
			this.skippedTicks.set(name, skipped);
			if (now - lastWarned >= SKIP_WARN_INTERVAL_MS) {
				this.skipWarnedAt.set(name, now);
				log.warn(
					`Job ${name} is overrunning its interval; ${skipped} tick(s) skipped while the previous run is still in flight`,
				);
				this.skippedTicks.set(name, 0);
			}
			return;
		}
		this.guards.set(name, true);
		try {
			await fn();
		} catch (error) {
			log.error(`Job ${name} error:`, error);
		} finally {
			this.guards.set(name, false);
		}
	}

	private async isTaskBusy(payload: Record<string, unknown> | null | undefined): Promise<boolean> {
		const taskId = typeof payload?.task_id === 'string' ? payload.task_id : null;
		if (!taskId) return false;
		// In-memory guard closes the race window between dispatch and
		// createHeartbeatRun, before the DB-backed check is authoritative.
		if (this.activeTaskRuns.has(taskId)) return true;
		return isTaskBusyInDb(this.deps.db, taskId);
	}

	/**
	 * Would running in `projectId` need a container start that exceeds the
	 * instance's active-container cap? A project with a container genuinely free
	 * to take the run — or one already being lazy-started by a concurrent
	 * dispatch — is never blocked, because its run consumes no new slot. Note
	 * "free", not merely "running": with a pool, a project whose containers are
	 * all busy needs a *new* container and is gated like any other start.
	 * Task-less callers pass null and are gated on the total alone (activateAgent
	 * re-checks with the chosen task's project). The in-memory pending-start
	 * refcounts lead the DB while a lazy start is in flight and are deduped
	 * against projects that already have spare capacity, so the ceiling is never
	 * exceeded.
	 */
	private async isContainerCapacityBlocked(projectId: string | null): Promise<CapacityVerdict> {
		const active = await getActiveContainers(this.deps.db, this.deps.docker);
		const { budgetGb, usedMemoryGb, projectsWithSpareContainer } = active;
		// Returned alongside the verdict, not just consumed here: the dispatch that
		// follows has to know whether it is about to *create* a container, and it
		// used to answer that from `projects.container_status` instead. Those two
		// stopped meaning the same thing the moment a project could hold several
		// containers - a project whose named container reads Running but whose
		// members are all busy needs a new one - so a dispatch would create a
		// container while holding no pending-start slot, and two of them could fit
		// themselves into the same headroom. One query, one answer, used by both.
		const hasSpareContainer = projectId !== null && projectsWithSpareContainer.has(projectId);
		if (projectId && (hasSpareContainer || this.pendingContainerStarts.has(projectId))) {
			return { blocked: false, hasSpareContainer };
		}
		// A lazy start already in flight has not reached the DB yet, so its memory
		// has to be added here or two dispatches would both see room for the same
		// GB. Charged at the starting project's own cap, not a flat figure - that
		// is the whole reason the gate moved from a count to a budget.
		//
		// One query for all of them, not one per project: this runs on the dispatch
		// path, and a gate whose cost grows with the number of starts it is gating
		// is the wrong shape however small the number happens to be today.
		const pendingIds = [...this.pendingContainerStarts.keys()].filter(
			(id) => !projectsWithSpareContainer.has(id),
		);
		const pendingGb = await sumProjectContainerMemoryGb(this.deps.db, pendingIds);
		const requestGb = projectId
			? await projectContainerMemoryGb(this.deps.db, projectId)
			: await getDefaultRamCapPerContainerGb(this.deps.db);
		// Idle containers held by *other* projects are headroom, because the acquire
		// path can retire them to make room. Leaving them out here is what stopped a
		// starved run ever reaching that path: the dispatch was skipped as
		// `InstanceAtCapacity` and the reclaim rung never ran. The same figure is
		// added in `isContainerCapacityBlockedInDb`, which is this check's stateless
		// twin and must not drift from it.
		const headroomGb = budgetGb + reclaimableForOthers(active, projectId);
		return { blocked: usedMemoryGb + pendingGb + requestGb > headroomGb, hasSpareContainer };
	}

	private acquirePendingContainerStart(projectId: string): void {
		this.pendingContainerStarts.set(
			projectId,
			(this.pendingContainerStarts.get(projectId) ?? 0) + 1,
		);
	}

	private releasePendingContainerStart(projectId: string): void {
		const next = (this.pendingContainerStarts.get(projectId) ?? 0) - 1;
		if (next > 0) this.pendingContainerStarts.set(projectId, next);
		else this.pendingContainerStarts.delete(projectId);
	}

	private acquireProjectRun(projectId: string): void {
		this.activeProjectRuns.set(projectId, (this.activeProjectRuns.get(projectId) ?? 0) + 1);
	}

	private releaseProjectRun(projectId: string): void {
		const next = (this.activeProjectRuns.get(projectId) ?? 0) - 1;
		if (next > 0) this.activeProjectRuns.set(projectId, next);
		else this.activeProjectRuns.delete(projectId);
	}

	private async markWakeupSkipped(
		wakeupId: string,
		reason: WakeupSkipReason,
		taskId: string | null,
		teamId: string,
		blockerTaskId: string | null,
	): Promise<void> {
		const { db, wsManager } = this.deps;
		await db.query(
			`UPDATE agent_wakeup_requests
			 SET last_skipped_at = now(),
			     last_skipped_reason = $2,
			     last_skipped_blocker_task_id = $3
			 WHERE id = $1`,
			[wakeupId, reason, blockerTaskId],
		);
		if (taskId) {
			const refreshed = await db.query<Record<string, unknown>>(
				'SELECT * FROM tasks WHERE id = $1',
				[taskId],
			);
			if (refreshed.rows[0]) {
				broadcastRowChange(wsManager, wsRoom.team(teamId), 'tasks', 'UPDATE', refreshed.rows[0]);
			}
		}
	}

	private async resolveProjectForTask(
		taskId: string,
	): Promise<{ id: string; slug: string } | null> {
		const { db } = this.deps;
		const r = await db.query<{ project_id: string; slug: string }>(
			`SELECT t.project_id, p.slug
			 FROM tasks t
			 JOIN projects p ON p.id = t.project_id
			 WHERE t.id = $1`,
			[taskId],
		);
		const row = r.rows[0];
		return row ? { id: row.project_id, slug: row.slug } : null;
	}

	/** Return a claimed wakeup to the queue so a later dispatch can retry it. */
	private async requeueWakeup(wakeupId: string | undefined): Promise<void> {
		if (!wakeupId) return;
		await this.deps.db.query(
			'UPDATE agent_wakeup_requests SET status = $1::wakeup_status, claimed_at = NULL WHERE id = $2',
			[WakeupStatus.Queued, wakeupId],
		);
	}

	/**
	 * True when this agent already has an in-flight run in the project. Dispatch
	 * serialises per agent+project (the launchTask key), so a second run for the
	 * same pair would be dropped — callers re-queue instead. The in-memory guard
	 * leads the DB during the window between launch and the run row landing; the
	 * `heartbeat_runs` query is authoritative once the row exists.
	 */
	private async isAgentBusyInProject(memberId: string, projectId: string): Promise<boolean> {
		if (this.isTaskRunning(`${memberId}:${projectId}`)) return true;
		const active = await this.deps.db.query(
			`SELECT 1 FROM heartbeat_runs hr
			 JOIN tasks t ON t.id = hr.task_id
			 WHERE hr.member_id = $1
			   AND t.project_id = $2
			   AND hr.status IN ($3::heartbeat_run_status, $4::heartbeat_run_status)
			 LIMIT 1`,
			[memberId, projectId, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
		);
		return active.rows.length > 0;
	}

	/**
	 * Put back wakeups that were parked on a precondition which has since been
	 * met.
	 *
	 * `deferred` is terminal unless something flips it, and the only thing that
	 * flips `awaiting_repo_setup` is `finalizePendingRepoSetup`, reached solely
	 * from a repo setup that reaches `finishReady`. It misses three ways: it
	 * returns early when no approval is pending, it selects on
	 * `payload->>'project_id'`, and it then skips any row without a `task_id`.
	 * Any miss parks the wakeup for good - and with the queue empty the only
	 * remaining driver is the heartbeat sweep, floored at an hour and commonly
	 * configured far longer, so an instance with assigned, unblocked, in-progress
	 * work sat idle for half a day with nothing saying why.
	 *
	 * The project is resolved through the wakeup's **task**, not through
	 * `payload->>'project_id'`, precisely because that key is one of the things
	 * the one-shot path misses. `reason = 'blocked'` is left alone: it has its own
	 * release in `wakeIfReady`, and two writers for one row is a race.
	 *
	 * This is a backstop, not the fast path - `finalizePendingRepoSetup` still
	 * resumes work the moment setup completes.
	 */
	private async releaseSatisfiedDeferrals(): Promise<void> {
		const { db } = this.deps;
		const released = await db.query<{ id: string; slug: string }>(
			`UPDATE agent_wakeup_requests w
			    SET status = $1::wakeup_status, claimed_at = NULL
			   FROM tasks t
			   JOIN projects p ON p.id = t.project_id
			  WHERE w.id IN (
			          SELECT w2.id FROM agent_wakeup_requests w2
			           WHERE w2.status = $2::wakeup_status
			             AND w2.payload->>'reason' = 'awaiting_repo_setup'
			           ORDER BY w2.created_at ASC
			           LIMIT ${DEFERRAL_RELEASE_LIMIT})
			    AND t.id = (w.payload->>'task_id')::uuid
			    AND p.designated_repo_id IS NOT NULL
			  RETURNING w.id, p.slug`,
			[WakeupStatus.Queued, WakeupStatus.Deferred],
		);
		if (released.rows.length === 0) return;
		// Warned rather than logged at debug: reaching here means work was stranded
		// until this ran, and a silent release leaves the next occurrence as
		// unexplained as the first. Zero output on a healthy instance.
		const projects = [...new Set(released.rows.map((r) => r.slug))].join(', ');
		log.warn(
			`Requeued ${released.rows.length} wakeup(s) left deferred on repo setup that has since completed (${projects})`,
		);
	}

	private async processWakeups(): Promise<void> {
		const { db } = this.deps;
		await this.releaseSatisfiedDeferrals();
		const coalescingCutoff = new Date(
			Date.now() - runtimeConfig().jobs.wakeupCoalescingMs,
		).toISOString();

		const wakeups = await db.query<{
			id: string;
			member_id: string;
			team_id: string;
			source: string;
			payload: Record<string, unknown>;
			created_at: string;
		}>(
			`SELECT id, member_id, team_id, source, payload, created_at
			 FROM agent_wakeup_requests
			 WHERE status = $2::wakeup_status
			   AND created_at < $1
			 ORDER BY created_at ASC
			 LIMIT 10`,
			[coalescingCutoff, WakeupStatus.Queued],
		);

		if (wakeups.rows.length > 0) {
			log.debug(`Processing ${wakeups.rows.length} queued wakeup(s)`);
		}

		for (const wakeup of wakeups.rows) {
			const wakeupTaskId =
				typeof wakeup.payload?.task_id === 'string' ? wakeup.payload.task_id : null;
			if (wakeupTaskId) {
				if (await this.isTaskBusy(wakeup.payload)) {
					log.debug(`Skipping wakeup ${wakeup.id} — target task already has an active run`);
					await this.markWakeupSkipped(
						wakeup.id,
						WakeupSkipReason.TaskBusy,
						wakeupTaskId,
						wakeup.team_id,
						wakeupTaskId,
					);
					continue;
				}
				const project = await this.resolveProjectForTask(wakeupTaskId);
				if ((await this.isContainerCapacityBlocked(project?.id ?? null)).blocked) {
					log.debug(`Skipping wakeup ${wakeup.id} — instance is at its active-container limit`);
					await this.markWakeupSkipped(
						wakeup.id,
						WakeupSkipReason.InstanceAtCapacity,
						wakeupTaskId,
						wakeup.team_id,
						null,
					);
					continue;
				}
				if (project && (await this.isAgentBusyInProject(wakeup.member_id, project.id))) {
					log.debug(
						`Skipping wakeup ${wakeup.id} — agent ${wakeup.member_id} already running in project ${ref(project.slug, project.id)}`,
					);
					await this.markWakeupSkipped(
						wakeup.id,
						WakeupSkipReason.AgentRunning,
						wakeupTaskId,
						wakeup.team_id,
						null,
					);
					continue;
				}
			} else if (this.isMemberRunning(wakeup.member_id)) {
				// Task-less wakeup (e.g. queued heartbeat) — picks a task inside
				// activateAgent, so we can't pre-check a task lock or a project's
				// container here (activateAgent re-checks the container cap once the
				// task is chosen). Fall back to per-agent dedup to avoid stacking
				// idle pings.
				log.debug(`Skipping wakeup ${wakeup.id} — agent ${wakeup.member_id} already running`);
				await this.markWakeupSkipped(
					wakeup.id,
					WakeupSkipReason.AgentRunning,
					null,
					wakeup.team_id,
					null,
				);
				continue;
			}

			// A still-queued `assignment` wakeup whose task was already worked by a
			// completed run is stale: that run read the task at boot and served the
			// assignment. `absorbQueuedTaskWakeups` only retires such siblings that
			// were queued at run *start*; this catches the ones that become claimable
			// later (blocker-deferred flips, busy-skip survivors) so they don't fire a
			// redundant back-to-back run. Genuine re-assignments and triggers created
			// after the run keep firing — their created_at is newer than its started_at.
			if (
				wakeupTaskId &&
				wakeup.source === WakeupSource.Assignment &&
				(await assignmentWakeupAlreadyServed(db, wakeup.member_id, wakeupTaskId, wakeup.created_at))
			) {
				await db.query(
					'UPDATE agent_wakeup_requests SET status = $1::wakeup_status WHERE id = $2',
					[WakeupStatus.Coalesced, wakeup.id],
				);
				log.debug(
					`Retiring stale assignment wakeup ${wakeup.id} — task ${wakeupTaskId} already served by a completed run`,
				);
				const refreshed = await db.query<Record<string, unknown>>(
					'SELECT * FROM tasks WHERE id = $1',
					[wakeupTaskId],
				);
				if (refreshed.rows[0]) {
					broadcastRowChange(
						this.deps.wsManager,
						wsRoom.team(wakeup.team_id),
						'tasks',
						'UPDATE',
						refreshed.rows[0],
					);
				}
				continue;
			}

			const targetTaskId =
				typeof wakeup.payload?.task_id === 'string' ? wakeup.payload.task_id : null;
			if (await shouldDeferWakeupForBlockers(db, wakeup.source, targetTaskId)) {
				await db.query(
					`UPDATE agent_wakeup_requests
					 SET status = $1::wakeup_status, payload = payload || $2::jsonb
					 WHERE id = $3`,
					[WakeupStatus.Deferred, JSON.stringify({ reason: 'blocked' }), wakeup.id],
				);
				log.debug(`Deferred wakeup ${wakeup.id} — task ${targetTaskId} has open blockers`);
				continue;
			}

			await db.query(
				`UPDATE agent_wakeup_requests
				 SET status = $1::wakeup_status,
				     claimed_at = now(),
				     last_skipped_at = NULL,
				     last_skipped_reason = NULL,
				     last_skipped_blocker_task_id = NULL
				 WHERE id = $2`,
				[WakeupStatus.Claimed, wakeup.id],
			);
			if (wakeupTaskId) {
				const refreshed = await db.query<Record<string, unknown>>(
					'SELECT * FROM tasks WHERE id = $1',
					[wakeupTaskId],
				);
				if (refreshed.rows[0]) {
					broadcastRowChange(
						this.deps.wsManager,
						wsRoom.team(wakeup.team_id),
						'tasks',
						'UPDATE',
						refreshed.rows[0],
					);
				}
			}

			try {
				await this.activateAgent(
					wakeup.member_id,
					wakeup.team_id,
					wakeup.id,
					wakeup.payload,
					wakeup.source,
				);
			} catch (error) {
				log.error(`activateAgent threw for wakeup ${wakeup.id}:`, error);
				await db
					.query('UPDATE agent_wakeup_requests SET status = $1::wakeup_status WHERE id = $2', [
						WakeupStatus.Failed,
						wakeup.id,
					])
					.catch(() => {});
			}
		}
	}

	private async processScheduledHeartbeats(): Promise<void> {
		const { db } = this.deps;

		const dueAgents = await db.query<{
			id: string;
			team_id: string;
			heartbeat_interval_min: number;
		}>(
			`SELECT ma.id, m.team_id, ma.heartbeat_interval_min
			 FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE ma.admin_status = $1
			   AND ma.runtime_status <> ALL($2::agent_runtime_status[])
			   AND (ma.last_heartbeat_at IS NULL
			        OR ma.last_heartbeat_at + (GREATEST(ma.heartbeat_interval_min, $3::int) || ' minutes')::interval < now())
			   AND NOT EXISTS (
			        SELECT 1 FROM heartbeat_runs hr
			        WHERE hr.member_id = ma.id
			          AND hr.finished_at IS NOT NULL
			          AND hr.finished_at > now() - ($4::int || ' seconds')::interval
			   )
			 LIMIT 5`,
			[
				AgentAdminStatus.Enabled,
				BUDGET_PAUSE_STATUSES_PG,
				heartbeatIntervalFloorMin(),
				runtimeConfig().jobs.heartbeatCooldownSec,
			],
		);

		if (dueAgents.rows.length > 0) {
			log.debug(`${dueAgents.rows.length} agent(s) due for heartbeat`);
		}

		for (const agent of dueAgents.rows) {
			if (this.isMemberRunning(agent.id)) {
				continue;
			}
			const payload = { reason: 'scheduled_heartbeat' };
			const wakeupId = await createWakeup(
				this.deps.db,
				agent.id,
				agent.team_id,
				WakeupSource.Heartbeat,
				payload,
			);
			await this.deps.db.query(
				'UPDATE agent_wakeup_requests SET status = $1::wakeup_status, claimed_at = now() WHERE id = $2',
				[WakeupStatus.Claimed, wakeupId],
			);
			await this.activateAgent(agent.id, agent.team_id, wakeupId, payload, WakeupSource.Heartbeat);
		}
	}

	/**
	 * Lift (or restamp) a reactive budget pause once the agent's spend changes.
	 *
	 * Spend is summed on demand over rolling UTC windows (daily/weekly/monthly),
	 * so when a window rolls over the agent's effective spend drops with no event
	 * to react to. The budget gate (`activateAgent`) only fires on a wakeup, and
	 * `processScheduledHeartbeats` deliberately skips paused agents — so without
	 * this sweep an autonomous (heartbeat-only) agent that trips a daily/weekly
	 * cap would stay paused indefinitely, never re-evaluated after the window
	 * resets. Only the budget-pause states are candidates (a human `paused` and
	 * in-flight runs are left alone); `reconcileBudgetPause` re-checks each and
	 * resumes it to `idle`, or restamps the scope if a different window now binds.
	 * The gate stays the authority: it re-pauses on the next run if breached again.
	 */
	private async processBudgetResumes(): Promise<void> {
		const { db } = this.deps;
		// The agent's own project (1:1 team↔project) feeds the project-window half
		// of the check; instance agents (HQ, only an internal project) resolve to
		// NULL and are checked on their agent windows alone — matching the gate,
		// which checks agent windows always and a project's only when one is resolved.
		const paused = await db.query<{ id: string; team_id: string; project_id: string | null }>(
			`SELECT ma.id, m.team_id, p.id AS project_id
			 FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 LEFT JOIN projects p ON p.team_id = m.team_id AND p.is_internal = false
			 WHERE ma.runtime_status = ANY($1::agent_runtime_status[])`,
			[BUDGET_PAUSE_STATUSES_PG],
		);

		for (const agent of paused.rows) {
			await reconcileBudgetPause(
				db,
				agent.id,
				agent.team_id,
				agent.project_id,
				this.deps.wsManager,
			);
		}
	}

	private async activateAgent(
		memberId: string,
		teamId: string,
		wakeupId: string,
		wakeupPayload: Record<string, unknown>,
		wakeupSource: string,
	): Promise<void> {
		const { db, docker, masterKeyManager, serverPort } = this.deps;

		const agent = await db.query<{
			id: string;
			title: string;
			slug: string;
			admin_status: string;
			heartbeat_interval_min: number;
			run_timeout_min: number;
			default_effort: string;
			touches_code: boolean;
			model_override_provider: AiProvider | null;
			model_override_model: string | null;
		}>(
			`SELECT id, title, slug, admin_status,
			        heartbeat_interval_min, run_timeout_min, default_effort, touches_code,
			        model_override_provider, model_override_model
			 FROM member_agents WHERE id = $1`,
			[memberId],
		);

		if (agent.rows.length === 0 || agent.rows[0].admin_status !== AgentAdminStatus.Enabled) {
			log.debug(`Agent ${memberId} not found or disabled — skipping`);
			if (wakeupId) {
				await db.query(
					'UPDATE agent_wakeup_requests SET status = $1::wakeup_status WHERE id = $2',
					[WakeupStatus.Skipped, wakeupId],
				);
			}
			return;
		}

		// Instance-level agents (CEO, Coach) own tasks across every project-team, so
		// their task selection spans all teams; the run itself is scoped to the
		// chosen task's project (see the run-team split in agent-runner).
		const isInstanceAgent = (INSTANCE_AGENT_SLUGS as readonly string[]).includes(
			agent.rows[0].slug,
		);

		type TaskRow = {
			id: string;
			identifier: string;
			title: string;
			description: string;
			status: string;
			priority: string;
			project_id: string;
			rules: string | null;
			progress_summary: string | null;
			assignee_id: string | null;
			runtime_type: AgentRuntime | null;
			parent_task_id: string | null;
			created_by_run_id: string | null;
		};

		let task: TaskRow | undefined;

		// Wakeups with an explicit task_id (mentions, comments, coach triggers) target
		// that specific task — even if the agent isn't the assignee.
		const payloadTaskId =
			typeof wakeupPayload?.task_id === 'string' ? wakeupPayload.task_id : undefined;
		if (payloadTaskId) {
			// Joined to the project so an archived one is filtered here rather than
			// discovered further down: an archived project has no container and may
			// not be given one, so a wakeup naming a task inside it can only fail.
			const payloadTask = await db.query<TaskRow>(
				`SELECT i.id, i.identifier, i.title, i.description, i.status, i.priority, i.project_id, i.rules, i.progress_summary, i.assignee_id, i.runtime_type, i.parent_task_id, i.created_by_run_id
				 FROM tasks i
				 JOIN projects ap ON ap.id = i.project_id AND ap.archived_at IS NULL
				 WHERE i.id = $1${isInstanceAgent ? '' : ' AND i.team_id = $2'}`,
				isInstanceAgent ? [payloadTaskId] : [payloadTaskId, teamId],
			);
			if (payloadTask.rows.length === 0) {
				log.debug(
					`Payload task ${payloadTaskId} not found, or its project is archived, for agent ${ref(agent.rows[0].slug, memberId)}`,
				);
				if (wakeupId) {
					await db.query(
						`UPDATE agent_wakeup_requests SET status = $1::wakeup_status, completed_at = now() WHERE id = $2`,
						[WakeupStatus.Completed, wakeupId],
					);
				}
				return;
			}
			task = payloadTask.rows[0];
		} else {
			// The Captain's periodic heartbeat first checks whether any of the project's
			// goals are due for a progress assessment. If so, it runs one progress-update run
			// (no task, kind=progress_update) and yields this activation; ordinary task work
			// resumes on the next heartbeat. Goals not yet due are skipped entirely.
			if (agent.rows[0].slug === CAPTAIN_AGENT_SLUG) {
				const result = await this.tryDispatchProgressUpdate(
					memberId,
					teamId,
					{
						id: memberId,
						title: agent.rows[0].title,
						slug: agent.rows[0].slug,
						default_effort: agent.rows[0].default_effort,
						model_override_provider: agent.rows[0].model_override_provider,
						model_override_model: agent.rows[0].model_override_model,
						run_timeout_min: agent.rows[0].run_timeout_min,
					},
					wakeupId,
					wakeupPayload,
				);
				// Yield this activation when a progress-update run launched, or when a concurrent
				// one already holds the key (the wakeup was requeued to retry). Any other reason
				// (no due goals, over budget, …) falls through to normal task selection.
				if (result.dispatched || result.reason === 'launch_conflict') return;

				// A manually-queued progress-update wakeup ("Run now" while the Captain was
				// busy) must NEVER fall through to task selection — the user asked for a
				// progress assessment, not for the Captain to start unrelated task work.
				// Handle every non-launched outcome here and always return. (The wakeup was
				// already claimed by the dispatcher, so the transient branch must re-queue it,
				// not just stamp a skip reason — otherwise it would stick in `claimed`.)
				if (wakeupPayload?.trigger === 'progress_update_now' && wakeupId) {
					if (result.reason === 'agent_busy' || result.reason === 'instance_at_capacity') {
						// Still transient — re-queue so a later cron tick retries once the
						// Captain frees / capacity clears.
						const skipReason =
							result.reason === 'instance_at_capacity'
								? WakeupSkipReason.InstanceAtCapacity
								: WakeupSkipReason.AgentRunning;
						await db.query(
							`UPDATE agent_wakeup_requests
							 SET status = $1::wakeup_status, claimed_at = NULL,
							     last_skipped_at = now(), last_skipped_reason = $2
							 WHERE id = $3`,
							[WakeupStatus.Queued, skipReason, wakeupId],
						);
					} else {
						// Terminal by dispatch time (goals no longer due, or over budget): the
						// queued run is a no-op. Complete it so it doesn't spin forever.
						await db.query(
							`UPDATE agent_wakeup_requests SET status = $1::wakeup_status, completed_at = now() WHERE id = $2`,
							[WakeupStatus.Completed, wakeupId],
						);
					}
					return;
				}
			}

			// Instance agents (CEO/Coach) select across every team; everyone else is
			// scoped to their own team. Build the params positionally so the team
			// filter is only present when its placeholder is.
			const params: unknown[] = [memberId];
			let teamClause = '';
			if (!isInstanceAgent) {
				params.push(teamId);
				teamClause = ` AND i.team_id = $${params.length}`;
			}
			const termStart = params.length + 1;
			params.push(...TERMINAL_TASK_STATUSES);
			const termList = TERMINAL_TASK_STATUSES.map((_, i) => `$${termStart + i}`).join(', ');
			const prStart = params.length + 1;
			params.push(TaskPriority.Urgent, TaskPriority.High, TaskPriority.Medium, TaskPriority.Low);
			const tasks = await db.query<TaskRow>(
				`SELECT i.id, i.identifier, i.title, i.description, i.status, i.priority, i.project_id, i.rules, i.progress_summary, i.assignee_id, i.runtime_type, i.parent_task_id, i.created_by_run_id
				 FROM tasks i
				 -- An archived project's tasks are not actionable: it has no container
				 -- and may not be given one. Filtered in the selection rather than
				 -- rejected after it, so the agent falls into the ordinary "nothing to
				 -- do" branch below instead of failing a wakeup every heartbeat.
				 JOIN projects ap ON ap.id = i.project_id AND ap.archived_at IS NULL
				 WHERE i.assignee_id = $1${teamClause}
				   AND i.status NOT IN (${termList})
				   AND NOT EXISTS (
				     SELECT 1 FROM task_dependencies d
				     JOIN tasks b ON b.id = d.blocked_by_task_id
				     WHERE d.task_id = i.id
				       AND b.status NOT IN (${termList})
				   )
				 ORDER BY
				   CASE i.priority WHEN $${prStart} THEN 0 WHEN $${prStart + 1} THEN 1 WHEN $${prStart + 2} THEN 2 WHEN $${prStart + 3} THEN 3 END,
				   i.created_at ASC
				 LIMIT 1`,
				params,
			);
			if (tasks.rows.length === 0) {
				log.debug(`No actionable tasks for agent ${ref(agent.rows[0].slug, memberId)}`);
				// The agent woke (heartbeat / task-less nudge) and found nothing to do.
				// Stamp the check so the scheduler throttles the next heartbeat to a
				// full interval out instead of re-selecting this agent every cron tick
				// (`last_heartbeat_at IS NULL` is perpetually "due"), which would also
				// leave the UI countdown stuck on "due now" and churn throwaway wakeup
				// rows. A real run advances this via setAgentIdleIfNoActiveRuns; a no-op
				// scan has no run to hang it on, so we advance it here.
				await db.query('UPDATE member_agents SET last_heartbeat_at = now() WHERE id = $1', [
					memberId,
				]);
				if (wakeupId) {
					await db.query(
						`UPDATE agent_wakeup_requests SET status = $1::wakeup_status, completed_at = now() WHERE id = $2`,
						[WakeupStatus.Completed, wakeupId],
					);
				}
				return;
			}
			task = tasks.rows[0];
		}

		// Dispatch suppressions. Placed here, after task resolution, because it is the
		// one point every wakeup source passes through holding a concrete task - both
		// the payload-targeted wakeups and the ones that select a task above. A gate
		// per source would have to be re-added to each new source; this cannot be
		// missed.
		//
		// Both ask the same question - would this run reach a conclusion the last one
		// already reached? - and differ only in what makes it stale. The no-work
		// backoff expires at the agent's own cadence; the parked-on-admin one expires
		// when a person answers. Each is skipped rather than re-queued: there is
		// nothing to retry, and the exempt sources in `no-work-backoff.ts` mean any
		// real new input dispatches immediately.
		const suppression = (await noWorkCooldownActive(db, memberId, task.id, wakeupSource))
			? {
					reason: WakeupSkipReason.NoWorkCooldown,
					detail: `reported no work on ${ref(task.identifier, task.id)} within its heartbeat interval and nothing has changed since`,
				}
			: (await parkedOnAdminAsk(db, memberId, task.id, wakeupSource))
				? {
						reason: WakeupSkipReason.ParkedOnAdmin,
						detail: `is waiting on an unanswered ask on ${ref(task.identifier, task.id)} and nobody has replied since`,
					}
				: null;
		if (suppression) {
			log.debug(
				`Agent ${ref(agent.rows[0].slug, memberId)} ${suppression.detail} — skipping wakeup`,
			);
			await this.markWakeupSkipped(wakeupId, suppression.reason, task.id, teamId, null);
			// Completed, not left claimed: the wakeup was considered and answered -
			// there is nothing to do - which is the same outcome as the "no actionable
			// tasks" branch above, and it must not sit in `claimed` forever. Not
			// re-queued either: retrying would re-ask a question already answered, and
			// the next container start or scheduled heartbeat raises a fresh wakeup
			// once the window has passed (or, when parked, once someone replies).
			if (wakeupId) {
				await db.query(
					`UPDATE agent_wakeup_requests SET status = $1::wakeup_status, completed_at = now() WHERE id = $2`,
					[WakeupStatus.Completed, wakeupId],
				);
			}
			return;
		}

		// Per-task serialisation plus the per-project concurrency ceiling: only one
		// agent runs on a given task at a time, and no more than the project's
		// configured limit of agents run concurrently in its shared container. Most
		// blocked wakeups are filtered earlier by processWakeups; this guard catches
		// heartbeat-style wakeups (no payload.task_id) where the chosen task is
		// determined here, plus any race where the task became busy or the project
		// reached capacity between the dispatcher check and now.
		if (await this.isTaskBusy({ task_id: task.id })) {
			log.debug(
				`Task ${ref(task.identifier, task.id)} already has an active run — re-queuing wakeup for ${ref(agent.rows[0].slug, memberId)}`,
			);
			await this.requeueWakeup(wakeupId);
			return;
		}
		const capacity = await this.isContainerCapacityBlocked(task.project_id);
		if (capacity.blocked) {
			log.debug(
				`Instance is at its active-container limit — re-queuing wakeup for ${ref(agent.rows[0].slug, memberId)}`,
			);
			await this.requeueWakeup(wakeupId);
			return;
		}
		// A given agent runs at most one task at a time within a project: dispatch
		// serialises on the agent+project pair and a second concurrent run would be
		// dropped. Re-queue before any lock or status side-effects so the wakeup
		// fires once the in-flight run frees the slot.
		if (await this.isAgentBusyInProject(memberId, task.project_id)) {
			log.debug(
				`Agent ${ref(agent.rows[0].slug, memberId)} already running in project ${task.project_id} — re-queuing wakeup`,
			);
			await this.requeueWakeup(wakeupId);
			return;
		}

		const project = await db.query<{
			id: string;
			slug: string;
			team_id: string;
			team_slug: string;
			container_id: string;
			container_status: string;
			designated_repo_id: string | null;
			is_internal: boolean;
		}>(
			`SELECT p.id, p.slug, p.team_id, c.slug AS team_slug,
			        p.container_id, p.container_status, p.designated_repo_id, p.is_internal
			 FROM projects p
			 JOIN teams c ON c.id = p.team_id
			 WHERE p.id = $1`,
			[task.project_id],
		);

		if (project.rows.length === 0) {
			log.debug(`Project ${task.project_id} not found — wakeup failed`);
			if (wakeupId) {
				await db.query(
					'UPDATE agent_wakeup_requests SET status = $1::wakeup_status WHERE id = $2',
					[WakeupStatus.Failed, wakeupId],
				);
			}
			return;
		}

		const projectRow = project.rows[0];
		// Realign the working team to the chosen task's project. For an instance
		// agent this is the project-team it is acting on, not its HQ home team.
		teamId = projectRow.team_id;

		// Budget gate: skip the run (no heartbeat_runs row, no container/repo work)
		// and pause the agent when it or its project is over any daily/weekly/monthly
		// window. The wakeup is recorded as skipped rather than re-queued so it does
		// not spin. Placed after project resolution so broadcasts hit the project team.
		const budgetBlock = await checkOverBudget(db, memberId, projectRow.id);
		if (budgetBlock) {
			log.debug(
				`Agent ${ref(agent.rows[0].slug, memberId)} over ${budgetBlock.scope} ${budgetBlock.period} budget — pausing and skipping wakeup`,
			);
			await pauseAgentForBudget(db, memberId, teamId, budgetBlock, this.deps.wsManager);
			await this.markWakeupSkipped(wakeupId, WakeupSkipReason.OverBudget, task.id, teamId, null);
			return;
		}

		const agentSlug = agent.rows[0].slug;
		const isConversationalWakeup =
			wakeupSource === WakeupSource.Mention ||
			wakeupSource === WakeupSource.Comment ||
			wakeupSource === WakeupSource.Reply;
		if (!isConversationalWakeup && !projectRow.designated_repo_id && agent.rows[0].touches_code) {
			try {
				const ensured = await ensureRepoSetupAction(db, {
					teamId,
					projectId: projectRow.id,
					taskId: task.id,
				});
				if (ensured.commentRow) {
					broadcastRowChange(
						this.deps.wsManager,
						wsRoom.team(teamId),
						'task_comments',
						'INSERT',
						ensured.commentRow,
					);
				}
				if (ensured.approvalRow) {
					broadcastRowChange(
						this.deps.wsManager,
						wsRoom.team(teamId),
						'approvals',
						'INSERT',
						ensured.approvalRow,
					);
				}
			} catch (e) {
				log.error(`Failed to ensure repo setup action for agent ${ref(agentSlug, memberId)}:`, e);
			}

			if (wakeupId) {
				await db.query(
					`UPDATE agent_wakeup_requests
					 SET status = $1::wakeup_status,
					     payload = payload || $2::jsonb
					 WHERE id = $3`,
					[
						WakeupStatus.Deferred,
						JSON.stringify({
							reason: 'awaiting_repo_setup',
							project_id: projectRow.id,
							task_id: task.id,
						}),
						wakeupId,
					],
				);
			}
			log.debug(
				`Agent ${ref(agentSlug, memberId)} deferred on task ${ref(task.identifier, task.id)} — project has no designated repo`,
			);
			return;
		}

		// container_id stays NULL until the container reaches running, so a
		// 'creating' status here means another actor's provisioning is in flight
		// (often minutes on a first image build). Re-queue and retry once it's up
		// rather than holding a global run slot for the wait. Every other
		// no-container state (never provisioned, stopped, errored) falls through —
		// the runner starts or provisions the container on demand at run start.
		if (!projectRow.container_id && projectRow.container_status === ContainerStatus.Creating) {
			log.debug(
				`Container for project ${ref(projectRow.slug, task.project_id)} still provisioning — re-queuing wakeup`,
			);
			await this.requeueWakeup(wakeupId);
			return;
		}

		// Execution locks are observational — multiple agents can run concurrently on the
		// same task. The only acquisition guard is per-agent-per-task: if this agent
		// already holds an active lock on this task, coalesce the wakeup.
		const lockResult = await db.query<{ id: string }>(
			`INSERT INTO execution_locks (task_id, member_id, lock_type)
			 SELECT $1, $2, 'read'
			 WHERE NOT EXISTS (
			   SELECT 1 FROM execution_locks
			   WHERE task_id = $1 AND member_id = $2 AND released_at IS NULL
			 )
			 RETURNING id`,
			[task.id, memberId],
		);

		if (lockResult.rows.length === 0) {
			log.debug(
				`Agent ${ref(agent.rows[0].slug, memberId)} already holds a lock on task ${ref(task.identifier, task.id)} — deferring wakeup`,
			);
			if (wakeupId) {
				await db.query(
					'UPDATE agent_wakeup_requests SET status = $1::wakeup_status WHERE id = $2',
					[WakeupStatus.Deferred, wakeupId],
				);
			}
			return;
		}

		await db.query(
			'UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2',
			[AgentRuntimeStatus.Active, memberId],
		);
		broadcastRowChange(this.deps.wsManager, wsRoom.team(teamId), 'member_agents', 'UPDATE', {
			id: memberId,
			runtime_status: AgentRuntimeStatus.Active,
		});

		log.debug(
			`Launching agent ${ref(agentSlug, memberId)} for task ${ref(task.identifier, task.id)}`,
		);

		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort,
			dataDir: this.deps.dataDir,
			wsManager: this.deps.wsManager,
			events: this.deps.events,
			logs: this.deps.logs,
			sshAgentServer: this.deps.sshAgentServer,
			egressProxy: this.deps.egressProxy ?? null,
			egressCAPath: this.deps.egressCAPath ?? null,
			containerLogStreamer: this.deps.containerLogStreamer,
			pricing: this.deps.pricing,
		};
		const timeoutMs = agent.rows[0].run_timeout_min * 60 * 1000;

		const projectId = project.rows[0].id;
		const taskKey = `${memberId}:${projectId}`;
		const lockedTaskId = task.id;
		this.activeTaskRuns.add(lockedTaskId);
		this.acquireProjectRun(projectId);
		// A dispatch with no spare container will create one — hold a pending-start
		// slot so the memory budget counts it during the window before the new
		// member reaches the DB. Released with the dispatch guards when the run
		// settles.
		//
		// Read from the capacity verdict computed above, not from
		// `projects.container_status`. Those answered the same question only while
		// a project had exactly one container: with a pool, a project whose named
		// container reads Running but whose members are all busy still needs a new
		// one, so the old test held no slot for a container it was about to create
		// and two such dispatches could fit themselves into the same headroom.
		const pendingContainerStart = !capacity.hasSpareContainer;
		if (pendingContainerStart) this.acquirePendingContainerStart(projectId);

		const launched = this.launchTask(
			taskKey,
			async (signal) => {
				let registeredRunId: string | undefined;
				try {
					const result = await runAgent(
						deps,
						{
							id: memberId,
							title: agent.rows[0].title,
							slug: agent.rows[0].slug,
							team_id: teamId,
							default_effort: agent.rows[0].default_effort,
							model_override_provider: agent.rows[0].model_override_provider,
							model_override_model: agent.rows[0].model_override_model,
						},
						task,
						project.rows[0],
						wakeupPayload,
						signal,
						(runId) => {
							registeredRunId = runId;
							this.registerLiveRun({
								runId,
								memberId,
								taskId: task.id,
								projectId,
								teamId,
								taskKey,
								containerId: null,
							});
							return (containerId) => this.attachLiveRunContainer(runId, containerId);
						},
						wakeupId,
					);

					if (registeredRunId) this.unregisterLiveRun(registeredRunId);
					await this.onAgentComplete(
						memberId,
						agent.rows[0].slug,
						task.id,
						task.identifier,
						teamId,
						wakeupId,
						wakeupPayload,
						result,
					);
					return result;
				} catch (err) {
					// Background run errors must not become unhandled rejections — they
					// most commonly fire when a test or shutdown closes the DB while a
					// run is still cleaning up. Log and swallow.
					log.error(
						`Background run for agent ${ref(agent.rows[0].slug, memberId)} on task ${ref(task.identifier, task.id)} failed:`,
						err,
					);
					if (registeredRunId) this.unregisterLiveRun(registeredRunId);
					// Settle the row *before* the bookkeeping below, which reads it.
					// `postFailurePing` returns early on a non-terminal status, so a run
					// that threw past its own finalizer used to notify nobody at all.
					if (registeredRunId) await this.finalizeThrownRun(registeredRunId, err);
					// The completion bookkeeping (lock release, idle flip, wakeup
					// resolution) must still run or the agent stays stuck busy with
					// no recovery path. Synthesize a failed result; the failure-ping
					// path reads the run row's real status so this never misreports.
					try {
						await this.onAgentComplete(
							memberId,
							agent.rows[0].slug,
							task.id,
							task.identifier,
							teamId,
							wakeupId,
							wakeupPayload,
							{
								success: false,
								exitCode: -1,
								stderr: err instanceof Error ? err.message : String(err),
								durationMs: 0,
								heartbeatRunId: registeredRunId,
							},
						);
					} catch (completeErr) {
						log.error(
							`Completion bookkeeping after failed run for agent ${ref(agent.rows[0].slug, memberId)} failed:`,
							completeErr,
						);
					}
					return null;
				} finally {
					// Dispatch guards (activeTaskRuns / activeProjectRuns) are
					// released by launchTask's settle handler via runContext.
					void trackBackground(this.guarded('wakeups', () => this.processWakeups()));
				}
			},
			timeoutMs,
			{ memberId, taskId: lockedTaskId, projectId, pendingContainerStart },
		);

		if (!launched) {
			// A concurrent dispatch already holds this agent's per-project run slot,
			// so the launch was dropped. Undo the lock and status side-effects so the
			// task badge doesn't stick, and re-queue for a later slot.
			this.activeTaskRuns.delete(lockedTaskId);
			this.releaseProjectRun(projectId);
			if (pendingContainerStart) this.releasePendingContainerStart(projectId);
			await db.query(
				'UPDATE execution_locks SET released_at = now() WHERE task_id = $1 AND member_id = $2 AND released_at IS NULL',
				[lockedTaskId, memberId],
			);
			await setAgentIdleIfNoActiveRuns(db, memberId, teamId, undefined, this.deps.wsManager);
			await this.requeueWakeup(wakeupId);
			return;
		}

		// A run reads the full task context at boot, so any wakeup already queued
		// for this agent+task is served by this run. Retire those siblings so they
		// don't fire a redundant back-to-back run once the task frees up. Wakeups
		// created later (new comments/assignments during the run) stay queued and
		// correctly drive a follow-up run.
		const absorbed = await absorbQueuedTaskWakeups(db, memberId, lockedTaskId, wakeupId);
		if (absorbed.length > 0) {
			const refreshed = await db.query<Record<string, unknown>>(
				'SELECT * FROM tasks WHERE id = $1',
				[lockedTaskId],
			);
			if (refreshed.rows[0]) {
				broadcastRowChange(
					this.deps.wsManager,
					wsRoom.team(teamId),
					'tasks',
					'UPDATE',
					refreshed.rows[0],
				);
			}
		}
	}

	private async onAgentComplete(
		memberId: string,
		agentSlug: string,
		taskId: string,
		taskIdentifier: string,
		teamId: string,
		wakeupId: string | undefined,
		// Part of the completion contract (callers pass the wakeup payload); the
		// Coach no longer auto-closes on `task_done`, so it is currently unused.
		_wakeupPayload: Record<string, unknown> | undefined,
		result: RunResult,
	): Promise<void> {
		const { db } = this.deps;

		log.debug(
			`Agent ${ref(agentSlug, memberId)} completed: success=${result.success}, exit=${result.exitCode}, duration=${result.durationMs}ms`,
		);

		await db.query(
			'UPDATE execution_locks SET released_at = now() WHERE task_id = $1 AND member_id = $2 AND released_at IS NULL',
			[taskId, memberId],
		);

		await setAgentIdleIfNoActiveRuns(
			db,
			memberId,
			teamId,
			result.heartbeatRunId,
			this.deps.wsManager,
		);

		if (
			await this.settleWakeupForRun(wakeupId, result, {
				taskId,
				teamId,
				agentSlug,
			})
		) {
			return;
		}

		// A run cut off by its wall-clock time limit is not a failure. Queue a same-task
		// continuation so the agent resumes it (committed work is already pushed) and skip the
		// failure ping + next-task chain, which would mislead or compete with the resume. Only
		// once the task keeps timing out (the cap) do we fall through to the failure path.
		if (result.timedOut) {
			if (await this.queueTimeoutContinuation(memberId, taskId, teamId)) return;
		}

		if (!result.success && result.heartbeatRunId) {
			await this.postFailurePing(
				memberId,
				agentSlug,
				taskId,
				taskIdentifier,
				teamId,
				result.heartbeatRunId,
				result.stderr?.trim() || null,
			);
		}

		// The Coach reviews a `done` ticket for prompt-learning but no longer
		// changes its status — `done` is now the final completed state (there is
		// no `closed`), so the task stays `done` after the Coach run.

		await this.chainNextTaskWakeup(memberId, agentSlug, taskId, teamId);
	}

	/**
	 * After a run hit its wall-clock time limit, queue a same-task continuation so the agent
	 * picks the task back up on the next wakeup pass (committed work is already pushed by the
	 * per-commit auto-push hook, so nothing is lost). The `launchTask` finally already kicks
	 * `processWakeups`, which dispatches this once the task releases. Returns false — declining
	 * to queue — once the task has hit `MAX_CONSECUTIVE_TIMEOUT_CONTINUATIONS` timeouts in a
	 * row, so a task that never fits its run window can't re-queue forever; a non-timeout run in
	 * between resets the streak. The current run's row is already `timed_out` here, so it counts.
	 */
	private async queueTimeoutContinuation(
		memberId: string,
		taskId: string,
		teamId: string,
	): Promise<boolean> {
		const { db } = this.deps;
		const recent = await db.query<{ status: HeartbeatRunStatus }>(
			`SELECT status FROM heartbeat_runs
			 WHERE member_id = $1 AND task_id = $2
			 ORDER BY started_at DESC NULLS LAST
			 LIMIT $3`,
			[memberId, taskId, MAX_CONSECUTIVE_TIMEOUT_CONTINUATIONS],
		);
		if (
			recent.rows.length >= MAX_CONSECUTIVE_TIMEOUT_CONTINUATIONS &&
			recent.rows.every((r) => r.status === HeartbeatRunStatus.TimedOut)
		) {
			log.warn(
				`Not queuing timeout continuation for member ${memberId} on task ${taskId}: ${MAX_CONSECUTIVE_TIMEOUT_CONTINUATIONS} consecutive timeouts`,
			);
			return false;
		}
		try {
			await createWakeup(db, memberId, teamId, WakeupSource.Timer, {
				task_id: taskId,
				reason: 'timeout_continuation',
			});
			return true;
		} catch (e) {
			log.error(
				`Failed to queue timeout continuation for member ${memberId} on task ${taskId}:`,
				e,
			);
			return false;
		}
	}

	/**
	 * If the Captain has goals due for a check, launch one progress-update run (no task) covering
	 * all of them, and refreshes the project's progress summary either way. Returns
	 * `{ dispatched: true }` so the scheduled caller yields this activation; returns
	 * `{ dispatched: false, reason }` when nothing is due or the run can't start right now (the
	 * scheduled caller then falls through to normal task selection and the work stays due for the
	 * next heartbeat). Shared by the scheduled heartbeat and the manual `dispatchProgressUpdateNow`
	 * ("Run now") path, which passes `manual` to bypass the due-check.
	 */
	/**
	 * Is the project's progress summary stale enough to rebuild, independently of goals?
	 *
	 * Two conditions, both required. **Stale**: the anchor is older than
	 * `PROGRESS_REFRESH_INTERVAL_HOURS`. **Active**: a task has moved since that anchor. The
	 * activity half keeps this off dormant projects — without it a quiet project would burn a
	 * Captain run every day rewriting an identical summary.
	 *
	 * The anchor is the later of two timestamps, falling back to the project's creation:
	 *
	 * - `progress_summary_updated_at` — when the page was last actually written.
	 * - the last progress-update **run**, even one that wrote nothing. This is what makes the
	 *   cadence about how often we *run* rather than how often the write succeeds: without it, a
	 *   run that ended without calling `update_project_progress` would leave the page stale and
	 *   the condition true, so the next heartbeat would dispatch again, and again — a hot loop
	 *   costing a Captain run every few seconds.
	 * - `projects.created_at` is the fallback when neither exists, so a brand-new project isn't
	 *   immediately "overdue": on day one the anchor is "now", the Captain gets on with its
	 *   planning task, and the progress summary arrives once there is something to report. It is a
	 *   fallback rather than a third `GREATEST` argument on purpose — a recently-created project
	 *   whose page is genuinely stale must still be due.
	 *
	 * `GREATEST` ignores nulls, so a project with only one of the two still anchors on it.
	 */
	private async isProgressSnapshotDue(projectId: string): Promise<boolean> {
		const r = await this.deps.db.query<{ due: boolean }>(
			`SELECT (
			   anchor < now() - ($3 || ' hours')::interval
			   AND EXISTS (
			     SELECT 1 FROM tasks t WHERE t.project_id = p.id AND t.updated_at > anchor
			   )
			 ) AS due
			 FROM projects p,
			      LATERAL (
			        SELECT COALESCE(
			          GREATEST(
			            p.progress_summary_updated_at,
			            (SELECT max(COALESCE(hr.started_at, hr.created_at))
			               FROM heartbeat_runs hr
			              WHERE hr.team_id = p.team_id
			                AND hr.task_id IS NULL
			                AND hr.kind = $2)
			          ),
			          p.created_at
			        ) AS anchor
			      ) a
			 WHERE p.id = $1`,
			[projectId, HeartbeatRunKind.ProgressUpdate, String(PROGRESS_REFRESH_INTERVAL_HOURS)],
		);
		return r.rows[0]?.due ?? false;
	}

	private async tryDispatchProgressUpdate(
		memberId: string,
		teamId: string,
		agentRow: {
			id: string;
			title: string;
			slug: string;
			default_effort: string;
			model_override_provider: AiProvider | null;
			model_override_model: string | null;
			run_timeout_min: number;
		},
		wakeupId: string | undefined,
		wakeupPayload: Record<string, unknown>,
		manual = false,
	): Promise<TryProgressUpdateResult> {
		const { db, docker, masterKeyManager, serverPort } = this.deps;

		// The Captain's project is its team's single non-internal project - unless it
		// has been archived, in which case the Captain has no project to report on
		// and a progress run would only ask for a container it cannot have.
		const project = await db.query<{
			id: string;
			slug: string;
			team_id: string;
			team_slug: string;
			container_id: string | null;
			container_status: string;
			designated_repo_id: string | null;
			is_internal: boolean;
		}>(
			`SELECT p.id, p.slug, p.team_id, c.slug AS team_slug,
			        p.container_id, p.container_status, p.designated_repo_id, p.is_internal
			 FROM projects p JOIN teams c ON c.id = p.team_id
			 WHERE p.team_id = $1 AND p.is_internal = false AND p.archived_at IS NULL
			 LIMIT 1`,
			[teamId],
		);
		const projectRow = project.rows[0];
		if (!projectRow) return { dispatched: false, reason: 'no_project' };

		// Goals are not a dependency of progress. A run is due when a goal is due (the goals get
		// assessed) OR when the progress summary itself has gone stale with work having happened
		// since — so a project that has never set a goal still gets a maintained summary.
		// `manual` ("Run now") skips the check entirely: a human pressing the button is explicit
		// intent, not a cadence.
		const dueGoals = await getDueGoals(db, projectRow.id);
		if (!manual && dueGoals.length === 0 && !(await this.isProgressSnapshotDue(projectRow.id))) {
			return { dispatched: false, reason: 'not_due' };
		}

		// Don't start a progress update while the Captain is already running in this
		// project, the instance is at its global run capacity, or the Captain/project
		// is over budget. The scheduled caller falls through — the run stays due
		// for the next heartbeat. A stopped container is no blocker: the runner
		// lazy-starts it.
		if (await this.isAgentBusyInProject(memberId, projectRow.id)) {
			return { dispatched: false, reason: 'agent_busy' };
		}
		if ((await this.isContainerCapacityBlocked(projectRow.id)).blocked) {
			return { dispatched: false, reason: 'instance_at_capacity' };
		}
		if (await checkOverBudget(db, memberId, projectRow.id)) {
			return { dispatched: false, reason: 'over_budget' };
		}

		const progressUpdate: ProgressUpdateContext = {
			// The deterministic half of the progress summary: recency, the progress-run exclusion and
			// the close-time inference all resolved in SQL, handed over as candidates the Captain
			// picks from and writes prose for.
			activityCandidates: await buildProgressActivityCandidates(db, projectRow.id, teamId),
			goals: dueGoals.map((g) => ({
				id: g.id as string,
				title: g.title as string,
				measurement: (g.measurement as string) ?? '',
				actions: (g.actions as string) ?? '',
				progress_percent: (g.progress_percent as number) ?? 0,
				health: (g.health as string) ?? 'pending',
				status_blurb: (g.status_blurb as string) ?? '',
				check_frequency: (g.check_frequency as string) ?? 'daily',
				target_date: (g.target_date as string | null) ?? null,
			})),
		};

		const runProject = { ...projectRow, container_id: projectRow.container_id };

		await db.query(
			'UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2',
			[AgentRuntimeStatus.Active, memberId],
		);
		broadcastRowChange(this.deps.wsManager, wsRoom.team(teamId), 'member_agents', 'UPDATE', {
			id: memberId,
			runtime_status: AgentRuntimeStatus.Active,
		});

		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort,
			dataDir: this.deps.dataDir,
			wsManager: this.deps.wsManager,
			events: this.deps.events,
			logs: this.deps.logs,
			sshAgentServer: this.deps.sshAgentServer,
			egressProxy: this.deps.egressProxy ?? null,
			egressCAPath: this.deps.egressCAPath ?? null,
			containerLogStreamer: this.deps.containerLogStreamer,
			pricing: this.deps.pricing,
		};
		const timeoutMs = agentRow.run_timeout_min * 60 * 1000;
		const key = `progressupdate:${memberId}:${projectRow.id}`;
		this.acquireProjectRun(projectRow.id);
		// Same pending-start accounting as activateAgent: a progress-update run
		// into a stopped project lazy-starts its container.
		const pendingContainerStart = projectRow.container_status !== ContainerStatus.Running;
		if (pendingContainerStart) this.acquirePendingContainerStart(projectRow.id);

		const launched = this.launchTask(
			key,
			async (signal) => {
				let registeredRunId: string | undefined;
				try {
					const result = await runAgent(
						deps,
						{
							id: memberId,
							title: agentRow.title,
							slug: agentRow.slug,
							team_id: teamId,
							default_effort: agentRow.default_effort,
							model_override_provider: agentRow.model_override_provider,
							model_override_model: agentRow.model_override_model,
						},
						null,
						runProject,
						wakeupPayload,
						signal,
						(runId) => {
							registeredRunId = runId;
							this.registerLiveRun({
								runId,
								memberId,
								taskId: null,
								projectId: projectRow.id,
								teamId,
								taskKey: key,
								containerId: null,
							});
							return (containerId) => this.attachLiveRunContainer(runId, containerId);
						},
						wakeupId,
						progressUpdate,
					);
					if (registeredRunId) this.unregisterLiveRun(registeredRunId);
					await this.onProgressUpdateComplete(memberId, teamId, wakeupId, result);
					return result;
				} catch (err) {
					log.error(
						`Background progress-update run for Captain ${ref('captain', memberId)} failed:`,
						err,
					);
					if (registeredRunId) this.unregisterLiveRun(registeredRunId);
					// Before the completion bookkeeping, which reads the row.
					if (registeredRunId) await this.finalizeThrownRun(registeredRunId, err);
					await this.onProgressUpdateComplete(memberId, teamId, wakeupId, {
						success: false,
						exitCode: -1,
						stderr: err instanceof Error ? err.message : String(err),
						durationMs: 0,
						heartbeatRunId: registeredRunId,
					}).catch((e) => log.error('Progress-update completion bookkeeping failed:', e));
					return null;
				} finally {
					this.releaseProjectRun(projectRow.id);
					if (pendingContainerStart) this.releasePendingContainerStart(projectRow.id);
					void trackBackground(this.guarded('wakeups', () => this.processWakeups()));
				}
			},
			timeoutMs,
		);

		if (!launched) {
			// A concurrent dispatch holds this key; undo the status flip and re-queue. On the
			// scheduled path the requeued wakeup retries; on the manual path wakeupId is undefined
			// so requeueWakeup no-ops and the caller surfaces the conflict.
			this.releaseProjectRun(projectRow.id);
			if (pendingContainerStart) this.releasePendingContainerStart(projectRow.id);
			await setAgentIdleIfNoActiveRuns(db, memberId, teamId, undefined, this.deps.wsManager);
			await this.requeueWakeup(wakeupId);
			return { dispatched: false, reason: 'launch_conflict' };
		}
		return { dispatched: true };
	}

	/** Trimmed completion bookkeeping for a progress-update run: no task lock, badge, or chain. */
	private async onProgressUpdateComplete(
		memberId: string,
		teamId: string,
		wakeupId: string | undefined,
		result: RunResult,
	): Promise<void> {
		const { db } = this.deps;
		await setAgentIdleIfNoActiveRuns(
			db,
			memberId,
			teamId,
			result.heartbeatRunId,
			this.deps.wsManager,
		);
		// No task and no roster slug to name: a progress-update run's handback is
		// recorded on its own row, and the abandoned notice has no thread to land in.
		await this.settleWakeupForRun(wakeupId, result, { taskId: null, teamId, agentSlug: null });
	}

	/**
	 * Settle a wakeup now its run has finished, and say whether the caller should
	 * stop.
	 *
	 * A run that handed its work back - the instance was at its container-memory
	 * budget, or another run still held the rotating provider credential - is
	 * **not** a failure. The dispatcher's own gates test for exactly those states,
	 * and a moment later they may not hold. So the wakeup goes back to `queued`
	 * and `true` stops the caller before the failure ping and the next-task chain,
	 * neither of which should fire for a scheduling race. Every other outcome is
	 * terminal.
	 *
	 * A thin mapping over the shared seam (`services/wakeup.ts`): this method owns
	 * the `RunResult` vocabulary, `settleWakeupForRun` owns the writes. Keeping the
	 * mapping here is what lets both this path and the orphan sweeper share one
	 * handback, rather than each maintaining its own.
	 */
	private async settleWakeupForRun(
		wakeupId: string | undefined,
		result: {
			success: boolean;
			requeued?: boolean;
			requeueReason?: WakeupSkipReason;
			heartbeatRunId?: string;
		},
		/** Where to record the outcome. Omitted only where there is no run row to write. */
		run?: { taskId: string | null; teamId: string; agentSlug: string | null },
	): Promise<boolean> {
		const intent: SettlementIntent = result.requeued
			? // The runner names the wait it gave up on; capacity is only the default
				// for a caller that predates the distinction.
				{ kind: 'handback', reason: result.requeueReason ?? WakeupSkipReason.InstanceAtCapacity }
			: result.success
				? { kind: 'complete' }
				: { kind: 'fail' };
		const settled = await settleWakeupForRun(this.deps.db, wakeupId, intent);

		// A handback's run row may not assert an outcome until there is one. The
		// runner finalized it `Cancelled` saying it was returning to the queue; only
		// here is it known whether that happened, so only here is it recorded -
		// through the same recorder the orphan sweeper uses, so the two cannot say
		// different things about the same event.
		if (intent.kind === 'handback' && result.heartbeatRunId && run) {
			const requeued = settled.kind === 'requeued';
			if (!requeued) {
				log.warn(
					`Wakeup ${wakeupId} could not be handed back (already settled) - run ${result.heartbeatRunId} is abandoned and needs a human`,
				);
			}
			await recordHandbackOutcome(
				this.deps.db,
				{
					runId: result.heartbeatRunId,
					taskId: run.taskId,
					teamId: run.teamId,
					agentSlug: run.agentSlug,
					terminalStatus: HeartbeatRunStatus.Cancelled,
				},
				requeued ? 'requeued' : 'abandoned',
				undefined,
				this.deps.wsManager,
			);
		}

		// `false` on a failed handback so the caller stops treating this as a
		// scheduling race: nothing is carrying the work, and the row now says so.
		return settled.kind === 'requeued';
	}

	/**
	 * Manually trigger the Captain's progress-update run for a project on demand (the progress summary
	 * "Run now" button). Reuses the scheduled logic (`tryDispatchProgressUpdate` → goal selection,
	 * gating and launch) so a manual run is identical to a heartbeat-scheduled one, except that it
	 * passes `manual` to skip the due-check: pressing the button always runs, whether or not the
	 * project has goals and whether or not the page is stale. No wakeup id is passed: `runAgent`
	 * synthesises an on-demand wakeup, so there is no queued row for the 5s cron to double-dispatch.
	 * Returns the discriminated result the route maps to HTTP.
	 */
	async dispatchProgressUpdateNow(
		projectId: string,
		triggeredBy?: { member_id: string; name: string } | null,
	): Promise<ProgressUpdateDispatchResult> {
		const { db } = this.deps;

		const proj = await db.query<{ team_id: string }>('SELECT team_id FROM projects WHERE id = $1', [
			projectId,
		]);
		const teamId = proj.rows[0]?.team_id;
		if (!teamId) return { dispatched: false, reason: 'no_project' };

		// Resolve the project team's Captain — the only role that runs progress updates.
		const captain = await db.query<{
			id: string;
			title: string;
			slug: string;
			admin_status: string;
			default_effort: string;
			model_override_provider: AiProvider | null;
			model_override_model: string | null;
			run_timeout_min: number;
		}>(
			`SELECT ma.id, ma.title, ma.slug, ma.admin_status, ma.default_effort,
			        ma.run_timeout_min, ma.model_override_provider, ma.model_override_model
			 FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = $2
			 LIMIT 1`,
			[teamId, CAPTAIN_AGENT_SLUG],
		);
		const captainRow = captain.rows[0];
		if (!captainRow) return { dispatched: false, reason: 'no_captain' };
		if (captainRow.admin_status !== AgentAdminStatus.Enabled) {
			return { dispatched: false, reason: 'captain_disabled' };
		}

		// First attempt is synchronous: when the Captain is free this launches
		// immediately (run card appears at once), exactly as before.
		const result = await this.tryDispatchProgressUpdate(
			captainRow.id,
			teamId,
			{
				id: captainRow.id,
				title: captainRow.title,
				slug: captainRow.slug,
				default_effort: captainRow.default_effort,
				model_override_provider: captainRow.model_override_provider,
				model_override_model: captainRow.model_override_model,
				run_timeout_min: captainRow.run_timeout_min,
			},
			undefined,
			{
				source: WakeupSource.OnDemand,
				trigger: 'progress_update_now',
				...(triggeredBy ? { triggered_by: triggeredBy } : {}),
			},
			true, // manual: the button is explicit intent, so skip the due-check entirely
		);

		// A transient conflict (Captain already running, the instance at its global
		// run capacity, or a launch race) is queued rather than surfaced as an
		// error: the 5s dispatcher retries the wakeup and the run fires once the
		// Captain frees up. Terminal reasons (no project/captain, disabled, over
		// budget) fall through unchanged.
		if (
			!result.dispatched &&
			(result.reason === 'agent_busy' ||
				result.reason === 'instance_at_capacity' ||
				result.reason === 'launch_conflict')
		) {
			const projRow = await db.query<{ id: string }>(
				'SELECT id FROM projects WHERE team_id = $1 AND is_internal = false LIMIT 1',
				[teamId],
			);
			const projectRowId = projRow.rows[0]?.id;
			// Guarded by tryDispatchProgressUpdate already resolving the project, but
			// stay defensive: without a project id we can't queue, so surface the reason.
			if (projectRowId) {
				const wakeupId = await createProgressUpdateWakeup(
					db,
					captainRow.id,
					teamId,
					projectRowId,
					WakeupSource.OnDemand,
					triggeredBy,
				);
				broadcastRowChange(
					this.deps.wsManager,
					wsRoom.team(teamId),
					'agent_wakeup_requests',
					'INSERT',
					{
						id: wakeupId,
						team_id: teamId,
						project_id: projectRowId,
						member_id: captainRow.id,
						status: WakeupStatus.Queued,
					},
				);
				return { queued: true, wakeupId };
			}
		}

		return result;
	}

	private async postFailurePing(
		memberId: string,
		agentSlug: string,
		taskId: string,
		taskIdentifier: string,
		teamId: string,
		runId: string,
		/** What the caller knows went wrong, for a row that recorded nothing. */
		fallbackError: string | null = null,
	): Promise<void> {
		const { db } = this.deps;

		const runRow = await db.query<{ status: HeartbeatRunStatus; error: string | null }>(
			'SELECT status, error FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		const run = runRow.rows[0];
		if (!run) return;
		// An explicit no-ping list rather than a terminal-status gate. A cancel is
		// the user's own doing and a success has nothing to report; those are the
		// only two outcomes that must never ping. Everything else reaching here has
		// already been judged a failure by the caller - and gating on *terminal*
		// meant a run whose driver threw before finalizing it silenced the thread
		// entirely, which is the case this whole area exists to report.
		if (NON_PINGING_STATUSES.includes(run.status)) return;
		const status = FAILURE_TERMINAL_STATUSES.includes(run.status)
			? run.status
			: HeartbeatRunStatus.Failed;

		const recent = await db.query<{ status: HeartbeatRunStatus }>(
			`SELECT status FROM heartbeat_runs
			 WHERE member_id = $1 AND task_id = $2 AND status IN ($3::heartbeat_run_status, $4::heartbeat_run_status, $5::heartbeat_run_status)
			 ORDER BY started_at DESC NULLS LAST
			 LIMIT $6`,
			[
				memberId,
				taskId,
				HeartbeatRunStatus.Succeeded,
				HeartbeatRunStatus.Failed,
				HeartbeatRunStatus.TimedOut,
				MAX_CONSECUTIVE_FAILURE_PINGS,
			],
		);
		const streak = recent.rows.every((r) => FAILURE_TERMINAL_STATUSES.includes(r.status));
		if (recent.rows.length >= MAX_CONSECUTIVE_FAILURE_PINGS && streak) {
			log.warn(
				`Suppressing failure ping for agent ${ref(agentSlug, memberId)} on task ${ref(taskIdentifier, taskId)}: ${MAX_CONSECUTIVE_FAILURE_PINGS} consecutive failed runs`,
			);
			return;
		}

		const rawError = run.error ?? fallbackError;
		const truncatedError = rawError
			? rawError.length > FAILURE_PING_ERROR_MAX_LEN
				? `${rawError.slice(0, FAILURE_PING_ERROR_MAX_LEN)}…`
				: rawError
			: null;

		const inserted = await db.query<Record<string, unknown>>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, NULL, $2::comment_content_type, $3::jsonb)
			 RETURNING *`,
			[
				taskId,
				CommentContentType.System,
				JSON.stringify({
					kind: 'run_failed',
					run_id: runId,
					status,
					error: truncatedError,
					member_id: memberId,
					agent_slug: agentSlug,
				}),
			],
		);
		const commentRow = inserted.rows[0];
		if (!commentRow) return;

		broadcastRowChange(
			this.deps.wsManager,
			wsRoom.team(teamId),
			'task_comments',
			'INSERT',
			commentRow,
		);
	}

	/**
	 * Last resort: leave no run row non-terminal after a throw.
	 *
	 * `runAgent` finalizes its own row on every path it knows about. This covers
	 * the ones it does not - a throw in the plumbing between the row's insert and
	 * its first `try`, a failure inside a catch's own bookkeeping - and it covers
	 * whatever is added there next, which is what makes the property permanent
	 * rather than a description of today's call graph.
	 *
	 * It matters because everything downstream reads the row rather than the
	 * thrown error: `postFailurePing` returns early on a non-terminal status, so
	 * the task thread stayed silent, and the orphan pass then declared the process
	 * lost when the process was alive and had thrown.
	 *
	 * Status-guarded, so a row the runner did finalize keeps its own richer
	 * verdict; this only ever writes when nothing else did. No usage is passed, so
	 * it cannot touch cost accounting.
	 */
	private async finalizeThrownRun(runId: string, err: unknown): Promise<void> {
		const message = err instanceof Error ? err.message : String(err);
		await this.deps.db
			.query(
				`UPDATE heartbeat_runs
				 SET status = $1::heartbeat_run_status,
				     started_at = COALESCE(started_at, now()),
				     finished_at = now(),
				     exit_code = COALESCE(exit_code, -1),
				     error = COALESCE(error, $2)
				 WHERE id = $3
				   AND status IN ($4::heartbeat_run_status, $5::heartbeat_run_status)`,
				[
					HeartbeatRunStatus.Failed,
					message,
					runId,
					HeartbeatRunStatus.Queued,
					HeartbeatRunStatus.Running,
				],
			)
			.catch((e) => log.error(`Could not finalize thrown run ${runId}:`, e));
	}

	private async chainNextTaskWakeup(
		memberId: string,
		agentSlug: string,
		justCompletedTaskId: string,
		teamId: string,
	): Promise<void> {
		const { db } = this.deps;
		// Pick the next non-terminal task for this agent that we aren't already
		// covering: skip the just-completed task, anything the agent has an active
		// run on (concurrent parallel runs), anything that already has a
		// queued/claimed wakeup for this agent, and anything this agent already
		// successfully ran within its effective heartbeat interval. The
		// recent-success clause matches the cadence the heartbeat scheduler
		// considers "due"; without it, an agent with multiple parked-on-input
		// tasks (e.g. an Architect waiting on @admin approval on two specs)
		// ping-pongs between them every few seconds since each completion
		// re-selects the other parked task. Conversational triggers (mentions,
		// replies, comments, dependency unblocks) ride their own wakeup sources,
		// not this chain, so cooling the chain doesn't delay legitimate work.
		// Instance agents (CEO/Coach) chain across every team; everyone else stays
		// scoped to the just-completed task's team. Build params positionally so the
		// team filter is only present when its placeholder is.
		const agentRow = await db.query<{ heartbeat_interval_min: number }>(
			'SELECT heartbeat_interval_min FROM member_agents WHERE id = $1',
			[memberId],
		);
		const chainCooldownMin = Math.max(
			agentRow.rows[0]?.heartbeat_interval_min ?? heartbeatIntervalFloorMin(),
			heartbeatIntervalFloorMin(),
		);
		const isInstanceAgent = (INSTANCE_AGENT_SLUGS as readonly string[]).includes(agentSlug);
		const params: unknown[] = [memberId];
		let teamClause = '';
		if (!isInstanceAgent) {
			params.push(teamId);
			teamClause = ` AND i.team_id = $${params.length}`;
		}
		params.push(justCompletedTaskId);
		const selfIdx = params.length;
		const ts = params.length + 1;
		params.push(...TERMINAL_TASK_STATUSES);
		const term = TERMINAL_TASK_STATUSES.map((_, i) => `$${ts + i}::task_status`).join(', ');
		const pr = params.length + 1;
		params.push(TaskPriority.Urgent, TaskPriority.High, TaskPriority.Medium, TaskPriority.Low);
		const hr = params.length + 1;
		params.push(HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running);
		const wu = params.length + 1;
		params.push(WakeupStatus.Queued, WakeupStatus.Claimed);
		const succ = params.length + 1;
		params.push(HeartbeatRunStatus.Succeeded);
		const cd = params.length + 1;
		params.push(chainCooldownMin);
		const next = await db.query<{ id: string }>(
			`SELECT i.id FROM tasks i
			 WHERE i.assignee_id = $1${teamClause} AND i.id != $${selfIdx}
			   AND i.status NOT IN (${term})
			   AND NOT EXISTS (
			     SELECT 1 FROM task_dependencies d
			     JOIN tasks b ON b.id = d.blocked_by_task_id
			     WHERE d.task_id = i.id
			       AND b.status NOT IN (${term})
			   )
			   AND NOT EXISTS (
			     SELECT 1 FROM heartbeat_runs hr
			     WHERE hr.task_id = i.id AND hr.member_id = $1
			       AND hr.status IN ($${hr}::heartbeat_run_status, $${hr + 1}::heartbeat_run_status)
			   )
			   AND NOT EXISTS (
			     SELECT 1 FROM agent_wakeup_requests w
			     WHERE w.member_id = $1
			       AND w.status IN ($${wu}::wakeup_status, $${wu + 1}::wakeup_status)
			       AND w.payload->>'task_id' = i.id::text
			   )
			   AND NOT EXISTS (
			     SELECT 1 FROM heartbeat_runs hr
			     WHERE hr.task_id = i.id AND hr.member_id = $1
			       AND hr.status = $${succ}::heartbeat_run_status
			       AND hr.finished_at IS NOT NULL
			       AND hr.finished_at > now() - ($${cd}::int || ' minutes')::interval
			   )
			 ORDER BY
			   CASE i.priority WHEN $${pr} THEN 0 WHEN $${pr + 1} THEN 1 WHEN $${pr + 2} THEN 2 WHEN $${pr + 3} THEN 3 END,
			   i.created_at ASC
			 LIMIT 1`,
			params,
		);
		if (next.rows.length === 0) return;

		try {
			await createWakeup(db, memberId, teamId, WakeupSource.Timer, {
				task_id: next.rows[0].id,
				reason: 'chain_after_completion',
			});
		} catch (e) {
			log.error(`Failed to chain wakeup for agent ${ref(agentSlug, memberId)}:`, e);
		}
	}

	private async detectOrphanedRuns(): Promise<void> {
		await detectOrphans(this.deps.db, this.getLiveRunIds(), this.deps.wsManager, {
			killProcesses: (containerId, runId) => this.deps.docker.killRunProcesses(containerId, runId),
		});
		await this.sweepStaleDispatches();
		await healStaleRunState(this.deps.db, this.deps.wsManager);
	}

	/**
	 * Release in-memory dispatch state for runs whose row went terminal but
	 * whose completion path never settled (e.g. a wedged teardown). Without
	 * this, the launchTask key, activeTaskRuns entry, and activeProjectRuns
	 * refcount leak forever and the agent can never be dispatched again. The
	 * DB-side counterpart is `healStaleRunState`.
	 */
	private async sweepStaleDispatches(): Promise<void> {
		const { db } = this.deps;
		const now = Date.now();
		for (const [key, entry] of [...this.runningTasks]) {
			const ctx = entry.runContext;
			if (!ctx || entry.reaped) continue;
			if (now - entry.startedAt < STALE_STATE_GRACE_SECONDS * 1000) continue;
			const active = await db.query(
				`SELECT 1 FROM heartbeat_runs
				 WHERE member_id = $1 AND task_id = $2
				   AND (status IN ($3::heartbeat_run_status, $4::heartbeat_run_status)
				        OR finished_at > now() - ($5 || ' seconds')::interval)
				 LIMIT 1`,
				[
					ctx.memberId,
					ctx.taskId,
					HeartbeatRunStatus.Queued,
					HeartbeatRunStatus.Running,
					String(STALE_STATE_GRACE_SECONDS),
				],
			);
			if (active.rows.length > 0) continue;

			log.warn(`Reaping stale dispatch ${key}: its run is terminal but completion never settled`);
			entry.reaped = true;
			clearTimeout(entry.timeoutId);
			entry.abortController.abort();
			if (this.runningTasks.get(key) === entry) this.runningTasks.delete(key);
			this.releaseRunDispatch(ctx);
			for (const [runId, liveRun] of this.liveRuns) {
				if (liveRun.taskKey === key) this.liveRuns.delete(runId);
			}
		}
	}

	private async syncContainerStatuses(): Promise<void> {
		const reachable = await this.deps.docker.ping();
		if (!reachable) {
			return;
		}

		const deps = this.buildContainerDeps();
		// Two sources, one shape. The status sync answers for the container
		// `projects.container_id` names; the pool reconcile answers for every other
		// member, which that sync cannot see at all. Both emit per-container
		// transitions so a dead container is handled identically whichever noticed
		// it - and, in particular, is never handled project-wide.
		const transitions = await syncAllContainerStatuses(deps);
		const reconciled = await reconcilePoolMembers(deps);

		for (const transition of [...transitions, ...reconciled.transitions]) {
			await this.handleContainerTransition(transition);
		}
	}

	/**
	 * Retire pools idle past {@link CONTAINER_IDLE_TIMEOUT_MIN}, so an instance
	 * with no work runs zero containers. Bounded per tick; each stop re-verifies
	 * the busy predicate under the project's lifecycle lock, so a concurrent
	 * dispatch's lazy start and this stop can never interleave — the in-memory
	 * checks close the window before a dispatched run has any DB row, and
	 * `isProjectIdleForContainerStop` re-runs the DB predicate last.
	 *
	 * The window is a constant rather than a setting, and there is no longer an
	 * always-on escape hatch: a container that never stops is a container that
	 * bills forever on a managed backend, and the dev server it used to keep
	 * alive belongs in something with its own lifecycle.
	 */
	private async stopIdleContainers(): Promise<void> {
		const { db, docker } = this.deps;
		const timeoutMin = CONTAINER_IDLE_TIMEOUT_MIN;
		if (!(await docker.ping())) {
			log.debug('Docker not reachable; skipping idle-container pass');
			return;
		}

		const candidates = await findIdleContainerCandidates(db, timeoutMin, IDLE_STOP_BATCH_LIMIT);
		let stopped = 0;
		for (const candidate of candidates) {
			try {
				await withContainerLifecycleLock(candidate.id, async () => {
					if ((this.activeProjectRuns.get(candidate.id) ?? 0) > 0) return;
					if (this.pendingContainerStarts.has(candidate.id)) return;
					if (this.getLiveRunsForProject(candidate.id).length > 0) return;
					if (!(await isProjectIdleForContainerStop(db, candidate.id, timeoutMin))) return;
					log.info(
						`project ${ref(candidate.slug, candidate.id)} idle for ${timeoutMin}min — retiring its pool`,
					);
					stopped += await this.shutDownIdlePool(candidate);
				});
			} catch (err) {
				log.error(`Idle-stop failed for project ${ref(candidate.slug, candidate.id)}:`, err);
			}
		}
		if (candidates.length > 0) {
			log.debug(`Idle-container pass: ${stopped}/${candidates.length} candidate(s) stopped`);
		}

		// After the whole-project pass, not before: a project that has gone
		// entirely quiet should be retired as a unit, keeping one member suspended
		// for a warm restart, rather than having its members picked off first.
		await this.retireSurplusIdleContainers();
	}

	/**
	 * Retire a project's idle containers: suspend one, destroy the rest.
	 *
	 * A stopped container *is* a suspended one - it still exists, its writable
	 * layer is intact, and starting it resumes in place - so the two arms differ
	 * only in whether the container survives. Keeping **at most one** per project
	 * is exactly the cardinality a single-container project had, and it is what
	 * removes a whole category of work that a retained-container pool would
	 * otherwise need: no retention cap, no reap horizon, no snapshot storage to
	 * watch grow.
	 *
	 * The cost is that the second and later containers of a burst are always
	 * created cold. That is a fetch rather than a clone, only genuinely concurrent
	 * runs pay it, and it buys back a bound nobody has to tune.
	 *
	 * Returns how many containers this actually retired, for the pass's log line.
	 */
	private async shutDownIdlePool(candidate: {
		id: string;
		slug: string;
		team_id: string;
		container_id: string;
	}): Promise<number> {
		const { db } = this.deps;
		const { planIdleShutdown } = await import('./sandbox/pool');
		const { loadPoolMembers } = await import('./sandbox/pool-db');

		const members = await loadPoolMembers(db, candidate.id);
		// A project whose pool has no row yet (nothing has provisioned through the
		// pool since the upgrade) still has exactly one container, which is the
		// single-member case - handle it as one rather than skipping the project.
		const plan =
			members.length > 0
				? planIdleShutdown(members)
				: { suspend: [{ id: candidate.container_id }], destroy: [] };

		return executeRetirementPlan(
			this.buildContainerDeps(),
			{ id: candidate.id, slug: candidate.slug, team_id: candidate.team_id },
			{
				suspend: plan.suspend.map((m) => m.id),
				destroy: plan.destroy.map((m) => m.id),
			},
			{ reason: 'idle', parkSession: (id) => this.parkChatSession(id) },
		);
	}

	/** Best-effort park of any assistant session pinned to a container about to go. */
	private async parkChatSession(containerId: string): Promise<void> {
		await this.deps.chatSessions?.parkForContainerSuspend(containerId);
	}

	/**
	 * Retire idle containers held by projects that are still working.
	 *
	 * {@link stopIdleContainers} only ever looks at projects that have gone
	 * *entirely* quiet, which left the instance's worst capacity failure
	 * unaddressed: a project running two tasks alongside two idle containers is
	 * never quiet, so those two were charged to the memory budget in full and no
	 * other project could reach them. An operator saw four containers, two of them
	 * doing nothing, and every other project stuck at "at its active-container
	 * limit" - not for the idle window, but until that project finished
	 * everything it had.
	 *
	 * Deliberately no keep-one-warm rule, unlike the whole-project pass: this
	 * project's busy containers are about to become idle themselves, so the next
	 * run's warm start is already covered.
	 */
	private async retireSurplusIdleContainers(): Promise<void> {
		const { db, docker } = this.deps;
		const timeoutMin = CONTAINER_IDLE_TIMEOUT_MIN;
		if (!(await docker.ping())) return;

		const { planSurplusIdleRetirement } = await import('./sandbox/pool');
		const { loadPoolMembers } = await import('./sandbox/pool-db');

		const stale = await findStaleIdleMembers(db, timeoutMin, IDLE_STOP_BATCH_LIMIT);
		const byProject = new Map<string, StaleIdleMember[]>();
		for (const row of stale) {
			const group = byProject.get(row.project_id);
			if (group) group.push(row);
			else byProject.set(row.project_id, [row]);
		}

		let retired = 0;
		for (const [projectId, group] of byProject) {
			try {
				await withContainerLifecycleLock(projectId, async () => {
					// A lazy start in flight has no DB row yet, so the members below could
					// be claimed the moment this lock is released. Same guard the
					// whole-project pass uses, and for the same reason.
					if (this.pendingContainerStarts.has(projectId)) return;
					// Re-run the scan under the lock: a member claimed and released again
					// since the batch scan is idle but no longer stale.
					const fresh = await findStaleIdleMembersInProject(db, projectId, timeoutMin);
					const staleIds = new Set(fresh.map((r) => r.container_id));
					if (staleIds.size === 0) return;

					const plan = planSurplusIdleRetirement(await loadPoolMembers(db, projectId), staleIds);
					if (plan.suspend.length === 0 && plan.destroy.length === 0) return;

					retired += await executeRetirementPlan(
						this.buildContainerDeps(),
						{ id: projectId, slug: group[0].slug, team_id: group[0].team_id },
						{
							suspend: plan.suspend.map((m) => m.id),
							destroy: plan.destroy.map((m) => m.id),
						},
						{ reason: 'surplus idle', parkSession: (id) => this.parkChatSession(id) },
					);
				});
			} catch (err) {
				log.error(`Surplus idle retirement failed for project ${ref('', projectId)}:`, err);
			}
		}
		if (retired > 0) {
			log.debug(`Surplus idle pass: retired ${retired} container(s) held by working projects`);
		}
	}

	/**
	 * Destroy containers this instance created that no project references any
	 * more. Boot fails every in-flight run and never reattaches, so a crash, a
	 * hard kill or a lost provider response strands containers with no owner -
	 * harmless on local Docker, but billed for as long as nobody looks on a
	 * managed backend.
	 *
	 * The live set is read from `projects` rather than from the engine, so a
	 * container is only ever destroyed when Hezo itself has forgotten it.
	 */
	/**
	 * `atStartup` skips the wait for a second sighting. See
	 * {@link reconcileOnStartup} for why that is safe there and nowhere else.
	 */
	private async reapOrphanedContainers(opts: { atStartup?: boolean } = {}): Promise<void> {
		const { db, docker } = this.deps;
		if (!(await docker.ping())) {
			log.debug('Container engine not reachable; skipping orphan sweep');
			return;
		}
		const { reapOrphanedContainers } = await import('./sandbox/orphan-reaper');
		const { listReferencedContainerIds } = await import('./sandbox/pool-db');
		const { getOrCreateInstanceId } = await import('./telemetry');
		const result = await reapOrphanedContainers(
			docker,
			await getOrCreateInstanceId(db, this.deps.dataDir),
			await listReferencedContainerIds(db),
			this.suspectedOrphanContainers,
			{ requireSecondSighting: !opts.atStartup },
		);
		// Carried to the next tick: a container is only destroyed once it has looked
		// orphaned twice running, which is what keeps a mid-provision container -
		// on the engine, not yet recorded anywhere - from being swept.
		this.suspectedOrphanContainers = result.suspected;
	}

	/**
	 * A container died: end the runs *that container* was carrying, and nothing
	 * else.
	 *
	 * Both halves are scoped to the same container and must stay that way. The
	 * in-process abort and the DB update describe one set of runs from two sides;
	 * scoping them differently either leaves a run executing against a row that
	 * reads `failed`, or fails a row whose exec is still streaming.
	 */
	private async handleContainerTransition(transition: ContainerTransition): Promise<void> {
		const { projectId, projectSlug, teamId, containerId, oldStatus, newStatus } = transition;

		if (
			oldStatus === ContainerStatus.Running &&
			(newStatus === ContainerStatus.Error || newStatus === ContainerStatus.Stopped)
		) {
			const reason: ContainerExitReason =
				newStatus === ContainerStatus.Error ? 'container_error' : 'container_stopped';
			this.cancelLiveRunsForContainer(projectId, containerId, reason);
			await failProjectRuns(
				this.buildContainerDeps(),
				projectId,
				projectSlug,
				teamId,
				reason,
				containerId,
			);
		}
	}

	/**
	 * Nightly database housekeeping. Deliberately narrow: refresh planner
	 * statistics (embedded only - PGlite has no auto-ANALYZE, so the indexes the
	 * hot queries need silently stop being chosen as an instance grows), and
	 * delete terminal wakeup rows past their retention window. Nothing here
	 * touches run logs, cost entries or audit history - those are the user's
	 * record, and reclaiming them stays an explicit operator action.
	 */
	private async runDbMaintenance(): Promise<void> {
		const { analyzeHotTables, sweepTerminalWakeups } = await import('./db-maintenance');
		const swept = await sweepTerminalWakeups(this.deps.db);
		if (swept > 0) log.debug(`Swept ${swept} terminal wakeup row(s)`);
		const analyzed = await analyzeHotTables(this.deps.db);
		if (analyzed > 0) log.debug(`Refreshed planner statistics on ${analyzed} table(s)`);
	}

	private async archiveInboxItems(): Promise<void> {
		const { archiveOldInboxItems } = await import('./inbox-archive');
		const count = await archiveOldInboxItems(this.deps.db, runtimeConfig().jobs.inboxRetentionDays);
		if (count > 0) {
			log.debug(`Archived ${count} inbox item(s)`);
		}
	}

	/**
	 * Kick the run-log compaction drain immediately, without waiting for the next
	 * cron tick — used by the manual trigger on the DB panel. Guarded under the
	 * same key as the cron so a manual kick and a scheduled tick never overlap;
	 * whichever holds the guard drains the backlog the active marker describes.
	 */
	kickLogCompaction(): void {
		void trackBackground(this.guarded('log-compaction', () => this.compactRunLogs()));
	}

	/**
	 * One drain tick of run-log compaction. A no-op unless a compaction pass is
	 * active (its marker set from the DB panel); otherwise it compacts a bounded
	 * slice of the backlog and, once drained, reclaims space and clears the
	 * marker. See {@link ./log-compaction}.
	 */
	private async compactRunLogs(): Promise<void> {
		const { runLogCompactionTick } = await import('./log-compaction');
		await runLogCompactionTick(this.deps.db, {
			backend: this.deps.storageBackend ?? 'embedded',
		});
	}

	/**
	 * Keep connectors honest: renew the tokens that are about to lapse, and
	 * re-prove the hosted servers that carry no credential at all.
	 *
	 * Two legs, each in its own try/catch so one third party cannot stop the
	 * other running. They watch disjoint sets - the token leg reads
	 * `oauth_connections`, which is exactly why it was blind to a connector with
	 * no connection - and they differ on the master key: renewing decrypts, so it
	 * waits for an unlock, while probing decrypts nothing and runs regardless. A
	 * locked instance still learns that a public MCP has started demanding auth.
	 *
	 * The token leg is both halves of the same tick: a connection whose refresh
	 * succeeds has its `auth_error` cleared, so a provider blip that degraded
	 * twenty connectors un-degrades them here with no human action; one whose
	 * refresh fails has the reason recorded, which is what turns the connector
	 * `degraded` and lights the operator's project banner.
	 */
	private async sweepConnectorHealth(): Promise<void> {
		// Nothing to refresh while the vault is locked, and attempting it would log
		// a "could not decrypt refresh token" warning per candidate every 5 minutes
		// for as long as the instance stays locked.
		if (this.deps.masterKeyManager.getKey()) {
			try {
				const { refreshExpiringTokens } = await import('./oauth/token-resolver');
				await refreshExpiringTokens(
					{ db: this.deps.db, masterKeyManager: this.deps.masterKeyManager },
					{
						horizonMs: CONNECTOR_HEALTH_HORIZON_MS,
						limit: CONNECTOR_HEALTH_BATCH_LIMIT,
						concurrency: CONNECTOR_HEALTH_CONCURRENCY,
					},
				);
			} catch (e) {
				log.warn('connector token refresh sweep failed', { error: (e as Error).message });
			}
		}

		try {
			const { probeUnverifiedConnectors } = await import('./connectors/method-discovery');
			await probeUnverifiedConnectors(
				{ db: this.deps.db, masterKeyManager: this.deps.masterKeyManager },
				{
					limit: CONNECTOR_PROBE_BATCH_LIMIT,
					staleAfterMs: CONNECTOR_PROBE_INTERVAL_MS,
					concurrency: CONNECTOR_PROBE_CONCURRENCY,
				},
			);
		} catch (e) {
			log.warn('connector probe sweep failed', { error: (e as Error).message });
		}
	}

	/**
	 * Daily auto-update check. When the feature is enabled (supervised compiled
	 * binary) and a newer release exists that isn't already staged/downloading,
	 * download+verify+stage it so an operator "Install & restart" is instant. The
	 * status poll triggers the same idempotent helper, so a running instance
	 * usually stages well before this daily run.
	 */
	private async checkForUpdate(): Promise<void> {
		if (!isSupervisedWorker()) return;
		await ensureUpdateStaged(this.deps.dataDir, getLatestInfo);
	}

	/**
	 * Auto-install cron (opt-in via `--auto-install-updates` /
	 * `HEZO_AUTO_INSTALL_UPDATES`). When a downloaded-and-verified update is
	 * staged and no agent runs are in flight, gracefully restart onto it — the
	 * same shutdown-and-sentinel-exit path as the operator's "Install & restart".
	 * A busy instance defers to the next tick, so the install lands minutes after
	 * the instance goes idle. The instance comes back unlocked: the supervisor
	 * holds the in-memory unlock key across the restart and hands it to the
	 * relaunched worker (see `lib/unlock-handoff.ts`).
	 */
	private async autoInstallStagedUpdate(): Promise<void> {
		if (!(this.deps.isSupervisedWorker ?? isSupervisedWorker)()) return;
		const state = await readUpdateState(this.deps.dataDir);
		if (state.state !== UpdateState.Staged) return;
		if (this.runningTasks.size > 0) {
			log.info(
				`Deferring auto-install of update ${state.targetVersion}: ` +
					`${this.runningTasks.size} agent run(s) in flight`,
			);
			return;
		}
		log.info(`Auto-installing staged update ${state.targetVersion}; restarting`);
		await (this.deps.requestUpdateRestart ?? exitToApplyUpdate)();
	}

	private async refreshPricing(): Promise<void> {
		if (!this.deps.pricing) return;
		const count = await this.deps.pricing.refresh();
		log.info(`Model pricing refreshed from pricepertoken.com (${count} models)`);
	}

	/**
	 * Move each configured provider's pinned default model to the newest in its
	 * family. Best-effort: the service reports per-provider failures rather than
	 * throwing, so one unreachable provider cannot skip the rest.
	 */
	private async refreshModelPins(): Promise<void> {
		const result = await refreshModelPins(this.deps.db, this.deps.masterKeyManager);
		if (result.changed.length > 0) {
			log.info(`Model pins refreshed — ${result.changed.join(', ')}`);
		}
		if (result.skipped.length > 0) {
			log.info(`Model pins skipped — ${result.skipped.join(', ')}`);
		}
	}

	private async runTelemetry(): Promise<void> {
		const t = this.deps.telemetry;
		if (!t?.enabled) return;
		await reportTelemetry(this.deps.db, { endpoint: t.endpoint, dataDir: this.deps.dataDir });
	}
}
