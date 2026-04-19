import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	type AgentRuntime,
	AgentRuntimeStatus,
	CODE_TOUCHING_AGENT_SLUGS,
	IssuePriority,
	TERMINAL_ISSUE_STATUSES,
	WakeupStatus,
} from '@hezo/shared';
import { Cron } from 'cron-async';
import type { MasterKeyManager } from '../crypto/master-key';
import { broadcastRowChange } from '../lib/broadcast';
import { logger } from '../logger';
import { type RunnerDeps, type RunResult, runAgent } from './agent-runner';
import { syncAllContainerStatuses } from './containers';
import type { DockerClient } from './docker';
import type { LogStreamBroker } from './log-stream-broker';
import { detectOrphans } from './orphan-detector';
import { ensureRepoSetupAction } from './repo-setup';
import type { WebSocketManager } from './ws';

const log = logger.child('job-manager');

interface RunningTask {
	key: string;
	abortController: AbortController;
	promise: Promise<unknown>;
	startedAt: number;
	timeoutId: ReturnType<typeof setTimeout>;
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
	private guards = new Map<string, boolean>();
	private deps: JobManagerDeps;
	private started = false;

	constructor(deps: JobManagerDeps) {
		this.deps = deps;
		this.cron = new Cron();
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

	cancelTask(key: string): boolean {
		const task = this.runningTasks.get(key);
		if (!task) return false;
		clearTimeout(task.timeoutId);
		task.abortController.abort();
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
		this.cron.shutdown();
		log.info('Job manager stopped.');
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
			if (this.isTaskRunning(`agent:${wakeup.member_id}`)) {
				log.debug(`Skipping wakeup ${wakeup.id} — agent ${wakeup.member_id} already running`);
				continue;
			}

			await db.query(
				'UPDATE agent_wakeup_requests SET status = $1::wakeup_status, claimed_at = now() WHERE id = $2',
				[WakeupStatus.Claimed, wakeup.id],
			);

			try {
				await this.activateAgent(wakeup.member_id, wakeup.company_id, wakeup.id, wakeup.payload);
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
			if (this.isTaskRunning(`agent:${agent.id}`)) {
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
	): Promise<void> {
		const { db, docker, masterKeyManager, serverPort } = this.deps;

		const agent = await db.query<{
			id: string;
			title: string;
			slug: string;
			system_prompt: string;
			admin_status: string;
			heartbeat_interval_min: number;
			default_effort: string;
		}>(
			`SELECT id, title, slug, system_prompt, admin_status, heartbeat_interval_min, default_effort
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
			runtime_type: AgentRuntime | null;
		};

		let issue: IssueRow | undefined;

		// Wakeups with an explicit issue_id (mentions, comments, coach triggers) target
		// that specific issue — even if the agent isn't the assignee.
		const payloadIssueId =
			typeof wakeupPayload?.issue_id === 'string' ? wakeupPayload.issue_id : undefined;
		if (payloadIssueId) {
			const payloadIssue = await db.query<IssueRow>(
				'SELECT id, identifier, title, description, status, priority, project_id, rules, runtime_type FROM issues WHERE id = $1 AND company_id = $2',
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
				`SELECT id, identifier, title, description, status, priority, project_id, rules, runtime_type
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

		if (!projectRow.designated_repo_id && CODE_TOUCHING_AGENT_SLUGS.has(agentSlug)) {
			try {
				const ensured = await ensureRepoSetupAction(db, {
					companyId,
					projectId: projectRow.id,
					issueId: issue.id,
				});
				if (ensured.commentRow) {
					broadcastRowChange(
						this.deps.wsManager,
						`company:${companyId}`,
						'issue_comments',
						'INSERT',
						ensured.commentRow,
					);
				}
				if (ensured.approvalRow) {
					broadcastRowChange(
						this.deps.wsManager,
						`company:${companyId}`,
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
		broadcastRowChange(this.deps.wsManager, `company:${companyId}`, 'member_agents', 'UPDATE', {
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

		this.launchTask(
			`agent:${memberId}`,
			async (signal) => {
				const result = await runAgent(
					deps,
					{
						id: memberId,
						title: agent.rows[0].title,
						system_prompt: agent.rows[0].system_prompt,
						company_id: companyId,
						default_effort: agent.rows[0].default_effort,
					},
					issue,
					project.rows[0],
					wakeupPayload,
					signal,
				);

				await this.onAgentComplete(memberId, issue.id, companyId, wakeupId, result);
				return result;
			},
			timeoutMs,
		);
	}

	private async onAgentComplete(
		memberId: string,
		issueId: string,
		companyId: string,
		wakeupId: string | undefined,
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
		broadcastRowChange(this.deps.wsManager, `company:${companyId}`, 'member_agents', 'UPDATE', {
			id: memberId,
			runtime_status: AgentRuntimeStatus.Idle,
		});

		if (wakeupId) {
			await db.query(
				`UPDATE agent_wakeup_requests SET status = $1::wakeup_status, completed_at = now() WHERE id = $2`,
				[result.success ? WakeupStatus.Completed : WakeupStatus.Failed, wakeupId],
			);
		}
	}

	private async detectOrphanedRuns(): Promise<void> {
		const runningPids = new Set<number>();
		await detectOrphans(this.deps.db, runningPids);
	}

	private async syncContainerStatuses(): Promise<void> {
		await syncAllContainerStatuses(this.deps.db, this.deps.docker, this.deps.wsManager);
	}

	private async processEmbeddingQueue(): Promise<void> {
		const { processPendingEmbeddings } = await import('./embeddings');
		const count = await processPendingEmbeddings(this.deps.db);
		if (count > 0) {
			log.debug(`Processed ${count} embedding(s)`);
		}
	}
}
