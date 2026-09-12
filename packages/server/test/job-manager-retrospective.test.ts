import { HeartbeatRunKind, HeartbeatRunStatus, TaskStatus } from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ContainerLogStreamer } from '../src/services/container-logs';
import { JobManager, type JobManagerDeps } from '../src/services/job-manager';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { authHeader, createStubDocker, createTestProject, createTestTeam } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

// The cadence half of the Coach's retrospective. The two properties that matter are
// the ones a naive due-check gets wrong: it must not fire again immediately after a
// run that reported nothing (a hot loop costing a container every few seconds), and
// it must not fire at all on a project nobody is working in.
let ctx: ServerTestContext;
let teamId: string;
let projectId: string;
let otherTeamId: string;
let otherProjectId: string;
let coachId: string;
let memberId: string;
let taskNumber = 0;

interface JmInternals {
	selectDueRetrospectiveProject(): Promise<{ projectId: string; teamId: string } | null>;
	selectMissedReviewTask(memberId: string): Promise<{ id: string; identifier: string } | undefined>;
}

const internals = (m: JobManager) => m as unknown as JmInternals;

function createJobManager(): JobManager {
	return new JobManager({
		db: ctx.db,
		docker: createStubDocker(),
		masterKeyManager: ctx.masterKeyManager,
		serverPort: ctx.port,
		dataDir: ctx.dataDir,
		wsManager: { broadcast: () => {} } as unknown as JobManagerDeps['wsManager'],
		logs: new LogStreamBroker(),
		containerLogStreamer: new ContainerLogStreamer(),
	});
}

/** A finished run on a team, `hoursAgo` in the past. */
async function seedRun(
	team: string,
	member: string,
	kind: HeartbeatRunKind,
	hoursAgo: number,
): Promise<void> {
	await ctx.db.query(
		`INSERT INTO heartbeat_runs (team_id, member_id, status, kind, started_at, finished_at)
		 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, $3::heartbeat_run_kind,
		         now() - (($4)::text || ' hours')::interval,
		         now() - (($4)::text || ' hours')::interval)`,
		[team, member, kind, String(hoursAgo)],
	);
}

/** A task closed `hoursAgo` in the past, in the main project. */
async function seedClosedTask(
	title: string,
	hoursAgo: number,
	project = projectId,
	team = teamId,
): Promise<{ id: string; identifier: string }> {
	taskNumber += 1;
	const r = await ctx.db.query<{ id: string; identifier: string }>(
		`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6::task_status, now() - (($7)::text || ' hours')::interval)
		 RETURNING id, identifier`,
		[team, project, taskNumber, `SW-${taskNumber}`, title, TaskStatus.Done, String(hoursAgo)],
	);
	return r.rows[0];
}

beforeAll(async () => {
	ctx = await createTestContext();
	const { app, db, token } = ctx;
	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;

	const teamRes = await createTestTeam(db, { name: 'Retro Cadence Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
	projectId = (await (await createTestProject(db, teamId, { name: 'Retro P' })).json()).data.id;

	const otherRes = await createTestTeam(db, { name: 'Second Co', template_id: typeId });
	otherTeamId = (await otherRes.json()).data.id;
	otherProjectId = (await (await createTestProject(db, otherTeamId, { name: 'Second P' })).json())
		.data.id;

	const coach = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma WHERE ma.slug = 'coach' LIMIT 1`,
	);
	coachId = coach.rows[0].id;
	const member = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain' LIMIT 1`,
		[teamId],
	);
	memberId = member.rows[0].id;

	// Both projects start old enough to be due, so each case controls only what it
	// is about.
	await db.query(`UPDATE projects SET created_at = now() - interval '30 days' WHERE id = ANY($1)`, [
		[projectId, otherProjectId],
	]);

	// (project_id, number) is unique and the team template seeds its own tasks.
	const maxNum = await db.query<{ n: number }>(
		`SELECT COALESCE(max(number), 0)::int AS n FROM tasks WHERE project_id = ANY($1)`,
		[[projectId, otherProjectId]],
	);
	taskNumber = maxNum.rows[0].n;
});

beforeEach(async () => {
	await ctx.db.query('DELETE FROM heartbeat_runs WHERE team_id = ANY($1)', [[teamId, otherTeamId]]);
	await ctx.db.query('DELETE FROM tasks WHERE identifier LIKE $1', ['SW-%']);
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

describe('retrospective cadence', () => {
	it('is not due on a project nobody has run in', async () => {
		// The dormancy half. Without it a quiet project burns a Coach run every other
		// day reading an empty window.
		expect(await internals(createJobManager()).selectDueRetrospectiveProject()).toBeNull();
	});

	it('is due once the interval has passed and work has happened since', async () => {
		await seedRun(teamId, memberId, HeartbeatRunKind.Task, 1);
		const due = await internals(createJobManager()).selectDueRetrospectiveProject();
		expect(due?.projectId).toBe(projectId);
		expect(due?.teamId).toBe(teamId);
	});

	it('is not due again straight after a retrospective that reported nothing', async () => {
		// The hot-loop test, and the reason the anchor is the run rather than
		// anything the run wrote. A pass that finds a healthy project writes no
		// comment, so an anchor based on output would leave the condition true and
		// dispatch again on the very next heartbeat, forever.
		await seedRun(teamId, memberId, HeartbeatRunKind.Task, 1);
		await seedRun(teamId, coachId, HeartbeatRunKind.Retrospective, 0);
		expect(await internals(createJobManager()).selectDueRetrospectiveProject()).toBeNull();
	});

	it('comes due again once the interval has passed since that run', async () => {
		await seedRun(teamId, coachId, HeartbeatRunKind.Retrospective, 72);
		await seedRun(teamId, memberId, HeartbeatRunKind.Task, 1);
		const due = await internals(createJobManager()).selectDueRetrospectiveProject();
		expect(due?.projectId).toBe(projectId);
	});

	it('survives a restart, because the anchor is data rather than a timer', async () => {
		await seedRun(teamId, memberId, HeartbeatRunKind.Task, 1);
		await seedRun(teamId, coachId, HeartbeatRunKind.Retrospective, 0);
		// A brand-new manager over the same database reaches the same conclusion; a
		// wall-clock cron would have lost the fact that this week already ran.
		expect(await internals(createJobManager()).selectDueRetrospectiveProject()).toBeNull();
	});

	it('takes the most overdue project when several are due', async () => {
		await seedRun(teamId, memberId, HeartbeatRunKind.Task, 1);
		await seedRun(teamId, coachId, HeartbeatRunKind.Retrospective, 72);
		await seedRun(otherTeamId, memberId, HeartbeatRunKind.Task, 1);
		await seedRun(otherTeamId, coachId, HeartbeatRunKind.Retrospective, 400);

		const due = await internals(createJobManager()).selectDueRetrospectiveProject();
		expect(due?.projectId).toBe(otherProjectId);
	});

	it('never selects an internal or archived project', async () => {
		await seedRun(teamId, memberId, HeartbeatRunKind.Task, 1);
		await ctx.db.query(`UPDATE projects SET archived_at = now() WHERE id = $1`, [projectId]);
		expect(await internals(createJobManager()).selectDueRetrospectiveProject()).toBeNull();
		await ctx.db.query(`UPDATE projects SET archived_at = NULL WHERE id = $1`, [projectId]);

		// HQ is internal and is where the Coach lives; it must never retrospect itself.
		const hq = await ctx.db.query<{ id: string }>(
			`SELECT id FROM projects WHERE is_internal = true LIMIT 1`,
		);
		expect(hq.rows.length).toBeGreaterThan(0);
		const due = await internals(createJobManager()).selectDueRetrospectiveProject();
		expect(due?.projectId).not.toBe(hq.rows[0].id);
	});

	it('reads a progress-update run as no anchor at all', async () => {
		// Both kinds are task-less and share an index; only this kind may satisfy the
		// retrospective's anchor, or a Captain's progress run would silently suppress
		// the Coach for two days.
		await seedRun(teamId, memberId, HeartbeatRunKind.Task, 1);
		await seedRun(teamId, memberId, HeartbeatRunKind.ProgressUpdate, 0);
		const due = await internals(createJobManager()).selectDueRetrospectiveProject();
		expect(due?.projectId).toBe(projectId);
	});
});

// The other half of the Coach's heartbeat. A close fires a wakeup naming the task;
// when that wakeup is lost the task is never reviewed by anything, because the Coach
// is not its assignee and assignment is what ordinary selection matches on.
describe('missed-review sweep', () => {
	const sweep = () => internals(createJobManager()).selectMissedReviewTask(coachId);

	/** The run a delivered wakeup would have produced. */
	async function seedReview(taskId: string, member = coachId): Promise<void> {
		await ctx.db.query(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, kind)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status, 'task'::heartbeat_run_kind)`,
			[teamId, member, taskId],
		);
	}

	it('finds a task that closed without its review running', async () => {
		const task = await seedClosedTask('Ship the thing', 2);
		expect((await sweep())?.id).toBe(task.id);
	});

	it('leaves a task alone once the Coach has run against it', async () => {
		const task = await seedClosedTask('Already reviewed', 2);
		await seedReview(task.id);
		expect(await sweep()).toBeUndefined();
	});

	it('reads another agent run on the task as no review at all', async () => {
		// The anti-join is scoped to this agent. Every done task has runs by whoever
		// did the work; an unscoped one would find nothing to sweep, ever.
		const task = await seedClosedTask('Worked on, never reviewed', 2);
		await seedReview(task.id, memberId);
		expect((await sweep())?.id).toBe(task.id);
	});

	it('ignores an old close, which is history rather than a lost wakeup', async () => {
		// The load-bearing bound. Without it the first heartbeat after this ships walks
		// every task the instance ever completed, one container at a time.
		await seedClosedTask('Closed last month', 24 * 40);
		expect(await sweep()).toBeUndefined();
	});

	it('ignores a task that is not done', async () => {
		const task = await seedClosedTask('Still open', 2);
		await ctx.db.query(`UPDATE tasks SET status = $1::task_status WHERE id = $2`, [
			TaskStatus.InProgress,
			task.id,
		]);
		expect(await sweep()).toBeUndefined();
	});

	it('ignores a task in an archived project, which has no container to run in', async () => {
		await seedClosedTask('Closed in an archived project', 2);
		await ctx.db.query(`UPDATE projects SET archived_at = now() WHERE id = $1`, [projectId]);
		expect(await sweep()).toBeUndefined();
		await ctx.db.query(`UPDATE projects SET archived_at = NULL WHERE id = $1`, [projectId]);
	});

	it('takes the oldest close first, so a burst of misses drains in order', async () => {
		await seedClosedTask('Closed an hour ago', 1);
		const oldest = await seedClosedTask('Closed ten hours ago', 10);
		await seedClosedTask('Closed five hours ago', 5);
		expect((await sweep())?.id).toBe(oldest.id);
	});

	it('reaches across teams, because the Coach reviews every project', async () => {
		const elsewhere = await seedClosedTask(
			'Closed in another team',
			2,
			otherProjectId,
			otherTeamId,
		);
		expect((await sweep())?.id).toBe(elsewhere.id);
	});
});
