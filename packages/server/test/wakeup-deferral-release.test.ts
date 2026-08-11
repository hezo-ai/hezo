import { WakeupSource, WakeupStatus } from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { ContainerLogStreamer } from '../src/services/container-logs';
import { JobManager, type JobManagerDeps } from '../src/services/job-manager';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { authHeader, createStubDocker, createTestProject, createTestTeam } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

/**
 * Releasing wakeups parked on a precondition that has since been met.
 *
 * A repo whose clone failed leaves `designated_repo_id` NULL, and the dispatch
 * gate then defers every wakeup for a code-touching agent as
 * `awaiting_repo_setup`. That is correct while it holds. What was not is the
 * release: `deferred` is terminal, and the only thing that flipped this reason
 * was `finalizePendingRepoSetup`, which misses when no approval is pending, when
 * the payload carries no `project_id`, and when a row has no `task_id`. A miss
 * parked the wakeup for good, and with the queue empty the only remaining driver
 * is the heartbeat sweep - floored at an hour and commonly configured to twelve.
 * A live instance sat idle for hours with assigned, unblocked, in-progress work.
 */

let ctx: ServerTestContext;
let teamId: string;
let readyProjectId: string;
let unreadyProjectId: string;
let unreadyTeamId: string;
let memberId: string;
let taskCounter = 0;

function makeJobManager(): JobManager {
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

/** A task in the given project, returning its id. */
async function seedTask(projectId: string, team = teamId): Promise<string> {
	// Offset past the planning task each new project is created with, whose
	// number would otherwise collide on `(project_id, number)`.
	taskCounter += 1;
	const number = 1000 + taskCounter;
	const res = await ctx.db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, number, identifier, title)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		[team, projectId, number, `WD-${number}`, `Deferral task ${number}`],
	);
	return res.rows[0].id;
}

/**
 * A deferred wakeup, seeded exactly as the stranded ones were: the payload names
 * a task and a reason and **no `project_id`**, which is one of the ways the
 * one-shot release path fails to see it.
 */
async function seedDeferred(taskId: string, reason: string, team = teamId): Promise<string> {
	const res = await ctx.db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
		 VALUES ($1, $2, $3::wakeup_source, $4::wakeup_status, $5::jsonb)
		 RETURNING id`,
		[
			memberId,
			team,
			WakeupSource.Assignment,
			WakeupStatus.Deferred,
			JSON.stringify({ task_id: taskId, reason }),
		],
	);
	return res.rows[0].id;
}

async function statusOf(wakeupId: string): Promise<string> {
	const res = await ctx.db.query<{ status: string }>(
		'SELECT status::text AS status FROM agent_wakeup_requests WHERE id = $1',
		[wakeupId],
	);
	return res.rows[0].status;
}

beforeAll(async () => {
	ctx = await createTestContext();
	const team = (await (await createTestTeam(ctx.db, { name: 'Deferral Release' })).json()).data;
	teamId = team.id;

	const ready = (await (await createTestProject(ctx.db, teamId, { name: 'Ready' })).json()).data;
	readyProjectId = ready.id;
	// Its own team: a team owns at most one project (`UNIQUE(projects.team_id)`),
	// and `createTestProject` returns the existing one idempotently rather than
	// failing - so a second call on the same team would silently hand back the
	// project whose repo *is* designated, and the negative case would assert
	// nothing.
	const otherTeam = (await (await createTestTeam(ctx.db, { name: 'Deferral Unready' })).json())
		.data;
	const unready = (
		await (await createTestProject(ctx.db, otherTeam.id, { name: 'Unready' })).json()
	).data;
	unreadyProjectId = unready.id;
	unreadyTeamId = otherTeam.id;

	const agentRes = await ctx.app.request(`/api/projects/${ready.slug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Deferral Agent' }),
	});
	memberId = (await agentRes.json()).data.id;

	// Only the first project's repo setup completed.
	const repo = await ctx.db.query<{ id: string }>(
		`INSERT INTO repos (project_id, repo_identifier, host_type)
		 VALUES ($1, 'owner/ready', 'github') RETURNING id`,
		[readyProjectId],
	);
	await ctx.db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [
		repo.rows[0].id,
		readyProjectId,
	]);
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

beforeEach(async () => {
	await ctx.db.query('DELETE FROM agent_wakeup_requests');
});

it('requeues a deferral whose project now has a designated repo', async () => {
	const wakeupId = await seedDeferred(await seedTask(readyProjectId), 'awaiting_repo_setup');

	await (
		makeJobManager() as unknown as { releaseSatisfiedDeferrals(): Promise<void> }
	).releaseSatisfiedDeferrals();

	// Queued, and claimable again - a row left `claimed_at` set would be skipped
	// by the poller forever.
	expect(await statusOf(wakeupId)).toBe(WakeupStatus.Queued);
	const row = await ctx.db.query<{ claimed_at: string | null }>(
		'SELECT claimed_at FROM agent_wakeup_requests WHERE id = $1',
		[wakeupId],
	);
	expect(row.rows[0].claimed_at).toBeNull();
});

it('leaves a deferral alone while its project still has no designated repo', async () => {
	const wakeupId = await seedDeferred(
		await seedTask(unreadyProjectId, unreadyTeamId),
		'awaiting_repo_setup',
		unreadyTeamId,
	);

	await (
		makeJobManager() as unknown as { releaseSatisfiedDeferrals(): Promise<void> }
	).releaseSatisfiedDeferrals();

	expect(await statusOf(wakeupId)).toBe(WakeupStatus.Deferred);
});

it('does not touch a deferral parked for a different reason', async () => {
	// `blocked` has its own release in `wakeIfReady`. Two writers for one row is
	// a race, so this sweep is scoped to the reason that had none.
	const wakeupId = await seedDeferred(await seedTask(readyProjectId), 'blocked');

	await (
		makeJobManager() as unknown as { releaseSatisfiedDeferrals(): Promise<void> }
	).releaseSatisfiedDeferrals();

	expect(await statusOf(wakeupId)).toBe(WakeupStatus.Deferred);
});

it('bounds one pass and drains the rest on the next', async () => {
	// 25 against a limit of 20: the backlog clears over ticks rather than in one
	// long statement on a five-second cron.
	const ids: string[] = [];
	for (let i = 0; i < 25; i++) {
		ids.push(await seedDeferred(await seedTask(readyProjectId), 'awaiting_repo_setup'));
	}
	const jm = makeJobManager() as unknown as { releaseSatisfiedDeferrals(): Promise<void> };

	await jm.releaseSatisfiedDeferrals();
	const afterFirst = await ctx.db.query<{ c: number }>(
		`SELECT count(*)::int AS c FROM agent_wakeup_requests WHERE status = $1::wakeup_status`,
		[WakeupStatus.Queued],
	);
	expect(afterFirst.rows[0].c).toBe(20);

	await jm.releaseSatisfiedDeferrals();
	const afterSecond = await ctx.db.query<{ c: number }>(
		`SELECT count(*)::int AS c FROM agent_wakeup_requests WHERE status = $1::wakeup_status`,
		[WakeupStatus.Queued],
	);
	expect(afterSecond.rows[0].c).toBe(ids.length);
});

it('runs as part of the wakeups tick, not only when called directly', async () => {
	// The sweep is only worth anything if the cron actually reaches it. Asserted
	// through `processWakeups` so removing the call is a failing test rather than
	// a silently dead method - every case above drives the method directly and
	// would pass with it unwired.
	//
	// The released row is not also *processed* in this same tick: the poller only
	// selects wakeups older than the coalescing window, and this one was created
	// a moment ago. So the assertion stays about the release.
	const wakeupId = await seedDeferred(await seedTask(readyProjectId), 'awaiting_repo_setup');

	await (makeJobManager() as unknown as { processWakeups(): Promise<void> }).processWakeups();

	expect(await statusOf(wakeupId)).toBe(WakeupStatus.Queued);
});
