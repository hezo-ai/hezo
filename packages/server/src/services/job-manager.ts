import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	type AgentRuntime,
	AgentRuntimeStatus,
	type AiProvider,
	COACH_AGENT_SLUG,
	ContainerStatus,
	HeartbeatRunStatus,
	IssuePriority,
	IssueStatus,
	TERMINAL_ISSUE_STATUSES,
	WakeupSource,
	WakeupStatus,
	wsRoom,
} from '@hezo/shared';
import { Cron } from 'cron-async';
import type { MasterKeyManager } from '../crypto/master-key';
import { broadcastRowChange } from '../lib/broadcast';
import { assertChildrenAllClosed } from '../lib/issue-relationships';
import { logger } from '../logger';
import { type RunnerDeps, type RunResult, runAgent } from './agent-runner';
import {
	type ContainerDeps,
	type ContainerExitReason,
	type ContainerTransition,
	failProjectRuns,
	syncAllContainerStatuses,
} from './containers';
import type { DockerClient } from './docker';
import type { LogStreamBroker } from './log-stream-broker';
import { detectOrphans } from './orphan-detector';
import { ensureRepoSetupAction } from './repo-setup';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('job-manager');

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
	issueId: string;
	projectId: string;
	companyId: string;
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
}

const COALESCING_WINDOW_MS = Number(process.env.HEZO_WAKEUP_COALESCING_MS ?? 2_000);

export class JobManager {
	private cron: Cron;
	private runningTasks = new Map<string, RunningTask>();
	private liveRuns = new Map<string, LiveRun>();
	private guards = new Map<string, boolean>();
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
		};
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.cron.createJob('wakeups', {
			cron: '*/5 * * * * *',
			onTick: () => this.guarded('wakeups', () => this.processWakeups()),
		});
		this.cron.createJob('heartbeats', {
			cron: '*/5 * * * * *',
			onTick: () => this.guarded('heartbeats', () => this.processScheduledHeartbeats()),
		});
		this.cron.createJob('orphan-detection', {
			cron: '*/30 * * * * *',
			onTick: () => this.guarded('orphan-detection', () => this.detectOrphanedRuns()),
		});
		this.cron.createJob('container-sync', {
			cron: '* * * * * *',
			onTick: () => this.guarded('container-sync', () => this.syncContainerStatuses()),
		});
		this.cron.createJob('embeddings', {
			cron: '*/30 * * * * *',
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

		const promise = fn(ac.signal).finally(() => {
			clearTimeout(timeoutId);
			this.runningTasks.delete(key);
		});

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
			company_id: string;
			issue_id: string | null;
		}>(
			`UPDATE heartbeat_runs
			 SET status = $1::heartbeat_run_status,
			     finished_at = COALESCE(finished_at, now()),
			     error = COALESCE(error, $2),
			     exit_code = COALESCE(exit_code, -1)
			 WHERE status IN ($3::heartbeat_run_status, $4::heartbeat_run_status)
			 RETURNING id, member_id, company_id, issue_id`,
			[
				HeartbeatRunStatus.Failed,
				'Server restarted while run in flight',
				HeartbeatRunStatus.Running,
				HeartbeatRunStatus.Queued,
			],
		);

		const resetAgents = await db.query<{ id: string; company_id: string }>(
			`UPDATE member_agents ma
			 SET runtime_status = $1::agent_runtime_status
			 FROM members m
			 WHERE ma.id = m.id
			   AND ma.runtime_status = $2::agent_runtime_status
			 RETURNING ma.id, m.company_id`,
			[AgentRuntimeStatus.Idle, AgentRuntimeStatus.Active],
		);

		await db.query('UPDATE execution_locks SET released_at = now() WHERE released_at IS NULL');

		for (const run of stranded.rows) {
			broadcastRowChange(wsManager, wsRoom.company(run.company_id), 'heartbeat_runs', 'UPDATE', {
				id: run.id,
				member_id: run.member_id,
				issue_id: run.issue_id,
				status: HeartbeatRunStatus.Failed,
				error: 'Server restarted while run in flight',
			});
		}

		for (const agent of resetAgents.rows) {
			broadcastRowChange(wsManager, wsRoom.company(agent.company_id), 'member_agents', 'UPDATE', {
				id: agent.id,
				runtime_status: AgentRuntimeStatus.Idle,
			});
		}

		for (const run of stranded.rows) {
			if (!run.issue_id) continue;
			await createWakeup(db, run.member_id, run.company_id, WakeupSource.Timer, {
				reason: 'startup_recovery',
				issue_id: run.issue_id,
				previous_run_id: run.id,
			}).catch((e) => log.error('Failed to enqueue startup recovery wakeup:', e));
		}

		if (stranded.rows.length > 0 || resetAgents.rows.length > 0) {
			log.info(
				`Startup reconciliation: failed ${stranded.rows.length} stranded run(s), reset ${resetAgents.rows.length} agent(s) to idle`,
			);
		}

		await this.selfHealErroredContainers(docker);
	}

	private async selfHealErroredContainers(docker: DockerClient): Promise<void> {
		const { db, wsManager } = this.deps;

		const reachable = await docker.ping();
		if (!reachable) {
			log.warn('Docker not reachable at startup; skipping container self-heal');
			return;
		}

		const candidates = await db.query<{
			id: string;
			company_id: string;
			slug: string;
			company_slug: string;
		}>(
			`SELECT p.id, p.company_id, p.slug, c.slug AS company_slug
			 FROM projects p
			 JOIN companies c ON c.id = p.company_id
			 WHERE p.container_status = $1::container_status
			    OR (p.container_status IS NULL AND p.container_id IS NULL)`,
			[ContainerStatus.Error],
		);

		for (const project of candidates.rows) {
			const name = `hezo-${project.company_slug}-${project.slug}`;
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
			broadcastRowChange(wsManager, wsRoom.company(project.company_id), 'projects', 'UPDATE', {
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

	private async processWakeups(): Promise<void> {
		const { db } = this.deps;
		const coalescingCutoff = new Date(Date.now() - COALESCING_WINDOW_MS).toISOString();

		const wakeups = await db.query<{
			id: string;
			member_id: string;
			company_id: string;
			source: string;
			payload: Record<string, unknown>;
		}>(
			`SELECT id, member_id, company_id, source, payload
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
			if (this.isTaskRunning(wsRoom.agent(wakeup.member_id))) {
				log.debug(`Skipping wakeup ${wakeup.id} — agent ${wakeup.member_id} already running`);
				continue;
			}

			await db.query(
				'UPDATE agent_wakeup_requests SET status = $1::wakeup_status, claimed_at = now() WHERE id = $2',
				[WakeupStatus.Claimed, wakeup.id],
			);

			try {
				await this.activateAgent(
					wakeup.member_id,
					wakeup.company_id,
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
			company_id: string;
			heartbeat_interval_min: number;
		}>(
			`SELECT ma.id, m.company_id, ma.heartbeat_interval_min
			 FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE ma.admin_status = $1
			   AND ma.runtime_status != $2
			   AND (ma.last_heartbeat_at IS NULL
			        OR ma.last_heartbeat_at + (ma.heartbeat_interval_min || ' minutes')::interval < now())
			 LIMIT 5`,
			[AgentAdminStatus.Enabled, AgentRuntimeStatus.Paused],
		);

		if (dueAgents.rows.length > 0) {
			log.debug(`${dueAgents.rows.length} agent(s) due for heartbeat`);
		}

		for (const agent of dueAgents.rows) {
			if (this.isTaskRunning(wsRoom.agent(agent.id))) {
				continue;
			}
			await this.activateAgent(agent.id, agent.company_id);
		}
	}

	private async activateAgent(
		memberId: string,
		companyId: string,
		wakeupId?: string,
		wakeupPayload?: Record<string, unknown>,
		wakeupSource?: string,
	): Promise<void> {
		const { db, docker, masterKeyManager, serverPort } = this.deps;

		const agent = await db.query<{
			id: string;
			title: string;
			slug: string;
			admin_status: string;
			heartbeat_interval_min: number;
			default_effort: string;
			touches_code: boolean;
			model_override_provider: AiProvider | null;
			model_override_model: string | null;
		}>(
			`SELECT id, title, slug, admin_status,
			        heartbeat_interval_min, default_effort, touches_code,
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

		type IssueRow = {
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
			parent_issue_id: string | null;
			created_by_run_id: string | null;
		};

		let issue: IssueRow | undefined;

		// Wakeups with an explicit issue_id (mentions, comments, coach triggers) target
		// that specific issue — even if the agent isn't the assignee.
		const payloadIssueId =
			typeof wakeupPayload?.issue_id === 'string' ? wakeupPayload.issue_id : undefined;
		if (payloadIssueId) {
			const payloadIssue = await db.query<IssueRow>(
				'SELECT id, identifier, title, description, status, priority, project_id, rules, assignee_id, runtime_type, parent_issue_id, created_by_run_id FROM issues WHERE id = $1 AND company_id = $2',
				[payloadIssueId, companyId],
			);
			if (payloadIssue.rows.length === 0) {
				log.debug(`Payload issue ${payloadIssueId} not found for agent ${memberId}`);
				if (wakeupId) {
					await db.query(
						`UPDATE agent_wakeup_requests SET status = $1::wakeup_status, completed_at = now() WHERE id = $2`,
						[WakeupStatus.Completed, wakeupId],
					);
				}
				return;
			}
			issue = payloadIssue.rows[0];
		} else {
			const issues = await db.query<IssueRow>(
				`SELECT id, identifier, title, description, status, priority, project_id, rules, assignee_id, runtime_type, parent_issue_id, created_by_run_id
				 FROM issues
				 WHERE assignee_id = $1 AND company_id = $2
				   AND status NOT IN ($3, $4, $5)
				 ORDER BY
				   CASE priority WHEN $6 THEN 0 WHEN $7 THEN 1 WHEN $8 THEN 2 WHEN $9 THEN 3 END,
				   created_at ASC
				 LIMIT 1`,
				[
					memberId,
					companyId,
					...TERMINAL_ISSUE_STATUSES,
					IssuePriority.Urgent,
					IssuePriority.High,
					IssuePriority.Medium,
					IssuePriority.Low,
				],
			);
			if (issues.rows.length === 0) {
				log.debug(`No actionable issues for agent ${memberId}`);
				if (wakeupId) {
					await db.query(
						`UPDATE agent_wakeup_requests SET status = $1::wakeup_status, completed_at = now() WHERE id = $2`,
						[WakeupStatus.Completed, wakeupId],
					);
				}
				return;
			}
			issue = issues.rows[0];
		}

		const project = await db.query<{
			id: string;
			slug: string;
			company_id: string;
			company_slug: string;
			container_id: string;
			container_status: string;
			designated_repo_id: string | null;
		}>(
			`SELECT p.id, p.slug, p.company_id, c.slug AS company_slug,
			        p.container_id, p.container_status, p.designated_repo_id
			 FROM projects p
			 JOIN companies c ON c.id = p.company_id
			 WHERE p.id = $1`,
			[issue.project_id],
		);

		if (project.rows.length === 0) {
			log.debug(`Project ${issue.project_id} not found — wakeup failed`);
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
					companyId,
					projectId: projectRow.id,
					issueId: issue.id,
				});
				if (ensured.commentRow) {
					broadcastRowChange(
						this.deps.wsManager,
						wsRoom.company(companyId),
						'issue_comments',
						'INSERT',
						ensured.commentRow,
					);
				}
				if (ensured.approvalRow) {
					broadcastRowChange(
						this.deps.wsManager,
						wsRoom.company(companyId),
						'approvals',
						'INSERT',
						ensured.approvalRow,
					);
				}
			} catch (e) {
				log.error(`Failed to ensure repo setup action for agent ${agentSlug}:`, e);
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
							issue_id: issue.id,
						}),
						wakeupId,
					],
				);
			}
			log.debug(
				`Agent ${agentSlug} deferred on issue ${issue.identifier} — project has no designated repo`,
			);
			return;
		}

		if (!projectRow.container_id) {
			log.debug(`No container for project ${issue.project_id} — wakeup failed`);
			if (wakeupId) {
				await db.query(
					'UPDATE agent_wakeup_requests SET status = $1::wakeup_status WHERE id = $2',
					[WakeupStatus.Failed, wakeupId],
				);
			}
			return;
		}

		// Execution locks are observational — multiple agents can run concurrently on the
		// same issue. The only acquisition guard is per-agent-per-issue: if this agent
		// already holds an active lock on this issue, coalesce the wakeup.
		const lockResult = await db.query<{ id: string }>(
			`INSERT INTO execution_locks (issue_id, member_id, lock_type)
			 SELECT $1, $2, 'read'
			 WHERE NOT EXISTS (
			   SELECT 1 FROM execution_locks
			   WHERE issue_id = $1 AND member_id = $2 AND released_at IS NULL
			 )
			 RETURNING id`,
			[issue.id, memberId],
		);

		if (lockResult.rows.length === 0) {
			log.debug(
				`Agent ${agent.rows[0].slug} already holds a lock on issue ${issue.identifier} — deferring wakeup`,
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
		broadcastRowChange(this.deps.wsManager, wsRoom.company(companyId), 'member_agents', 'UPDATE', {
			id: memberId,
			runtime_status: AgentRuntimeStatus.Active,
		});

		log.debug(`Launching agent ${agent.rows[0].title} for issue ${issue.identifier}`);

		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort,
			dataDir: this.deps.dataDir,
			wsManager: this.deps.wsManager,
			logs: this.deps.logs,
		};
		const timeoutMs = agent.rows[0].heartbeat_interval_min * 60 * 1000;

		const projectId = project.rows[0].id;
		const taskKey = wsRoom.agent(memberId);

		this.launchTask(
			taskKey,
			async (signal) => {
				let registeredRunId: string | undefined;
				const result = await runAgent(
					deps,
					{
						id: memberId,
						title: agent.rows[0].title,
						slug: agent.rows[0].slug,
						company_id: companyId,
						default_effort: agent.rows[0].default_effort,
						model_override_provider: agent.rows[0].model_override_provider,
						model_override_model: agent.rows[0].model_override_model,
					},
					issue,
					project.rows[0],
					wakeupPayload,
					signal,
					(runId) => {
						registeredRunId = runId;
						this.registerLiveRun({
							runId,
							memberId,
							issueId: issue.id,
							projectId,
							companyId,
							taskKey,
						});
					},
				);

				if (registeredRunId) this.unregisterLiveRun(registeredRunId);
				await this.onAgentComplete(
					memberId,
					agent.rows[0].slug,
					issue.id,
					companyId,
					wakeupId,
					wakeupPayload,
					result,
				);
				return result;
			},
			timeoutMs,
		);
	}

	private async onAgentComplete(
		memberId: string,
		agentSlug: string,
		issueId: string,
		companyId: string,
		wakeupId: string | undefined,
		wakeupPayload: Record<string, unknown> | undefined,
		result: RunResult,
	): Promise<void> {
		const { db } = this.deps;

		log.debug(
			`Agent ${memberId} completed: success=${result.success}, exit=${result.exitCode}, duration=${result.durationMs}ms`,
		);

		await db.query(
			'UPDATE execution_locks SET released_at = now() WHERE issue_id = $1 AND member_id = $2 AND released_at IS NULL',
			[issueId, memberId],
		);

		await db.query(
			'UPDATE member_agents SET runtime_status = $1::agent_runtime_status, last_heartbeat_at = now() WHERE id = $2',
			[AgentRuntimeStatus.Idle, memberId],
		);
		broadcastRowChange(this.deps.wsManager, wsRoom.company(companyId), 'member_agents', 'UPDATE', {
			id: memberId,
			runtime_status: AgentRuntimeStatus.Idle,
		});

		if (wakeupId) {
			await db.query(
				`UPDATE agent_wakeup_requests SET status = $1::wakeup_status, completed_at = now() WHERE id = $2`,
				[result.success ? WakeupStatus.Completed : WakeupStatus.Failed, wakeupId],
			);
		}

		if (
			agentSlug === COACH_AGENT_SLUG &&
			result.success &&
			wakeupPayload?.trigger === 'issue_done'
		) {
			const childrenCheck = await assertChildrenAllClosed(db, companyId, issueId);
			if (!childrenCheck.ok) {
				log.warn(`Skipping coach auto-close for issue ${issueId}: ${childrenCheck.message}`);
			} else {
				const closed = await db.query<Record<string, unknown>>(
					`UPDATE issues SET status = $1::issue_status, updated_at = now()
					 WHERE id = $2 AND company_id = $3 AND status = $4::issue_status
					 RETURNING *`,
					[IssueStatus.Closed, issueId, companyId, IssueStatus.Done],
				);
				if (closed.rows[0]) {
					broadcastRowChange(
						this.deps.wsManager,
						wsRoom.company(companyId),
						'issues',
						'UPDATE',
						closed.rows[0],
					);
				}
			}
		}

		await this.chainNextIssueWakeup(memberId, issueId, companyId);
	}

	private async chainNextIssueWakeup(
		memberId: string,
		justCompletedIssueId: string,
		companyId: string,
	): Promise<void> {
		const { db } = this.deps;
		const next = await db.query<{ id: string }>(
			`SELECT id FROM issues
			 WHERE assignee_id = $1 AND company_id = $2 AND id != $3
			   AND status NOT IN ($4::issue_status, $5::issue_status, $6::issue_status)
			 ORDER BY
			   CASE priority WHEN $7 THEN 0 WHEN $8 THEN 1 WHEN $9 THEN 2 WHEN $10 THEN 3 END,
			   created_at ASC
			 LIMIT 1`,
			[
				memberId,
				companyId,
				justCompletedIssueId,
				...TERMINAL_ISSUE_STATUSES,
				IssuePriority.Urgent,
				IssuePriority.High,
				IssuePriority.Medium,
				IssuePriority.Low,
			],
		);
		if (next.rows.length === 0) return;

		try {
			await createWakeup(db, memberId, companyId, WakeupSource.Timer, {
				issue_id: next.rows[0].id,
				reason: 'chain_after_completion',
			});
		} catch (e) {
			log.error(`Failed to chain wakeup for agent ${memberId}:`, e);
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
		const { projectId, companyId, oldStatus, newStatus } = transition;

		if (
			oldStatus === ContainerStatus.Running &&
			(newStatus === ContainerStatus.Error || newStatus === ContainerStatus.Stopped)
		) {
			const reason: ContainerExitReason =
				newStatus === ContainerStatus.Error ? 'container_error' : 'container_stopped';
			this.cancelLiveRunsForProject(projectId, reason);
			await failProjectRuns(this.buildContainerDeps(), projectId, companyId, reason);
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
