import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	type AgentRuntime,
	AgentRuntimeStatus,
	type AiProvider,
	COACH_AGENT_SLUG,
	CommentContentType,
	ContainerStatus,
	HeartbeatRunStatus,
	TaskPriority,
	TaskStatus,
	TERMINAL_TASK_STATUSES,
	WakeupSkipReason,
	WakeupSource,
	WakeupStatus,
	wsRoom,
} from '@hezo/shared';
import { Cron } from 'cron-async';
import type { MasterKeyManager } from '../crypto/master-key';
import { trackBackground } from '../lib/background';
import { broadcastRowChange } from '../lib/broadcast';
import { shouldDeferWakeupForBlockers } from '../lib/dependencies';
import { ref } from '../lib/log-ref';
import { assertChildrenAllClosed } from '../lib/task-relationships';
import { logger } from '../logger';
import { type RunnerDeps, type RunResult, runAgent } from './agent-runner';
import { setAgentIdleIfNoActiveRuns } from './agent-runtime-status';
import type { ContainerLogStreamer } from './container-logs';
import {
	type ContainerDeps,
	type ContainerExitReason,
	type ContainerTransition,
	failProjectRuns,
	rebuildContainer,
	syncAllContainerStatuses,
	verifyContainerWorkspace,
} from './containers';
import type { DockerClient } from './docker';
import type { EgressProxy } from './egress';
import type { LogStreamBroker } from './log-stream-broker';
import { detectOrphans } from './orphan-detector';
import { ensureRepoSetupAction } from './repo-setup';
import type { SshAgentServer } from './ssh-agent';
import { recordStatusChange } from './task-events';
import { absorbQueuedTaskWakeups, createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('job-manager');

const MAX_CONSECUTIVE_FAILURE_PINGS = 3;
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

interface RunningTask {
	key: string;
	abortController: AbortController;
	promise: Promise<unknown>;
	startedAt: number;
	timeoutId: ReturnType<typeof setTimeout>;
}

export interface LiveRun {
	runId: string;
	memberId: string;
	taskId: string;
	projectId: string;
	teamId: string;
	taskKey: string;
}

export interface JobManagerDeps {
	db: PGlite;
	docker: DockerClient;
	masterKeyManager: MasterKeyManager;
	serverPort: number;
	dataDir: string;
	wsManager: WebSocketManager;
	logs: LogStreamBroker;
	containerLogStreamer: ContainerLogStreamer;
	sshAgentServer?: SshAgentServer;
	egressProxy?: EgressProxy | null;
	egressCAPath?: string;
}

const COALESCING_WINDOW_MS = Number(process.env.HEZO_WAKEUP_COALESCING_MS ?? 2_000);
const WAKEUP_CRON = process.env.HEZO_WAKEUP_CRON ?? '*/5 * * * * *';
const HEARTBEAT_CRON = process.env.HEZO_HEARTBEAT_CRON ?? '*/5 * * * * *';
// Lower bound on how often a heartbeat can fire, regardless of an agent's
// configured `heartbeat_interval_min`. Defends against misconfigured low/zero
// intervals producing a tight 5-second-cron loop on the same agent.
const HEARTBEAT_INTERVAL_FLOOR_MIN = Number(process.env.HEZO_HEARTBEAT_FLOOR_MIN ?? 5);
// Quiet window after a run completes before that agent is eligible for another
// heartbeat. Prevents back-to-back runs when the configured interval is shorter
// than the run itself.
const HEARTBEAT_POST_RUN_COOLDOWN_SEC = Number(process.env.HEZO_HEARTBEAT_COOLDOWN_SEC ?? 60);

export class JobManager {
	private cron: Cron;
	private runningTasks = new Map<string, RunningTask>();
	private liveRuns = new Map<string, LiveRun>();
	private guards = new Map<string, boolean>();
	// Tasks currently held by a dispatched run. Populated synchronously in activateAgent
	// before launchTask, cleared in the launchTask finally. Closes the race window between
	// dispatch and createHeartbeatRun where the DB-backed check is not yet authoritative.
	private activeTaskRuns = new Set<string>();
	// Projects whose container/workspace is currently held by a dispatched run.
	// Same in-memory guard as activeTaskRuns, scoped at the project level so a
	// second run cannot enter the project's shared workspace until the first
	// releases. Tracked in parallel with activeTaskRuns in activateAgent.
	private activeProjectRuns = new Set<string>();
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
			cron: '*/30 * * * * *',
			log: cronLog,
			onTick: () => this.guarded('orphan-detection', () => this.detectOrphanedRuns()),
		});
		this.cron.createJob('container-sync', {
			cron: '* * * * * *',
			log: cronLog,
			onTick: () => this.guarded('container-sync', () => this.syncContainerStatuses()),
		});
		this.cron.createJob('embeddings', {
			cron: '*/30 * * * * *',
			log: cronLog,
			onTick: () => this.guarded('embeddings', () => this.processEmbeddingQueue()),
		});
		log.info('Job manager started.');
	}

	launchTask(key: string, fn: (signal: AbortSignal) => Promise<unknown>, timeoutMs: number): void {
		if (this.runningTasks.has(key)) return;
		const ac = new AbortController();

		const timeoutId = setTimeout(() => {
			log.warn(`Task ${key} timed out after ${timeoutMs}ms`);
			ac.abort();
		}, timeoutMs);

		const promise = trackBackground(
			fn(ac.signal).finally(() => {
				clearTimeout(timeoutId);
				this.runningTasks.delete(key);
			}),
		);

		this.runningTasks.set(key, {
			key,
			abortController: ac,
			promise,
			startedAt: Date.now(),
			timeoutId,
		});
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
		}>(
			`UPDATE heartbeat_runs
			 SET status = $1::heartbeat_run_status,
			     finished_at = COALESCE(finished_at, now()),
			     error = COALESCE(error, $2),
			     exit_code = COALESCE(exit_code, -1)
			 WHERE status IN ($3::heartbeat_run_status, $4::heartbeat_run_status)
			 RETURNING id, member_id, team_id, task_id`,
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

		if (stranded.rows.length > 0 || resetAgents.rows.length > 0) {
			log.info(
				`Startup reconciliation: failed ${stranded.rows.length} stranded run(s), reset ${resetAgents.rows.length} agent(s) to idle`,
			);
		}

		await this.selfHealErroredContainers(docker);
		await this.repairStaleContainerMounts(docker);
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
				`Container ${row.container_id.slice(0, 12)} for project ${row.id} has unreachable /workspace mount — rebuilding`,
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
				log.info(`Rebuilt container for project ${row.id} after stale-mount detection`);
			} catch (err) {
				log.error(`Failed to rebuild stale container for project ${row.id}:`, err);
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
			const name = `hezo-${project.team_slug}-${project.slug}`;
			let info: Awaited<ReturnType<DockerClient['inspectContainerByName']>>;
			try {
				info = await docker.inspectContainerByName(name);
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
			log.info(`Self-healed project ${project.id} — re-attached to live container ${name}`);
		}
	}

	private async guarded(name: string, fn: () => Promise<void>): Promise<void> {
		if (this.guards.get(name)) return;
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
		if (this.activeTaskRuns.has(taskId)) return true;
		const { db } = this.deps;
		const active = await db.query(
			`SELECT 1 FROM heartbeat_runs
			 WHERE task_id = $1
			   AND status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)
			 LIMIT 1`,
			[taskId, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
		);
		return active.rows.length > 0;
	}

	private async isProjectBusy(projectId: string): Promise<boolean> {
		if (this.activeProjectRuns.has(projectId)) return true;
		const { db } = this.deps;
		const active = await db.query(
			`SELECT 1 FROM heartbeat_runs r
			 JOIN tasks t ON t.id = r.task_id
			 WHERE t.project_id = $1
			   AND r.status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)
			 LIMIT 1`,
			[projectId, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
		);
		return active.rows.length > 0;
	}

	private async findBusyTaskOnProject(projectId: string): Promise<string | null> {
		const { db } = this.deps;
		const active = await db.query<{ task_id: string }>(
			`SELECT r.task_id FROM heartbeat_runs r
			 JOIN tasks t ON t.id = r.task_id
			 WHERE t.project_id = $1
			   AND r.status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)
			 ORDER BY r.created_at ASC
			 LIMIT 1`,
			[projectId, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
		);
		return active.rows[0]?.task_id ?? null;
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

	private async resolveProjectForTask(taskId: string): Promise<string | null> {
		const { db } = this.deps;
		const r = await db.query<{ project_id: string }>('SELECT project_id FROM tasks WHERE id = $1', [
			taskId,
		]);
		return r.rows[0]?.project_id ?? null;
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
		}>(
			`SELECT id, member_id, team_id, source, payload
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
				const projectId = await this.resolveProjectForTask(wakeupTaskId);
				if (projectId && (await this.isProjectBusy(projectId))) {
					log.debug(
						`Skipping wakeup ${wakeup.id} — project ${projectId} already has an active run`,
					);
					const busyTaskId = await this.findBusyTaskOnProject(projectId);
					await this.markWakeupSkipped(
						wakeup.id,
						WakeupSkipReason.ProjectBusy,
						wakeupTaskId,
						wakeup.team_id,
						busyTaskId,
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
			   AND ma.runtime_status != $2
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
				AgentRuntimeStatus.Paused,
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

		type TaskRow = {
			id: string;
			identifier: string;
			title: string;
			description: string;
			status: string;
			priority: string;
			project_id: string;
			rules: string | null;
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
				'SELECT id, identifier, title, description, status, priority, project_id, rules, assignee_id, runtime_type, parent_task_id, created_by_run_id FROM tasks WHERE id = $1 AND team_id = $2',
				[payloadTaskId, teamId],
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
			const tasks = await db.query<TaskRow>(
				`SELECT i.id, i.identifier, i.title, i.description, i.status, i.priority, i.project_id, i.rules, i.assignee_id, i.runtime_type, i.parent_task_id, i.created_by_run_id
				 FROM tasks i
				 WHERE i.assignee_id = $1 AND i.team_id = $2
				   AND i.status NOT IN ($3, $4, $5)
				   AND NOT EXISTS (
				     SELECT 1 FROM task_dependencies d
				     JOIN tasks b ON b.id = d.blocked_by_task_id
				     WHERE d.task_id = i.id
				       AND b.status NOT IN ($3, $4, $5)
				   )
				 ORDER BY
				   CASE i.priority WHEN $6 THEN 0 WHEN $7 THEN 1 WHEN $8 THEN 2 WHEN $9 THEN 3 END,
				   i.created_at ASC
				 LIMIT 1`,
				[
					memberId,
					teamId,
					...TERMINAL_TASK_STATUSES,
					TaskPriority.Urgent,
					TaskPriority.High,
					TaskPriority.Medium,
					TaskPriority.Low,
				],
			);
			if (tasks.rows.length === 0) {
				log.debug(`No actionable tasks for agent ${ref(agent.rows[0].slug, memberId)}`);
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

		// Per-task and per-project serialisation: only one agent runs on a given
		// task at a time, and only one run is allowed per project at a time (the
		// container/workspace is shared at the project level). Most blocked
		// wakeups are filtered earlier by processWakeups; this guard catches
		// heartbeat-style wakeups (no payload.task_id) where the chosen task is
		// determined here, plus any race where the task or project became busy
		// between the dispatcher check and now.
		if (await this.isTaskBusy({ task_id: task.id })) {
			log.debug(
				`Task ${ref(task.identifier, task.id)} already has an active run — re-queuing wakeup for ${ref(agent.rows[0].slug, memberId)}`,
			);
			if (wakeupId) {
				await db.query(
					'UPDATE agent_wakeup_requests SET status = $1::wakeup_status, claimed_at = NULL WHERE id = $2',
					[WakeupStatus.Queued, wakeupId],
				);
			}
			return;
		}
		if (await this.isProjectBusy(task.project_id)) {
			log.debug(
				`Project ${task.project_id} already has an active run — re-queuing wakeup for ${ref(agent.rows[0].slug, memberId)}`,
			);
			if (wakeupId) {
				await db.query(
					'UPDATE agent_wakeup_requests SET status = $1::wakeup_status, claimed_at = NULL WHERE id = $2',
					[WakeupStatus.Queued, wakeupId],
				);
			}
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
			logs: this.deps.logs,
			sshAgentServer: this.deps.sshAgentServer,
			egressProxy: this.deps.egressProxy ?? null,
			egressCAPath: this.deps.egressCAPath ?? null,
		};
		const timeoutMs = agent.rows[0].run_timeout_min * 60 * 1000;

		const projectId = project.rows[0].id;
		const taskKey = `${memberId}:${projectId}`;
		const lockedTaskId = task.id;
		this.activeTaskRuns.add(lockedTaskId);
		this.activeProjectRuns.add(projectId);

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

		this.launchTask(
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
					return null;
				} finally {
					this.activeTaskRuns.delete(lockedTaskId);
					this.activeProjectRuns.delete(projectId);
					void trackBackground(this.guarded('wakeups', () => this.processWakeups()));
				}
			},
			timeoutMs,
		);
	}

	private async onAgentComplete(
		memberId: string,
		agentSlug: string,
		taskId: string,
		taskIdentifier: string,
		teamId: string,
		wakeupId: string | undefined,
		wakeupPayload: Record<string, unknown> | undefined,
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

		if (
			agentSlug === COACH_AGENT_SLUG &&
			result.success &&
			wakeupPayload?.trigger === 'task_done'
		) {
			const childrenCheck = await assertChildrenAllClosed(db, teamId, taskId);
			if (!childrenCheck.ok) {
				log.warn(
					`Skipping coach auto-close for task ${ref(taskIdentifier, taskId)}: ${childrenCheck.message}`,
				);
			} else {
				const closed = await db.query<Record<string, unknown>>(
					`UPDATE tasks SET status = $1::task_status, updated_at = now()
					 WHERE id = $2 AND team_id = $3 AND status = $4::task_status
					 RETURNING *`,
					[TaskStatus.Closed, taskId, teamId, TaskStatus.Done],
				);
				if (closed.rows[0]) {
					broadcastRowChange(
						this.deps.wsManager,
						wsRoom.team(teamId),
						'tasks',
						'UPDATE',
						closed.rows[0],
					);
					await recordStatusChange(
						db,
						teamId,
						taskId,
						TaskStatus.Done,
						TaskStatus.Closed,
						memberId,
						this.deps.wsManager,
					);
				}
			}
		}

		await this.chainNextTaskWakeup(memberId, agentSlug, taskId, teamId);
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
		const commentId = commentRow.id as string;

		broadcastRowChange(
			this.deps.wsManager,
			wsRoom.team(teamId),
			'task_comments',
			'INSERT',
			commentRow,
		);

		await createWakeup(db, memberId, teamId, WakeupSource.Automation, {
			source: WakeupSource.Automation,
			task_id: taskId,
			comment_id: commentId,
			run_id: runId,
			reason: 'run_failed',
		});
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
		// run on (concurrent parallel runs), and anything that already has a
		// queued/claimed wakeup for this agent. Without this dedupe, an agent with
		// multiple concurrent runs creates a redundant chain wakeup for each
		// sibling — those wakeups then cycle in the busy-skip queue and starve
		// `Automation` wakeups (Coach) targeting the same project.
		const next = await db.query<{ id: string }>(
			`SELECT i.id FROM tasks i
			 WHERE i.assignee_id = $1 AND i.team_id = $2 AND i.id != $3
			   AND i.status NOT IN ($4::task_status, $5::task_status, $6::task_status)
			   AND NOT EXISTS (
			     SELECT 1 FROM task_dependencies d
			     JOIN tasks b ON b.id = d.blocked_by_task_id
			     WHERE d.task_id = i.id
			       AND b.status NOT IN ($4::task_status, $5::task_status, $6::task_status)
			   )
			   AND NOT EXISTS (
			     SELECT 1 FROM heartbeat_runs hr
			     WHERE hr.task_id = i.id AND hr.member_id = $1
			       AND hr.status IN ($11::heartbeat_run_status, $12::heartbeat_run_status)
			   )
			   AND NOT EXISTS (
			     SELECT 1 FROM agent_wakeup_requests w
			     WHERE w.member_id = $1
			       AND w.status IN ($13::wakeup_status, $14::wakeup_status)
			       AND w.payload->>'task_id' = i.id::text
			   )
			 ORDER BY
			   CASE i.priority WHEN $7 THEN 0 WHEN $8 THEN 1 WHEN $9 THEN 2 WHEN $10 THEN 3 END,
			   i.created_at ASC
			 LIMIT 1`,
			[
				memberId,
				teamId,
				justCompletedTaskId,
				...TERMINAL_TASK_STATUSES,
				TaskPriority.Urgent,
				TaskPriority.High,
				TaskPriority.Medium,
				TaskPriority.Low,
				HeartbeatRunStatus.Queued,
				HeartbeatRunStatus.Running,
				WakeupStatus.Queued,
				WakeupStatus.Claimed,
			],
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
		await detectOrphans(this.deps.db, this.getLiveRunIds(), this.deps.wsManager);
	}

	private async syncContainerStatuses(): Promise<void> {
		const reachable = await this.deps.docker.ping();
		if (!reachable) {
			return;
		}

		const transitions = await syncAllContainerStatuses(
			this.deps.db,
			this.deps.docker,
			this.deps.wsManager,
		);

		for (const transition of transitions) {
			await this.handleContainerTransition(transition);
		}
	}

	private async handleContainerTransition(transition: ContainerTransition): Promise<void> {
		const { projectId, teamId, oldStatus, newStatus } = transition;

		if (
			oldStatus === ContainerStatus.Running &&
			(newStatus === ContainerStatus.Error || newStatus === ContainerStatus.Stopped)
		) {
			const reason: ContainerExitReason =
				newStatus === ContainerStatus.Error ? 'container_error' : 'container_stopped';
			this.cancelLiveRunsForProject(projectId, reason);
			await failProjectRuns(this.buildContainerDeps(), projectId, teamId, reason);
		}
	}

	private async processEmbeddingQueue(): Promise<void> {
		const { processPendingEmbeddings } = await import('./embeddings');
		const count = await processPendingEmbeddings(this.deps.db);
		if (count > 0) {
			log.debug(`Processed ${count} embedding(s)`);
		}
	}
}
