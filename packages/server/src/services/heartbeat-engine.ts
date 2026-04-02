import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	AgentRuntimeStatus,
	IssuePriority,
	TERMINAL_ISSUE_STATUSES,
	WakeupStatus,
} from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import { type RunnerDeps, type RunResult, runAgent } from './agent-runner';
import type { DockerClient } from './docker';
import { detectOrphans } from './orphan-detector';

const TICK_INTERVAL_MS = 5_000;
const COALESCING_WINDOW_MS = 10_000;

interface RunningProcess {
	memberId: string;
	issueId: string | null;
	startedAt: number;
	promise: Promise<RunResult>;
}

export class HeartbeatEngine {
	private db: PGlite;
	private docker: DockerClient;
	private masterKeyManager: MasterKeyManager;
	private serverPort: number;
	private intervalId: ReturnType<typeof setInterval> | null = null;
	private running = new Map<string, RunningProcess>();
	private ticking = false;

	constructor(deps: {
		db: PGlite;
		docker: DockerClient;
		masterKeyManager: MasterKeyManager;
		serverPort: number;
	}) {
		this.db = deps.db;
		this.docker = deps.docker;
		this.masterKeyManager = deps.masterKeyManager;
		this.serverPort = deps.serverPort;
	}

	start(): void {
		if (this.intervalId) return;
		this.intervalId = setInterval(() => this.tick(), TICK_INTERVAL_MS);
		console.log('Heartbeat engine started.');
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
		console.log('Heartbeat engine stopped.');
	}

	isRunning(): boolean {
		return this.intervalId !== null;
	}

	getRunningAgents(): Map<string, RunningProcess> {
		return new Map(this.running);
	}

	private async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;

		try {
			await this.processWakeups();
			await this.processScheduledHeartbeats();
			await this.detectOrphanedRuns();
		} catch (error) {
			console.error('Heartbeat tick error:', error);
		} finally {
			this.ticking = false;
		}
	}

	private async processWakeups(): Promise<void> {
		const coalescingCutoff = new Date(Date.now() - COALESCING_WINDOW_MS).toISOString();

		const wakeups = await this.db.query<{
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
			if (this.running.has(wakeup.member_id)) {
				continue;
			}

			await this.db.query(
				'UPDATE agent_wakeup_requests SET status = $1::wakeup_status, claimed_at = now() WHERE id = $2',
				[WakeupStatus.Claimed, wakeup.id],
			);

			await this.activateAgent(wakeup.member_id, wakeup.company_id, wakeup.id);
		}
	}

	private async processScheduledHeartbeats(): Promise<void> {
		const dueAgents = await this.db.query<{
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
			if (this.running.has(agent.id)) {
				continue;
			}

			await this.activateAgent(agent.id, agent.company_id);
		}
	}

	private async activateAgent(
		memberId: string,
		companyId: string,
		wakeupId?: string,
	): Promise<void> {
		const agent = await this.db.query<{
			id: string;
			title: string;
			system_prompt: string;
			admin_status: string;
		}>(`SELECT id, title, system_prompt, admin_status FROM member_agents WHERE id = $1`, [
			memberId,
		]);

		if (agent.rows.length === 0 || agent.rows[0].admin_status !== AgentAdminStatus.Enabled) {
			if (wakeupId) {
				await this.db.query(
					'UPDATE agent_wakeup_requests SET status = $1::wakeup_status WHERE id = $2',
					[WakeupStatus.Skipped, wakeupId],
				);
			}
			return;
		}

		const issues = await this.db.query<{
			id: string;
			identifier: string;
			title: string;
			description: string;
			status: string;
			priority: string;
			project_id: string;
		}>(
			`SELECT id, identifier, title, description, status, priority, project_id
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
			if (wakeupId) {
				await this.db.query(
					'UPDATE agent_wakeup_requests SET status = $1::wakeup_status, completed_at = now() WHERE id = $2',
					[WakeupStatus.Completed, wakeupId],
				);
			}
			return;
		}

		const issue = issues.rows[0];

		const project = await this.db.query<{
			id: string;
			slug: string;
			container_id: string;
			container_status: string;
		}>('SELECT id, slug, container_id, container_status FROM projects WHERE id = $1', [
			issue.project_id,
		]);

		if (project.rows.length === 0 || !project.rows[0].container_id) {
			if (wakeupId) {
				await this.db.query(
					'UPDATE agent_wakeup_requests SET status = $1::wakeup_status WHERE id = $2',
					[WakeupStatus.Failed, wakeupId],
				);
			}
			return;
		}

		await this.db.query(
			`INSERT INTO execution_locks (issue_id, member_id)
			 VALUES ($1, $2)
			 ON CONFLICT DO NOTHING`,
			[issue.id, memberId],
		);

		const deps: RunnerDeps = {
			db: this.db,
			docker: this.docker,
			masterKeyManager: this.masterKeyManager,
			serverPort: this.serverPort,
		};

		const promise = runAgent(
			deps,
			{
				id: memberId,
				title: agent.rows[0].title,
				system_prompt: agent.rows[0].system_prompt,
				company_id: companyId,
			},
			issue,
			project.rows[0],
		);

		this.running.set(memberId, {
			memberId,
			issueId: issue.id,
			startedAt: Date.now(),
			promise,
		});

		promise
			.then(async (result) => {
				this.running.delete(memberId);

				await this.db.query(
					'UPDATE execution_locks SET released_at = now() WHERE issue_id = $1 AND member_id = $2 AND released_at IS NULL',
					[issue.id, memberId],
				);

				if (wakeupId) {
					await this.db.query(
						`UPDATE agent_wakeup_requests SET status = $1::wakeup_status, completed_at = now() WHERE id = $2`,
						[result.success ? WakeupStatus.Completed : WakeupStatus.Failed, wakeupId],
					);
				}
			})
			.catch((error) => {
				this.running.delete(memberId);
				console.error(`Agent ${memberId} execution error:`, error);
			});
	}

	private async detectOrphanedRuns(): Promise<void> {
		const runningPids = new Set<number>();
		await detectOrphans(this.db, runningPids);
	}
}
