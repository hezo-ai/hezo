import {
	AgentAdminStatus,
	AgentRuntimeStatus,
	DEFAULT_TEAM_ID,
	HeartbeatRunKind,
	HeartbeatRunStatus,
	TaskStatus,
	WakeupSkipReason,
	WakeupSource,
	WakeupStatus,
} from '@hezo/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { waitForBackground } from '../src/lib/background';
import { ContainerLogStreamer } from '../src/services/container-logs';
import { JobManager, type JobManagerDeps } from '../src/services/job-manager';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { authHeader, createStubDocker, createTestProject, createTestTeam } from './helpers/app';
import {
	clearContainerCapacityForTest,
	removeSeededContainerProject,
	seedRunningContainerProject,
	setContainerCapacityForTest,
} from './helpers/capacity';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

// The Captain's progress-update ("Run now" / scheduled goal-check) flows:
// tryDispatchProgressUpdate gating in every failure mode, the real launched
// progress-update run (no task, kind=progress_update) and its trimmed
// completion bookkeeping, the manual dispatchProgressUpdateNow route logic
// (terminal reasons vs the queued-wakeup fallback), and activateAgent's
// Captain-heartbeat branch including the progress_update_now guard that must
// never fall through to task selection.

let ctx: ServerTestContext;
let teamId: string;
let projectId: string;
let captainId: string;
let planningTaskId: string;

interface CaptainRow {
	id: string;
	title: string;
	slug: string;
	default_effort: string;
	model_override_provider: null;
	model_override_model: null;
	run_timeout_min: number;
}

interface JmInternals {
	tryDispatchProgressUpdate(
		memberId: string,
		teamId: string,
		agentRow: CaptainRow,
		wakeupId: string | undefined,
		wakeupPayload: Record<string, unknown>,
	): Promise<{ dispatched: boolean; reason?: string }>;
	activateAgent(
		memberId: string,
		teamId: string,
		wakeupId: string | undefined,
		payload: Record<string, unknown>,
		source: string,
	): Promise<void>;
	activeProjectRuns: Map<string, number>;
}

const internals = (m: JobManager) => m as unknown as JmInternals;

function createJobManager(overrides: Partial<JobManagerDeps> = {}): JobManager {
	return new JobManager({
		db: ctx.db,
		docker: createStubDocker(),
		masterKeyManager: ctx.masterKeyManager,
		serverPort: ctx.port,
		dataDir: ctx.dataDir,
		wsManager: { broadcast: () => {} } as unknown as JobManagerDeps['wsManager'],
		logs: new LogStreamBroker(),
		containerLogStreamer: new ContainerLogStreamer(),
		...overrides,
	});
}

beforeAll(async () => {
	ctx = await createTestContext();
	const { app, db, token } = ctx;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Progress JM Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Progress JM Project',
		description: 'Progress-update coverage project.',
	});
	const project = (await projectRes.json()).data;
	projectId = project.id;
	planningTaskId = project.planning_task_id as string;

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain' LIMIT 1`,
		[teamId],
	);
	captainId = captain.rows[0].id;

	await db.query(
		`UPDATE projects SET container_id = 'progress-box', container_status = 'running'
		 WHERE id = $1`,
		[projectId],
	);
	await waitForBackground();
	await db.query('DELETE FROM agent_wakeup_requests WHERE team_id = $1', [teamId]);
});

afterEach(async () => {
	await waitForBackground();
	await ctx.db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [captainId]);
	await ctx.db.query('DELETE FROM heartbeat_runs WHERE member_id = $1', [captainId]);
	await ctx.db.query('DELETE FROM goals WHERE project_id = $1', [projectId]);
	await ctx.db.query('DELETE FROM cost_entries WHERE member_id = $1', [captainId]);
	await ctx.db.query(
		`UPDATE member_agents SET runtime_status = $1::agent_runtime_status,
		        admin_status = 'enabled', daily_budget_cents = 0, slug = 'captain',
		        last_heartbeat_at = now()
		 WHERE id = $2`,
		[AgentRuntimeStatus.Idle, captainId],
	);
	await ctx.db.query(
		`UPDATE projects SET container_id = 'progress-box', container_status = 'running'
		 WHERE id = $1`,
		[projectId],
	);
	await ctx.db.query('UPDATE execution_locks SET released_at = now() WHERE released_at IS NULL');
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

async function captainRow(): Promise<CaptainRow> {
	const r = await ctx.db.query<CaptainRow>(
		`SELECT id, title, slug, default_effort, run_timeout_min,
		        model_override_provider, model_override_model
		 FROM member_agents WHERE id = $1`,
		[captainId],
	);
	return r.rows[0];
}

async function insertDueGoal(title: string): Promise<string> {
	const r = await ctx.db.query<{ id: string }>(
		`INSERT INTO goals (team_id, project_id, title, measurement, actions, check_frequency)
		 VALUES ($1, $2, $3, 'measure it', 'act on it', 'daily'::goal_check_frequency)
		 RETURNING id`,
		[teamId, projectId, title],
	);
	return r.rows[0].id;
}

async function insertClaimedWakeup(payload: Record<string, unknown>): Promise<string> {
	const r = await ctx.db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, claimed_at, created_at)
		 VALUES ($1, $2, $3::wakeup_source, 'claimed'::wakeup_status, $4::jsonb, now(), now() - interval '30 seconds')
		 RETURNING id`,
		[captainId, teamId, WakeupSource.Heartbeat, JSON.stringify(payload)],
	);
	return r.rows[0].id;
}

async function wakeupRow(id: string): Promise<{
	status: string;
	claimed_at: string | null;
	last_skipped_reason: string | null;
	completed_at: string | null;
}> {
	const r = await ctx.db.query<{
		status: string;
		claimed_at: string | null;
		last_skipped_reason: string | null;
		completed_at: string | null;
	}>(
		`SELECT status::text AS status, claimed_at, last_skipped_reason, completed_at
		 FROM agent_wakeup_requests WHERE id = $1`,
		[id],
	);
	return r.rows[0];
}

describe('JobManager progress-update flows', () => {
	describe('tryDispatchProgressUpdate gating', () => {
		it('returns no_project when the team has no non-internal project', async () => {
			const manager = createJobManager();
			// HQ (the default team) only has the internal project.
			const result = await internals(manager).tryDispatchProgressUpdate(
				captainId,
				DEFAULT_TEAM_ID,
				await captainRow(),
				undefined,
				{},
			);
			expect(result).toEqual({ dispatched: false, reason: 'no_project' });
			manager.shutdown();
		});

		// On the scheduled path a run is due when a goal is due OR the Progress page has gone
		// stale with work having happened since. A fresh project with no goals and no tasks is
		// neither, so nothing dispatches.
		it('returns not_due when neither a goal nor the Progress page needs a refresh', async () => {
			const manager = createJobManager();
			const result = await internals(manager).tryDispatchProgressUpdate(
				captainId,
				teamId,
				await captainRow(),
				undefined,
				{},
			);
			expect(result).toEqual({ dispatched: false, reason: 'not_due' });
			manager.shutdown();
		});

		// Goals are not a dependency of progress: a project that has never set one still gets its
		// Progress page rebuilt once the snapshot is stale and a task has moved since.
		it('is due with no goals at all once the snapshot is stale and a task has moved', async () => {
			const manager = createJobManager();
			// Snapshot written two days ago; a task has moved since.
			await ctx.db.query(
				`UPDATE projects SET progress_summary_updated_at = now() - interval '2 days' WHERE id = $1`,
				[projectId],
			);
			await ctx.db.query(
				`INSERT INTO tasks (team_id, project_id, number, identifier, title)
				 VALUES ($1, $2, 9001, 'PU-9001', 'Some work')`,
				[teamId, projectId],
			);
			const goals = await ctx.db.query<{ c: number }>(
				`SELECT COUNT(*)::int AS c FROM goals WHERE project_id = $1`,
				[projectId],
			);
			expect(goals.rows[0].c).toBe(0);

			const result = await internals(manager).tryDispatchProgressUpdate(
				captainId,
				teamId,
				await captainRow(),
				undefined,
				{},
			);
			// Past the due-check: it reaches run-gating rather than short-circuiting as not_due.
			expect(result.dispatched === false && result.reason === 'not_due').toBe(false);
			manager.shutdown();
		});

		// A run that ended without calling update_project_progress leaves the page stale. If the
		// cadence were anchored only on the write, the very next heartbeat would dispatch again,
		// and again — a Captain run every few seconds. The run itself has to hold the anchor.
		it('is not due again straight after a progress run that wrote nothing', async () => {
			const manager = createJobManager();
			await ctx.db.query(
				`UPDATE projects SET progress_summary_updated_at = now() - interval '30 days' WHERE id = $1`,
				[projectId],
			);
			await ctx.db.query(
				`INSERT INTO tasks (team_id, project_id, number, identifier, title)
				 VALUES ($1, $2, 9002, 'PU-9002', 'Recent work')`,
				[teamId, projectId],
			);
			// A progress-update run just happened and wrote nothing.
			await ctx.db.query(
				`INSERT INTO heartbeat_runs (team_id, member_id, kind, status, started_at)
				 VALUES ($1, $2, 'progress_update'::heartbeat_run_kind,
				         'succeeded'::heartbeat_run_status, now())`,
				[teamId, captainId],
			);

			const result = await internals(manager).tryDispatchProgressUpdate(
				captainId,
				teamId,
				await captainRow(),
				undefined,
				{},
			);
			expect(result).toEqual({ dispatched: false, reason: 'not_due' });
			manager.shutdown();
		});

		// The activity guard: stale alone is not enough, or a dormant project would burn a
		// Captain run every day rewriting an identical summary.
		it('is not due when the snapshot is stale but nothing has moved since', async () => {
			const manager = createJobManager();
			await ctx.db.query(`UPDATE projects SET progress_summary_updated_at = now() WHERE id = $1`, [
				projectId,
			]);
			const result = await internals(manager).tryDispatchProgressUpdate(
				captainId,
				teamId,
				await captainRow(),
				undefined,
				{},
			);
			expect(result).toEqual({ dispatched: false, reason: 'not_due' });
			manager.shutdown();
		});

		it('returns agent_busy while the Captain already runs in the project', async () => {
			const manager = createJobManager();
			await insertDueGoal('Busy captain goal');
			manager.launchTask(
				`${captainId}:${projectId}`,
				(signal) =>
					new Promise<void>((resolve) => {
						signal.addEventListener('abort', () => resolve());
					}),
				60_000,
			);
			const result = await internals(manager).tryDispatchProgressUpdate(
				captainId,
				teamId,
				await captainRow(),
				undefined,
				{},
			);
			expect(result).toEqual({ dispatched: false, reason: 'agent_busy' });
			manager.shutdown();
		});

		it('returns instance_at_capacity when starting the container would exceed the limit', async () => {
			const manager = createJobManager();
			await insertDueGoal('Capacity goal');
			// Container semantics: the Captain's project container is stopped and a
			// filler project's running container holds the single slot.
			await setContainerCapacityForTest(ctx.db, 1);
			await ctx.db.query(`UPDATE projects SET container_status = 'stopped' WHERE id = $1`, [
				projectId,
			]);
			await seedRunningContainerProject(ctx.db, 'cap-filler-progress');
			const result = await internals(manager).tryDispatchProgressUpdate(
				captainId,
				teamId,
				await captainRow(),
				undefined,
				{},
			);
			expect(result).toEqual({ dispatched: false, reason: 'instance_at_capacity' });
			await removeSeededContainerProject(ctx.db, 'cap-filler-progress');
			await clearContainerCapacityForTest(ctx.db);
			manager.shutdown();
		});

		it('a missing container no longer blocks dispatch — the budget gate is reached', async () => {
			const manager = createJobManager();
			await insertDueGoal('Container-down goal');
			// The old code returned container_down here before ever checking the
			// budget; with lazy-start there is no container gate, so the (later)
			// budget gate must be what fires.
			await ctx.db.query(
				'UPDATE projects SET container_id = NULL, container_status = NULL WHERE id = $1',
				[projectId],
			);
			await ctx.db.query('UPDATE member_agents SET daily_budget_cents = 100 WHERE id = $1', [
				captainId,
			]);
			await ctx.db.query(
				'INSERT INTO cost_entries (member_id, project_id, amount_cents) VALUES ($1, $2, 500)',
				[captainId, projectId],
			);
			const result = await internals(manager).tryDispatchProgressUpdate(
				captainId,
				teamId,
				await captainRow(),
				undefined,
				{},
			);
			expect(result).toEqual({ dispatched: false, reason: 'over_budget' });
			manager.shutdown();
		});

		it('returns over_budget when the Captain has breached a budget window', async () => {
			const manager = createJobManager();
			await insertDueGoal('Over-budget goal');
			await ctx.db.query('UPDATE member_agents SET daily_budget_cents = 100 WHERE id = $1', [
				captainId,
			]);
			await ctx.db.query(
				'INSERT INTO cost_entries (member_id, project_id, amount_cents) VALUES ($1, $2, 500)',
				[captainId, projectId],
			);
			const result = await internals(manager).tryDispatchProgressUpdate(
				captainId,
				teamId,
				await captainRow(),
				undefined,
				{},
			);
			expect(result).toEqual({ dispatched: false, reason: 'over_budget' });
			manager.shutdown();
		});
	});

	describe('dispatchProgressUpdateNow', () => {
		it('returns no_project for an unknown project id', async () => {
			const manager = createJobManager();
			const result = await manager.dispatchProgressUpdateNow(
				'00000000-0000-0000-0000-0000000000cc',
			);
			expect(result).toEqual({ dispatched: false, reason: 'no_project' });
			manager.shutdown();
		});

		it('returns no_captain when the team has no captain-slug agent', async () => {
			const manager = createJobManager();
			await ctx.db.query("UPDATE member_agents SET slug = 'skipper' WHERE id = $1", [captainId]);
			const result = await manager.dispatchProgressUpdateNow(projectId);
			expect(result).toEqual({ dispatched: false, reason: 'no_captain' });
			await ctx.db.query("UPDATE member_agents SET slug = 'captain' WHERE id = $1", [captainId]);
			manager.shutdown();
		});

		it('returns captain_disabled when the Captain is administratively disabled', async () => {
			const manager = createJobManager();
			await ctx.db.query('UPDATE member_agents SET admin_status = $1 WHERE id = $2', [
				AgentAdminStatus.Disabled,
				captainId,
			]);
			const result = await manager.dispatchProgressUpdateNow(projectId);
			expect(result).toEqual({ dispatched: false, reason: 'captain_disabled' });
			manager.shutdown();
		});

		// "Run now" is explicit human intent, so it skips the due-check entirely: it dispatches
		// with no goals and a freshly-written snapshot, where the scheduled path would say not_due.
		it('dispatches with no goals and nothing stale, because the button bypasses the due-check', async () => {
			const manager = createJobManager();
			await ctx.db.query(`UPDATE projects SET progress_summary_updated_at = now() WHERE id = $1`, [
				projectId,
			]);
			const result = await manager.dispatchProgressUpdateNow(projectId);
			// `'dispatched' in result` alone still admits the `{dispatched: true}`
			// variant, which carries no `reason` - so compare the whole shape, which
			// is also what the assertion actually means: this is not a not-due skip.
			expect(result).not.toEqual({ dispatched: false, reason: 'not_due' });
			manager.shutdown();
		});

		it('queues a retry wakeup on a transient conflict (Captain busy) and broadcasts it', async () => {
			const broadcasts: Array<{ table: string; row?: Record<string, unknown> }> = [];
			const manager = createJobManager({
				wsManager: {
					broadcast: (_room: string, msg: { table: string }) => broadcasts.push(msg),
				} as unknown as JobManagerDeps['wsManager'],
			});
			await insertDueGoal('Queued run goal');
			manager.launchTask(
				`${captainId}:${projectId}`,
				(signal) =>
					new Promise<void>((resolve) => {
						signal.addEventListener('abort', () => resolve());
					}),
				60_000,
			);

			const result = await manager.dispatchProgressUpdateNow(projectId, {
				member_id: 'admin-member',
				name: 'Admin',
			});
			expect('queued' in result && result.queued).toBe(true);
			const wakeupId = (result as { queued: true; wakeupId: string }).wakeupId;

			const row = await ctx.db.query<{ payload: Record<string, unknown>; status: string }>(
				'SELECT payload, status::text AS status FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(row.rows[0].status).toBe(WakeupStatus.Queued);
			expect(row.rows[0].payload.trigger).toBe('progress_update_now');
			expect(broadcasts.some((b) => b.table === 'agent_wakeup_requests')).toBe(true);
			manager.shutdown();
		});

		it('launches the progress-update run when the Captain is free and settles idle after it', async () => {
			const manager = createJobManager();
			await insertDueGoal('Launchable goal');

			const result = await manager.dispatchProgressUpdateNow(projectId);
			expect(result).toEqual({ dispatched: true });

			// The status flip happened synchronously.
			const active = await ctx.db.query<{ runtime_status: string }>(
				'SELECT runtime_status FROM member_agents WHERE id = $1',
				[captainId],
			);
			expect(active.rows[0].runtime_status).toBe(AgentRuntimeStatus.Active);

			// The run executes for real (and fails on the missing AI provider);
			// completion bookkeeping returns the Captain to idle.
			await waitForBackground();
			const run = await ctx.db.query<{ kind: string; task_id: string | null; status: string }>(
				`SELECT kind::text AS kind, task_id, status::text AS status
				 FROM heartbeat_runs WHERE member_id = $1 ORDER BY started_at DESC LIMIT 1`,
				[captainId],
			);
			expect(run.rows[0].kind).toBe(HeartbeatRunKind.ProgressUpdate);
			expect(run.rows[0].task_id).toBeNull();
			expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);

			const idle = await ctx.db.query<{ runtime_status: string }>(
				'SELECT runtime_status FROM member_agents WHERE id = $1',
				[captainId],
			);
			expect(idle.rows[0].runtime_status).toBe(AgentRuntimeStatus.Idle);
			expect(internals(manager).activeProjectRuns.has(projectId)).toBe(false);
			manager.shutdown();
		});

		it('runs the trimmed completion bookkeeping when the progress-update run itself throws', async () => {
			// A log broker whose begin() throws makes runAgent throw outside its own
			// try/catch — the launch closure's error path must idle the Captain and
			// release the project refcount.
			const throwingLogs = new LogStreamBroker();
			throwingLogs.begin = () => {
				throw new Error('expected: progress stream failure');
			};
			const manager = createJobManager({ logs: throwingLogs });
			await insertDueGoal('Throwing run goal');

			const result = await manager.dispatchProgressUpdateNow(projectId);
			expect(result).toEqual({ dispatched: true });
			await waitForBackground();

			const idle = await ctx.db.query<{ runtime_status: string }>(
				'SELECT runtime_status FROM member_agents WHERE id = $1',
				[captainId],
			);
			expect(idle.rows[0].runtime_status).toBe(AgentRuntimeStatus.Idle);
			expect(internals(manager).activeProjectRuns.has(projectId)).toBe(false);
			expect(manager.isTaskRunning(`progressupdate:${captainId}:${projectId}`)).toBe(false);
			manager.shutdown();
		});
	});

	describe('activateAgent Captain-heartbeat branch', () => {
		it('runs a progress update from a scheduled heartbeat and resolves the wakeup from the run result', async () => {
			const manager = createJobManager();
			await insertDueGoal('Scheduled goal');
			const wakeupId = await insertClaimedWakeup({ reason: 'scheduled_heartbeat' });

			await internals(manager).activateAgent(captainId, teamId, wakeupId, {}, 'heartbeat');
			await waitForBackground();

			const run = await ctx.db.query<{ kind: string }>(
				'SELECT kind::text AS kind FROM heartbeat_runs WHERE member_id = $1',
				[captainId],
			);
			expect(run.rows.length).toBe(1);
			expect(run.rows[0].kind).toBe(HeartbeatRunKind.ProgressUpdate);

			// onProgressUpdateComplete resolved the driving wakeup (run failed → failed).
			const w = await wakeupRow(wakeupId);
			expect(w.status).toBe(WakeupStatus.Failed);
			expect(w.completed_at).not.toBeNull();
			manager.shutdown();
		});

		it('re-queues a claimed heartbeat wakeup on a progress-update launch conflict', async () => {
			const manager = createJobManager();
			await insertDueGoal('Conflict goal');
			// Occupy the progress-update launch key: the Captain per-project key is
			// free, so the conflict only surfaces at launchTask.
			manager.launchTask(
				`progressupdate:${captainId}:${projectId}`,
				(signal) =>
					new Promise<void>((resolve) => {
						signal.addEventListener('abort', () => resolve());
					}),
				60_000,
			);
			const wakeupId = await insertClaimedWakeup({ reason: 'scheduled_heartbeat' });

			await internals(manager).activateAgent(captainId, teamId, wakeupId, {}, 'heartbeat');

			const w = await wakeupRow(wakeupId);
			expect(w.status).toBe(WakeupStatus.Queued);
			expect(w.claimed_at).toBeNull();
			// No run started, the Captain is back to idle.
			const runs = await ctx.db.query('SELECT 1 FROM heartbeat_runs WHERE member_id = $1', [
				captainId,
			]);
			expect(runs.rows.length).toBe(0);
			const agent = await ctx.db.query<{ runtime_status: string }>(
				'SELECT runtime_status FROM member_agents WHERE id = $1',
				[captainId],
			);
			expect(agent.rows[0].runtime_status).toBe(AgentRuntimeStatus.Idle);
			manager.shutdown();
		});

		it('re-queues a manual progress_update_now wakeup while the Captain is busy (agent_running skip)', async () => {
			const manager = createJobManager();
			await insertDueGoal('Manual busy goal');
			manager.launchTask(
				`${captainId}:${projectId}`,
				(signal) =>
					new Promise<void>((resolve) => {
						signal.addEventListener('abort', () => resolve());
					}),
				60_000,
			);
			const wakeupId = await insertClaimedWakeup({ trigger: 'progress_update_now' });

			await internals(manager).activateAgent(
				captainId,
				teamId,
				wakeupId,
				{ trigger: 'progress_update_now' },
				'on_demand',
			);

			const w = await wakeupRow(wakeupId);
			expect(w.status).toBe(WakeupStatus.Queued);
			expect(w.last_skipped_reason).toBe(WakeupSkipReason.AgentRunning);
			manager.shutdown();
		});

		it('re-queues a manual progress_update_now wakeup while the container limit is reached', async () => {
			const manager = createJobManager();
			await insertDueGoal('Manual capacity goal');
			await setContainerCapacityForTest(ctx.db, 1);
			await ctx.db.query(`UPDATE projects SET container_status = 'stopped' WHERE id = $1`, [
				projectId,
			]);
			await seedRunningContainerProject(ctx.db, 'cap-filler-manual');
			const wakeupId = await insertClaimedWakeup({ trigger: 'progress_update_now' });

			await internals(manager).activateAgent(
				captainId,
				teamId,
				wakeupId,
				{ trigger: 'progress_update_now' },
				'on_demand',
			);

			const w = await wakeupRow(wakeupId);
			expect(w.status).toBe(WakeupStatus.Queued);
			expect(w.last_skipped_reason).toBe(WakeupSkipReason.InstanceAtCapacity);
			// It must NOT have fallen through to task selection.
			const runs = await ctx.db.query('SELECT 1 FROM heartbeat_runs WHERE member_id = $1', [
				captainId,
			]);
			expect(runs.rows.length).toBe(0);
			await removeSeededContainerProject(ctx.db, 'cap-filler-manual');
			await clearContainerCapacityForTest(ctx.db);
			manager.shutdown();
		});

		it('completes a container-down manual progress_update_now via the budget gate, never task selection', async () => {
			const manager = createJobManager();
			await insertDueGoal('Manual transient goal');
			// Container down is no longer a transient requeue reason — the runner
			// lazy-starts containers. Prove the gate is gone with a terminal budget
			// outcome (which completes the wakeup as a no-op), and that a manual
			// progress wakeup still never falls through to task selection.
			await ctx.db.query(
				'UPDATE projects SET container_id = NULL, container_status = NULL WHERE id = $1',
				[projectId],
			);
			await ctx.db.query('UPDATE member_agents SET daily_budget_cents = 100 WHERE id = $1', [
				captainId,
			]);
			await ctx.db.query(
				'INSERT INTO cost_entries (member_id, project_id, amount_cents) VALUES ($1, $2, 500)',
				[captainId, projectId],
			);
			const wakeupId = await insertClaimedWakeup({ trigger: 'progress_update_now' });

			await internals(manager).activateAgent(
				captainId,
				teamId,
				wakeupId,
				{ trigger: 'progress_update_now' },
				'on_demand',
			);

			const w = await wakeupRow(wakeupId);
			expect(w.status).toBe(WakeupStatus.Completed);
			// It must NOT have fallen through to task selection.
			const runs = await ctx.db.query('SELECT 1 FROM heartbeat_runs WHERE member_id = $1', [
				captainId,
			]);
			expect(runs.rows.length).toBe(0);
			manager.shutdown();
		});

		it('completes a manual progress_update_now wakeup as a no-op when nothing is due', async () => {
			const manager = createJobManager();
			// No goals, and a fresh project's snapshot anchors to its creation → terminal not_due.
			const wakeupId = await insertClaimedWakeup({ trigger: 'progress_update_now' });

			await internals(manager).activateAgent(
				captainId,
				teamId,
				wakeupId,
				{ trigger: 'progress_update_now' },
				'on_demand',
			);

			const w = await wakeupRow(wakeupId);
			expect(w.status).toBe(WakeupStatus.Completed);
			expect(w.completed_at).not.toBeNull();
			const runs = await ctx.db.query('SELECT 1 FROM heartbeat_runs WHERE member_id = $1', [
				captainId,
			]);
			expect(runs.rows.length).toBe(0);
			manager.shutdown();
		});

		// A brand-new project must get on with its planning task, not a progress update: the
		// never-written snapshot anchors to the project's creation, so it is not yet stale.
		it('falls through to task selection when nothing is due, dispatching the planning task', async () => {
			const manager = createJobManager();
			// Unblock the planning task (a fresh team blocks it on the CEO's
			// coherence pass) and bypass the repo gate for the Captain.
			await ctx.db.query(
				`UPDATE tasks SET status = $1::task_status
				 WHERE id IN (SELECT blocked_by_task_id FROM task_dependencies WHERE task_id = $2)`,
				[TaskStatus.Done, planningTaskId],
			);
			await ctx.db.query('UPDATE member_agents SET touches_code = false WHERE id = $1', [
				captainId,
			]);
			const wakeupId = await insertClaimedWakeup({ reason: 'scheduled_heartbeat' });

			await internals(manager).activateAgent(captainId, teamId, wakeupId, {}, 'heartbeat');
			await waitForBackground();

			const run = await ctx.db.query<{ task_id: string | null; kind: string }>(
				'SELECT task_id, kind::text AS kind FROM heartbeat_runs WHERE member_id = $1',
				[captainId],
			);
			expect(run.rows.length).toBe(1);
			expect(run.rows[0].task_id).toBe(planningTaskId);
			expect(run.rows[0].kind).toBe(HeartbeatRunKind.Task);
			manager.shutdown();
		});

		it('completes the wakeup and stamps last_heartbeat_at when no goals are due and no task is actionable', async () => {
			const manager = createJobManager();
			// Re-block the planning task behind a fresh open blocker so the Captain
			// has no actionable work.
			const blocker = await ctx.db.query<{ id: string }>(
				`INSERT INTO tasks (team_id, project_id, number, identifier, title, description, status, priority, labels)
				 SELECT $1, $2, next_project_task_number($2), p.task_prefix || '-' || next_project_task_number($2),
				        'Progress blocker', '', 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb
				 FROM projects p WHERE p.id = $2
				 RETURNING id`,
				[teamId, projectId],
			);
			await ctx.db.query(
				'INSERT INTO task_dependencies (task_id, blocked_by_task_id) VALUES ($1, $2)',
				[planningTaskId, blocker.rows[0].id],
			);
			await ctx.db.query('UPDATE member_agents SET last_heartbeat_at = NULL WHERE id = $1', [
				captainId,
			]);
			const wakeupId = await insertClaimedWakeup({ reason: 'scheduled_heartbeat' });

			await internals(manager).activateAgent(captainId, teamId, wakeupId, {}, 'heartbeat');

			const w = await wakeupRow(wakeupId);
			expect(w.status).toBe(WakeupStatus.Completed);
			const agent = await ctx.db.query<{ last_heartbeat_at: string | null }>(
				'SELECT last_heartbeat_at FROM member_agents WHERE id = $1',
				[captainId],
			);
			expect(agent.rows[0].last_heartbeat_at).not.toBeNull();
			const runs = await ctx.db.query('SELECT 1 FROM heartbeat_runs WHERE member_id = $1', [
				captainId,
			]);
			expect(runs.rows.length).toBe(0);

			await ctx.db.query('DELETE FROM task_dependencies WHERE task_id = $1', [planningTaskId]);
			await ctx.db.query('DELETE FROM tasks WHERE id = $1', [blocker.rows[0].id]);
			manager.shutdown();
		});
	});
});
