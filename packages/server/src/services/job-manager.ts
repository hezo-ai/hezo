import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	AgentRuntimeStatus,
	IssuePriority,
	TERMINAL_ISSUE_STATUSES,
	WakeupStatus,
} from '@hezo/shared';
import { Cron } from 'cron-async';
import type { MasterKeyManager } from '../crypto/master-key';
import { type RunnerDeps, type RunResult, runAgent } from './agent-runner';
import { syncAllContainerStatuses } from './containers';
import type { DockerClient } from './docker';
import { detectOrphans } from './orphan-detector';
import type { WebSocketManager } from './ws';

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
}

const COALESCING_WINDOW_MS = 10_000;

export class JobManager {
	private cron: Cron;
	private runningTasks = new Map<string, RunningTask>();
	private guards = new Map<string, boolean>();
	private deps: JobManagerDeps;

	constructor(deps: JobManagerDeps) {
		this.deps = deps;
		this.cron = new Cron();
	}

	start(): void {
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
		console.log('Job manager started.');
	}

	launchTask(key: string, fn: (signal: AbortSignal) => Promise<unknown>, timeoutMs: number): void {
		if (this.runningTasks.has(key)) return;
		const ac = new AbortController();

		const timeoutId = setTimeout(() => {
			console.warn(`Task ${key} timed out after ${timeoutMs}ms`);
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
		console.log('Job manager stopped.');
	}

	private async guarded(name: string, fn: () => Promise<void>): Promise<void> {
		if (this.guards.get(name)) return;
		this.guards.set(name, true);
		try {
			await fn();
		} catch (error) {
			console.error(`Job ${name} error:`, error);
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

		for (const wakeup of wakeups.rows) {
			if (this.isTaskRunning(`agent:${wakeup.member_id}`)) {
				continue;
			}

			await db.query(
				'UPDATE agent_wakeup_requests SET status = $1::wakeup_status, claimed_at = now() WHERE id = $2',
				[WakeupStatus.Claimed, wakeup.id],
			);

			await this.activateAgent(wakeup.member_id, wakeup.company_id, wakeup.id, wakeup.payload);
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
			system_prompt: string;
			admin_status: string;
			heartbeat_interval_min: number;
		}>(
			`SELECT id, title, system_prompt, admin_status, heartbeat_interval_min FROM member_agents WHERE id = $1`,
			[memberId],
		);

		if (agent.rows.length === 0 || agent.rows[0].admin_status !== AgentAdminStatus.Enabled) {
			if (wakeupId) {
				await db.query(
					'UPDATE agent_wakeup_requests SET status = $1::wakeup_status WHERE id = $2',
					[WakeupStatus.Skipped, wakeupId],
				);
			}
			return;
		}

		const issues = await db.query<{
			id: string;
			identifier: string;
			title: string;
			description: string;
			status: string;
			priority: string;
			project_id: string;
			rules: string | null;
		}>(
			`SELECT id, identifier, title, description, status, priority, project_id, rules
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

		let issue: {
			id: string;
			identifier: string;
			title: string;
			description: string;
			status: string;
			priority: string;
			project_id: string;
			rules: string | null;
		};

		if (issues.rows.length === 0) {
			// Coach agent may have no assigned issues but is woken by issue_done automation
			if (wakeupPayload?.trigger === 'issue_done' && wakeupPayload?.issue_id) {
				const payloadIssue = await db.query<{
					id: string;
					identifier: string;
					title: string;
					description: string;
					status: string;
					priority: string;
					project_id: string;
					rules: string | null;
				}>(
					'SELECT id, identifier, title, description, status, priority, project_id, rules FROM issues WHERE id = $1 AND company_id = $2',
					[wakeupPayload.issue_id, companyId],
				);
				if (payloadIssue.rows.length === 0) {
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
				if (wakeupId) {
					await db.query(
						`UPDATE agent_wakeup_requests SET status = $1::wakeup_status, completed_at = now() WHERE id = $2`,
						[WakeupStatus.Completed, wakeupId],
					);
				}
				return;
			}
		} else {
			issue = issues.rows[0];
		}

		const project = await db.query<{
			id: string;
			slug: string;
			container_id: string;
			container_status: string;
		}>('SELECT id, slug, container_id, container_status FROM projects WHERE id = $1', [
			issue.project_id,
		]);

		if (project.rows.length === 0 || !project.rows[0].container_id) {
			if (wakeupId) {
				await db.query(
					'UPDATE agent_wakeup_requests SET status = $1::wakeup_status WHERE id = $2',
					[WakeupStatus.Failed, wakeupId],
				);
			}
			return;
		}

		await db.query(
			`INSERT INTO execution_locks (issue_id, member_id)
			 VALUES ($1, $2)
			 ON CONFLICT DO NOTHING`,
			[issue.id, memberId],
		);

		const deps: RunnerDeps = {
			db,
			docker,
			masterKeyManager,
			serverPort,
			dataDir: this.deps.dataDir,
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
		_companyId: string,
		wakeupId: string | undefined,
		result: RunResult,
	): Promise<void> {
		const { db } = this.deps;

		await db.query(
			'UPDATE execution_locks SET released_at = now() WHERE issue_id = $1 AND member_id = $2 AND released_at IS NULL',
			[issueId, memberId],
		);

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
}
