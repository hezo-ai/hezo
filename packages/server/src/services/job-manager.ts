import {
	AgentAdminStatus,
	type AgentRuntime,
	AgentRuntimeStatus,
	type AiProvider,
	BUDGET_PAUSE_STATUSES,
	CAPTAIN_AGENT_SLUG,
	CommentContentType,
	ContainerStatus,
	DEFAULT_TEAM_ID,
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
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import type { DomainEventBus } from '../events/bus';
import { trackBackground } from '../lib/background';
import { broadcastRowChange } from '../lib/broadcast';
import type { StorageBackend } from '../lib/db-info';
import { shouldDeferWakeupForBlockers } from '../lib/dependencies';
import { ref } from '../lib/log-ref';
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
import type { ContainerConnectivityStatus, ProbeResult } from './container-connectivity-status';
import type { ContainerLogStreamer } from './container-logs';
import {
	type ContainerDeps,
	type ContainerExitReason,
	type ContainerTransition,
	ensureProjectContainerRunning,
	failProjectRuns,
	provisionContainer,
	rebuildContainer,
	syncAllContainerStatuses,
	verifyContainerWorkspace,
	wakeAgentsWithPendingWork,
} from './containers';
import type { ContainerProcessInfo, DockerClient } from './docker';
import type { EgressProxy } from './egress';
import { getDueGoals } from './goals';
import { HEARTBEAT_INTERVAL_FLOOR_MIN } from './heartbeat-schedule';
import type { LogStreamBroker } from './log-stream-broker';
import { detectOrphans, healStaleRunState, STALE_STATE_GRACE_SECONDS } from './orphan-detector';
import type { PricingService } from './pricing';
import { collectCandidateRunIds, decideSweepKills } from './process-sweeper';
import { ensureRepoSetupAction } from './repo-setup';
import { getProjectConcurrency, isTaskBusyInDb } from './run-concurrency';
import type { SshAgentServer } from './ssh-agent';
import { reportTelemetry } from './telemetry';
import { ensureUpdateStaged, isSupervisedWorker, readUpdateState } from './updater';
import {
	absorbQueuedTaskWakeups,
	assignmentWakeupAlreadyServed,
	createProgressUpdateWakeup,
	createWakeup,
} from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('job-manager');

const MAX_CONSECUTIVE_FAILURE_PINGS = 3;
// A run cut off by its wall-clock time limit auto-queues a same-task continuation. This caps
// how many consecutive timeouts we re-queue through before parking the task, so a task that
// never fits its run window can't loop forever; a non-timeout run in between resets the streak.
const MAX_CONSECUTIVE_TIMEOUT_CONTINUATIONS = 5;
const FAILURE_PING_ERROR_MAX_LEN = 500;
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
}

export type DispatchNowResult =
	| { dispatched: true }
	| {
			dispatched: false;
			reason:
				| 'task_busy'
				| 'project_at_capacity'
				| 'agent_busy'
				| 'blocked'
				| 'not_queued'
				| 'not_found';
	  };

/** Why a progress-update ("Run now") dispatch did or didn't start. `no_captain`/`captain_disabled`/
 * `no_project` only arise on the manual `dispatchProgressUpdateNow` path; the scheduled heartbeat
 * path only produces the others. */
export type ProgressUpdateDispatchReason =
	| 'no_project'
	| 'no_captain'
	| 'captain_disabled'
	| 'no_due_goals'
	| 'agent_busy'
	| 'project_at_capacity'
	| 'container_down'
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

export interface JobManagerDeps {
	db: Db;
	docker: DockerClient;
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
	connectivityStatus?: ContainerConnectivityStatus;
	connectivityProbe?: () => Promise<ProbeResult>;
	pricing?: PricingService;
	/**
	 * Storage backend, so the log-compaction drain knows whether it may VACUUM
	 * FULL to reclaim disk (embedded only). Defaults to 'embedded' when omitted.
	 */
	storageBackend?: StorageBackend;
	/** Anonymous daily usage telemetry. Omitted/disabled → the cron is not registered. */
	telemetry?: { enabled: boolean; endpoint: string };
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

const COALESCING_WINDOW_MS = Number(process.env.HEZO_WAKEUP_COALESCING_MS ?? 2_000);
const WAKEUP_CRON = process.env.HEZO_WAKEUP_CRON ?? '*/5 * * * * *';
const HEARTBEAT_CRON = process.env.HEZO_HEARTBEAT_CRON ?? '*/5 * * * * *';
const INBOX_ARCHIVE_CRON = process.env.HEZO_INBOX_ARCHIVE_CRON ?? '0 0 3 * * *';
// Daily model-pricing refresh from the pricepertoken.com catalog. Failures
// log and leave the existing rows — the boot-time refresh / next tick retries.
const PRICING_REFRESH_CRON = process.env.HEZO_PRICING_REFRESH_CRON ?? '0 0 2 * * *';
// Daily check for a newer release; when auto-update is enabled and one is found,
// download+verify+stage it so an operator "Update & restart" is instant.
const UPDATE_CHECK_CRON = process.env.HEZO_UPDATE_CHECK_CRON ?? '0 0 4 * * *';
// Frequent because it is cheap (reads the local state file; no network) — it exists so a
// deferred install (agent runs in flight at staging time) retries minutes later, not next day.
const AUTO_INSTALL_CRON = process.env.HEZO_AUTO_INSTALL_CRON ?? '0 */5 * * * *';
// Anonymous daily usage telemetry report — runs at 5am UTC, after the update
// check, when telemetry is enabled (opt-out, default on).
const TELEMETRY_CRON = process.env.HEZO_TELEMETRY_CRON ?? '0 0 5 * * *';
// How often to re-evaluate budget-paused agents. Spend is summed over rolling
// UTC windows, so a daily/weekly/monthly window rolling over silently frees an
// agent's budget with no event — this sweep notices and lifts the reactive
// pause so the heartbeat scheduler (which skips paused agents) resumes it.
const BUDGET_RESUME_CRON = process.env.HEZO_BUDGET_RESUME_CRON ?? '*/30 * * * * *';
// Container status reconciliation and orphaned-run detection. These run on a
// fixed wall-clock tick rather than reacting to an event, so they keep firing
// even while nothing is happening. The defaults (1s / 30s) keep the dashboard
// snappy in production, but on a CPU-starved CI runner three 1Hz crons
// (wakeups, heartbeats, container-sync) compound into sustained load that
// slows page loads enough to time out browser/component specs. Both are env-
// configurable so the E2E server can dial them down — see playwright.config.ts.
const CONTAINER_SYNC_CRON = process.env.HEZO_CONTAINER_SYNC_CRON ?? '* * * * * *';
const ORPHAN_DETECTION_CRON = process.env.HEZO_ORPHAN_DETECTION_CRON ?? '*/30 * * * * *';
// The reactive budget pauses, which the heartbeat scheduler must not wake (the
// budget-resume sweep lifts them back to `idle` once the window rolls over).
// Disabled agents are filtered separately via `admin_status`. Postgres array
// literal for the `<> ALL(...)` / `= ANY(...)` enum-array params.
const BUDGET_PAUSE_STATUSES_PG = `{${BUDGET_PAUSE_STATUSES.join(',')}}`;
const INBOX_RETENTION_DAYS = Number(process.env.HEZO_INBOX_RETENTION_DAYS ?? 30);
// Drain tick for agent run-log compaction. Cheap when idle (a single
// `system_meta` read); only does work while a compaction pass is active, which
// the operator starts from the DB panel. Frequent so a started pass makes
// visible progress and resumes promptly after a restart.
const LOG_COMPACTION_CRON = process.env.HEZO_LOG_COMPACTION_CRON ?? '*/10 * * * * *';

/** Rate limit on the "job is overrunning its interval" warning. */
const SKIP_WARN_INTERVAL_MS = 60_000;
// Lower bound on how often a heartbeat can fire (`HEARTBEAT_INTERVAL_FLOOR_MIN`,
// from ./heartbeat-schedule) is shared with the agents API's computed
// `next_heartbeat_at` so the UI countdown matches the cadence enforced here.
// Quiet window after a run completes before that agent is eligible for another
// heartbeat. Prevents back-to-back runs when the configured interval is shorter
// than the run itself.
const HEARTBEAT_POST_RUN_COOLDOWN_SEC = Number(process.env.HEZO_HEARTBEAT_COOLDOWN_SEC ?? 60);

export class JobManager {
	private cron: Cron;
	private runningTasks = new Map<string, RunningTask>();
	private liveRuns = new Map<string, LiveRun>();
	private guards = new Map<string, boolean>();
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

	cancelLiveRunsForProject(projectId: string, reason: ContainerExitReason): number {
		const runs = this.getLiveRunsForProject(projectId);
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
			if (project && (await this.isProjectAtCapacity(project.id))) {
				await this.markWakeupSkipped(
					wakeup.id,
					WakeupSkipReason.ProjectAtCapacity,
					wakeupTaskId,
					wakeup.team_id,
					null,
				);
				return { dispatched: false, reason: 'project_at_capacity' };
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

	start(): void {
		if (this.started) return;
		this.started = true;
		this.cron.createJob('wakeups', {
			cron: WAKEUP_CRON,
			log: cronLog,
			onTick: () => this.guarded('wakeups', () => this.processWakeups()),
		});
		this.cron.createJob('heartbeats', {
			cron: HEARTBEAT_CRON,
			log: cronLog,
			onTick: () => this.guarded('heartbeats', () => this.processScheduledHeartbeats()),
		});
		this.cron.createJob('orphan-detection', {
			cron: ORPHAN_DETECTION_CRON,
			log: cronLog,
			onTick: () => this.guarded('orphan-detection', () => this.detectOrphanedRuns()),
		});
		this.cron.createJob('container-sync', {
			cron: CONTAINER_SYNC_CRON,
			log: cronLog,
			onTick: () => this.guarded('container-sync', () => this.syncContainerStatuses()),
		});
		this.cron.createJob('inbox-archive', {
			cron: INBOX_ARCHIVE_CRON,
			log: cronLog,
			onTick: () => this.guarded('inbox-archive', () => this.archiveInboxItems()),
		});
		this.cron.createJob('log-compaction', {
			cron: LOG_COMPACTION_CRON,
			log: cronLog,
			onTick: () => this.guarded('log-compaction', () => this.compactRunLogs()),
		});
		this.cron.createJob('budget-resume', {
			cron: BUDGET_RESUME_CRON,
			log: cronLog,
			onTick: () => this.guarded('budget-resume', () => this.processBudgetResumes()),
		});
		this.cron.createJob('update-check', {
			cron: UPDATE_CHECK_CRON,
			log: cronLog,
			onTick: () => this.guarded('update-check', () => this.checkForUpdate()),
		});
		if (this.deps.autoInstallUpdates && (this.deps.isSupervisedWorker ?? isSupervisedWorker)()) {
			this.cron.createJob('auto-install-update', {
				cron: AUTO_INSTALL_CRON,
				log: cronLog,
				onTick: () => this.guarded('auto-install-update', () => this.autoInstallStagedUpdate()),
			});
		}
		if (this.deps.pricing) {
			this.cron.createJob('pricing-refresh', {
				cron: PRICING_REFRESH_CRON,
				log: cronLog,
				onTick: () => this.guarded('pricing-refresh', () => this.refreshPricing()),
			});
		}
		if (this.deps.telemetry?.enabled) {
			this.cron.createJob('telemetry', {
				cron: TELEMETRY_CRON,
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
	 * Reconcile DB state with the (now-empty) in-process run registry. Runs in
	 * `running` or `queued` state from the previous process were necessarily lost
	 * with that process — fail them, reset their agents to idle, release locks,
	 * broadcast, and enqueue recovery wakeups so work resumes.
	 *
	 * Also self-heals projects stuck in `error` state whose underlying container
	 * is actually alive (e.g. from a prior false-positive transport-error trip).
	 */
	async reconcileOnStartup(): Promise<void> {
		const { db, docker, wsManager } = this.deps;

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

		await this.selfHealErroredContainers(docker);
		await this.restartStoppedRunningContainers(docker);
		await this.repairStaleContainerMounts(docker);
		await this.sweepDanglingContainerProcesses(docker);
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
		const hq = await this.deps.db.query<{ id: string }>(
			`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
			[DEFAULT_TEAM_ID],
		);
		const hqProjectId = hq.rows[0]?.id;
		if (!hqProjectId) return;
		await ensureProjectContainerRunning(this.buildContainerDeps(), hqProjectId);
	}

	/**
	 * Bring projects whose DB says container_status = running back to actually-
	 * running. Covers the host-reboot / Docker-restart case where the server
	 * never got to mark the container as stopped. Missing containers are
	 * re-provisioned from scratch; stopped ones are started in place. Projects
	 * the user explicitly stopped (container_status = stopped) are left alone.
	 */
	private async restartStoppedRunningContainers(docker: DockerClient): Promise<void> {
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
			 WHERE p.container_status = $1::container_status AND p.container_id IS NOT NULL`,
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
				await db.query('UPDATE projects SET container_error = NULL WHERE id = $1', [row.id]);
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
	private async repairStaleContainerMounts(docker: DockerClient): Promise<void> {
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
			 WHERE p.container_status = $1::container_status AND p.container_id IS NOT NULL`,
			[ContainerStatus.Running],
		);

		for (const row of running.rows) {
			if (!row.container_id) continue;
			const ok = await verifyContainerWorkspace(docker, row.container_id);
			if (ok) continue;

			log.warn(
				`Container ${ref(row.slug, row.container_id.slice(0, 12))} for project ${ref(row.slug, row.id)} has unreachable /workspace mount — rebuilding`,
			);
			try {
				await rebuildContainer(
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
				log.info(
					`Rebuilt container for project ${ref(row.slug, row.id)} after stale-mount detection`,
				);
			} catch (err) {
				log.error(`Failed to rebuild stale container for project ${ref(row.slug, row.id)}:`, err);
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
	private async sweepDanglingContainerProcesses(docker: DockerClient): Promise<void> {
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

	private async selfHealErroredContainers(docker: DockerClient): Promise<void> {
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
			 WHERE p.container_status = $1::container_status
			    OR (p.container_status IS NULL AND p.container_id IS NULL)`,
			[ContainerStatus.Error],
		);

		for (const project of candidates.rows) {
			const name = `hezo-${project.slug}-${project.id.slice(0, 8)}`;
			let info: Awaited<ReturnType<DockerClient['findContainerByNamePrefix']>>;
			try {
				info = await docker.findContainerByNamePrefix(name);
			} catch (err) {
				log.warn(`Self-heal inspect failed for ${name}:`, err);
				continue;
			}
			if (info === null || !info.State.Running) continue;

			await db.query(
				`UPDATE projects SET container_id = $1, container_status = $2::container_status WHERE id = $3`,
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

	private async isProjectAtCapacity(projectId: string): Promise<boolean> {
		const { limit, active } = await getProjectConcurrency(this.deps.db, projectId);
		// The in-memory refcount leads the DB during the dispatch window; once a
		// run's row lands both refer to the same run, so `max` dedupes rather than
		// double-counting. Using the larger of the two never under-counts, so the
		// ceiling is never exceeded.
		const inFlight = Math.max(this.activeProjectRuns.get(projectId) ?? 0, active);
		return inFlight >= limit;
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

	private async processWakeups(): Promise<void> {
		const { db } = this.deps;
		const coalescingCutoff = new Date(Date.now() - COALESCING_WINDOW_MS).toISOString();

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
				if (project && (await this.isProjectAtCapacity(project.id))) {
					log.debug(
						`Skipping wakeup ${wakeup.id} — project ${ref(project.slug, project.id)} is at run capacity`,
					);
					await this.markWakeupSkipped(
						wakeup.id,
						WakeupSkipReason.ProjectAtCapacity,
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
				// activateAgent, so we can't pre-check a project lock. Fall back to
				// per-agent dedup to avoid stacking idle pings.
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
				HEARTBEAT_INTERVAL_FLOOR_MIN,
				HEARTBEAT_POST_RUN_COOLDOWN_SEC,
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
			const payloadTask = await db.query<TaskRow>(
				`SELECT id, identifier, title, description, status, priority, project_id, rules, progress_summary, assignee_id, runtime_type, parent_task_id, created_by_run_id
				 FROM tasks WHERE id = $1${isInstanceAgent ? '' : ' AND team_id = $2'}`,
				isInstanceAgent ? [payloadTaskId] : [payloadTaskId, teamId],
			);
			if (payloadTask.rows.length === 0) {
				log.debug(
					`Payload task ${payloadTaskId} not found for agent ${ref(agent.rows[0].slug, memberId)}`,
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
					if (
						result.reason === 'agent_busy' ||
						result.reason === 'project_at_capacity' ||
						result.reason === 'container_down'
					) {
						// Still transient — re-queue so a later cron tick retries once the
						// Captain frees / the container comes up / capacity clears.
						const skipReason =
							result.reason === 'project_at_capacity'
								? WakeupSkipReason.ProjectAtCapacity
								: result.reason === 'container_down'
									? WakeupSkipReason.ContainerDown
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
		if (await this.isProjectAtCapacity(task.project_id)) {
			log.debug(
				`Project ${task.project_id} is at run capacity — re-queuing wakeup for ${ref(agent.rows[0].slug, memberId)}`,
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

		if (!projectRow.container_id) {
			// container_id stays NULL until the container reaches running, so a
			// 'creating' status here means provisioning is in flight (often minutes
			// on a first image build). Re-queue and retry once it's up rather than
			// burning the wakeup — otherwise a task assigned at project-creation time
			// (e.g. the CEO's coherence pass) would never start.
			if (projectRow.container_status === ContainerStatus.Creating) {
				log.debug(
					`Container for project ${ref(projectRow.slug, task.project_id)} still provisioning — re-queuing wakeup`,
				);
				await this.requeueWakeup(wakeupId);
				return;
			}
			log.debug(
				`No container for project ${ref(projectRow.slug, task.project_id)} — wakeup failed`,
			);
			if (wakeupId) {
				await db.query(
					'UPDATE agent_wakeup_requests SET status = $1::wakeup_status WHERE id = $2',
					[WakeupStatus.Failed, wakeupId],
				);
			}
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
			pricing: this.deps.pricing,
		};
		const timeoutMs = agent.rows[0].run_timeout_min * 60 * 1000;

		const projectId = project.rows[0].id;
		const taskKey = `${memberId}:${projectId}`;
		const lockedTaskId = task.id;
		this.activeTaskRuns.add(lockedTaskId);
		this.acquireProjectRun(projectId);

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
							});
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
			{ memberId, taskId: lockedTaskId, projectId },
		);

		if (!launched) {
			// A concurrent dispatch already holds this agent's per-project run slot,
			// so the launch was dropped. Undo the lock and status side-effects so the
			// task badge doesn't stick, and re-queue for a later slot.
			this.activeTaskRuns.delete(lockedTaskId);
			this.releaseProjectRun(projectId);
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

		if (wakeupId) {
			await db.query(
				`UPDATE agent_wakeup_requests SET status = $1::wakeup_status, completed_at = now() WHERE id = $2`,
				[result.success ? WakeupStatus.Completed : WakeupStatus.Failed, wakeupId],
			);
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
	 * all of them. Returns `{ dispatched: true }` so the scheduled caller yields this activation;
	 * returns `{ dispatched: false, reason }` when there are no due goals or the run can't start
	 * right now (the scheduled caller then falls through to normal task selection and the goals
	 * stay due for the next heartbeat). Shared by the scheduled heartbeat and the manual
	 * `dispatchProgressUpdateNow` ("Run now") path.
	 */
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
	): Promise<TryProgressUpdateResult> {
		const { db, docker, masterKeyManager, serverPort } = this.deps;

		// The Captain's project is its team's single non-internal project.
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
			 WHERE p.team_id = $1 AND p.is_internal = false
			 LIMIT 1`,
			[teamId],
		);
		const projectRow = project.rows[0];
		if (!projectRow) return { dispatched: false, reason: 'no_project' };

		const dueGoals = await getDueGoals(db, projectRow.id);
		if (dueGoals.length === 0) return { dispatched: false, reason: 'no_due_goals' };

		// Don't start a progress update while the Captain is already running in this project, the
		// project is at capacity, the container isn't up, or the Captain/project is over budget.
		// The scheduled caller falls through — the goals remain due for the next heartbeat.
		if (await this.isAgentBusyInProject(memberId, projectRow.id)) {
			return { dispatched: false, reason: 'agent_busy' };
		}
		if (await this.isProjectAtCapacity(projectRow.id)) {
			return { dispatched: false, reason: 'project_at_capacity' };
		}
		if (!projectRow.container_id || projectRow.container_status !== ContainerStatus.Running) {
			return { dispatched: false, reason: 'container_down' };
		}
		if (await checkOverBudget(db, memberId, projectRow.id)) {
			return { dispatched: false, reason: 'over_budget' };
		}

		const progressUpdate: ProgressUpdateContext = {
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
			pricing: this.deps.pricing,
		};
		const timeoutMs = agentRow.run_timeout_min * 60 * 1000;
		const key = `progressupdate:${memberId}:${projectRow.id}`;
		this.acquireProjectRun(projectRow.id);

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
							});
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
		if (wakeupId) {
			await db.query(
				`UPDATE agent_wakeup_requests SET status = $1::wakeup_status, completed_at = now() WHERE id = $2`,
				[result.success ? WakeupStatus.Completed : WakeupStatus.Failed, wakeupId],
			);
		}
	}

	/**
	 * Manually trigger the Captain's progress-update run for a project on demand (the Goals page
	 * "Run now" button). Reuses the exact scheduled logic (`tryDispatchProgressUpdate` → due-goal
	 * selection, gating and launch) so a manual run is identical to a heartbeat-scheduled one. No
	 * wakeup id is passed: `runAgent` synthesises an on-demand wakeup, so there is no queued row for
	 * the 5s cron to double-dispatch. Returns the discriminated result the route maps to HTTP.
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
		);

		// A transient conflict (Captain already running, project at capacity,
		// container still coming up, or a launch race) is queued rather than
		// surfaced as an error: the 5s dispatcher retries the wakeup and the run
		// fires once the Captain frees up. Terminal reasons (no project/captain,
		// disabled, over budget, nothing due) fall through unchanged.
		if (
			!result.dispatched &&
			(result.reason === 'agent_busy' ||
				result.reason === 'project_at_capacity' ||
				result.reason === 'container_down' ||
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
	): Promise<void> {
		const { db } = this.deps;

		const runRow = await db.query<{ status: HeartbeatRunStatus; error: string | null }>(
			'SELECT status, error FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		const run = runRow.rows[0];
		if (!run || !FAILURE_TERMINAL_STATUSES.includes(run.status)) return;

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

		const truncatedError = run.error
			? run.error.length > FAILURE_PING_ERROR_MAX_LEN
				? `${run.error.slice(0, FAILURE_PING_ERROR_MAX_LEN)}…`
				: run.error
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
					status: run.status,
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
			agentRow.rows[0]?.heartbeat_interval_min ?? HEARTBEAT_INTERVAL_FLOOR_MIN,
			HEARTBEAT_INTERVAL_FLOOR_MIN,
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

		const transitions = await syncAllContainerStatuses(this.buildContainerDeps());

		for (const transition of transitions) {
			await this.handleContainerTransition(transition);
		}
	}

	private async handleContainerTransition(transition: ContainerTransition): Promise<void> {
		const { projectId, projectSlug, teamId, oldStatus, newStatus } = transition;

		if (
			oldStatus === ContainerStatus.Running &&
			(newStatus === ContainerStatus.Error || newStatus === ContainerStatus.Stopped)
		) {
			const reason: ContainerExitReason =
				newStatus === ContainerStatus.Error ? 'container_error' : 'container_stopped';
			this.cancelLiveRunsForProject(projectId, reason);
			await failProjectRuns(this.buildContainerDeps(), projectId, projectSlug, teamId, reason);
		}
	}

	private async archiveInboxItems(): Promise<void> {
		const { archiveOldInboxItems } = await import('./inbox-archive');
		const count = await archiveOldInboxItems(this.deps.db, INBOX_RETENTION_DAYS);
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

	private async runTelemetry(): Promise<void> {
		const t = this.deps.telemetry;
		if (!t?.enabled) return;
		await reportTelemetry(this.deps.db, { endpoint: t.endpoint });
	}
}
