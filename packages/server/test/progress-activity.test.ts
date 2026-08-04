import { CommentContentType, HeartbeatRunKind, TaskStatus } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import {
	buildProgressActivityCandidates,
	buildProgressActivitySnapshot,
	readProgressActivity,
} from '../src/services/project-activity';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

// The deterministic half of the Progress page: which tasks become candidates for each column.
// The Captain picks from these and writes the prose; these tests cover the picking rules.
let db: Db;
let teamId: string;
let projectId: string;
let captainId: string;

let taskNumber = 0;

async function seedTask(
	title: string,
	opts: {
		status?: TaskStatus;
		progressSummary?: string;
		description?: string;
		createdBy?: string | null;
		updatedAt?: string;
		createdAt?: string;
	} = {},
): Promise<{ id: string; identifier: string }> {
	taskNumber += 1;
	const r = await db.query<{ id: string; identifier: string }>(
		`INSERT INTO tasks (team_id, project_id, number, identifier, title, status,
		                    progress_summary, description, created_by_member_id,
		                    created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6::task_status, $7, $8, $9,
		         COALESCE($10::timestamptz, now()), COALESCE($11::timestamptz, now()))
		 RETURNING id, identifier`,
		[
			teamId,
			projectId,
			taskNumber,
			`PA-${taskNumber}`,
			title,
			opts.status ?? TaskStatus.InProgress,
			opts.progressSummary ?? null,
			opts.description ?? '',
			opts.createdBy === undefined ? null : opts.createdBy,
			opts.createdAt ?? null,
			opts.updatedAt ?? null,
		],
	);
	return r.rows[0];
}

/** The system comment `recordStatusChange` writes; the only record of when a task was closed. */
async function seedCloseComment(
	taskId: string,
	opts: { actorId?: string | null; cascadeActorId?: string | null; at?: string } = {},
) {
	const content: Record<string, unknown> = {
		kind: 'status_change',
		from: 'in_progress',
		to: 'done',
		actor_id: opts.actorId ?? null,
	};
	if (opts.cascadeActorId) {
		content.cascade = 'parent_closed';
		content.triggered_by_actor_id = opts.cascadeActorId;
	}
	await db.query(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content, created_at)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb, COALESCE($5::timestamptz, now()))`,
		[
			taskId,
			opts.cascadeActorId ? null : (opts.actorId ?? null),
			CommentContentType.System,
			JSON.stringify(content),
			opts.at ?? null,
		],
	);
}

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	const typesRes = await ctx.app.request('/api/team-templates', { headers: authHeader(ctx.token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Activity Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Activity Project' });
	projectId = (await projectRes.json()).data.id;

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain' LIMIT 1`,
		[teamId],
	);
	captainId = captain.rows[0].id;

	// The provisioned planning task would otherwise crowd the small candidate lists.
	await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
});

afterAll(async () => {
	await safeClose(db);
});

describe('buildProgressActivityCandidates', () => {
	it('ranks actioned by most recent activity and carries the task progress summary', async () => {
		const older = await seedTask('Older work', {
			updatedAt: '2026-01-01T00:00:00Z',
			progressSummary: 'Half done.',
		});
		const newer = await seedTask('Newer work', {
			updatedAt: '2026-02-01T00:00:00Z',
			progressSummary: 'Nearly there.',
		});

		const c = await buildProgressActivityCandidates(db, projectId, teamId);
		const identifiers = c.actioned.map((t) => t.identifier);
		expect(identifiers.indexOf(newer.identifier)).toBeLessThan(
			identifiers.indexOf(older.identifier),
		);
		expect(c.actioned.find((t) => t.identifier === newer.identifier)?.excerpt).toBe(
			'Nearly there.',
		);
	});

	// A run on the task counts as activity even when the task row itself has not moved, which is
	// how agent work surfaces at all.
	it('lifts a task by its latest run, not just by updated_at', async () => {
		const stale = await seedTask('Worked but not edited', { updatedAt: '2025-06-01T00:00:00Z' });
		await db.query(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, kind, status, started_at)
			 VALUES ($1, $2, $3, $4::heartbeat_run_kind, 'succeeded'::heartbeat_run_status, now())`,
			[teamId, captainId, stale.id, HeartbeatRunKind.Task],
		);

		const c = await buildProgressActivityCandidates(db, projectId, teamId);
		// It now leads, despite being the least-recently-updated row.
		expect(c.actioned[0].identifier).toBe(stale.identifier);
	});

	// The Progress page must not report on its own runs. A progress-update run carries no
	// task_id, so it can never enter the ranking — this is structural, not a filter.
	it('never lets a progress-update run lift a task into actioned', async () => {
		const untouched = await seedTask('Only seen by a progress run', {
			updatedAt: '2025-01-01T00:00:00Z',
		});
		const progressRun = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, kind, status, started_at)
			 VALUES ($1, $2, $3::heartbeat_run_kind, 'succeeded'::heartbeat_run_status, now())
			 RETURNING id`,
			[teamId, captainId, HeartbeatRunKind.ProgressUpdate],
		);
		// The progress run comments on the task, exactly as a real one does.
		await db.query(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content, created_by_run_id)
			 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb, $4)`,
			[
				untouched.id,
				captainId,
				JSON.stringify({ text: 'Steering note from the progress run.' }),
				progressRun.rows[0].id,
			],
		);

		const c = await buildProgressActivityCandidates(db, projectId, teamId);
		// It stays at the bottom on its stale updated_at rather than being lifted to the top.
		expect(c.actioned[0].identifier).not.toBe(untouched.identifier);
	});

	it('excludes closed and cancelled work from actioned', async () => {
		const done = await seedTask('Finished', { status: TaskStatus.Done });
		const cancelled = await seedTask('Abandoned', { status: TaskStatus.Cancelled });

		const c = await buildProgressActivityCandidates(db, projectId, teamId);
		const identifiers = c.actioned.map((t) => t.identifier);
		expect(identifiers).not.toContain(done.identifier);
		expect(identifiers).not.toContain(cancelled.identifier);
	});

	it('orders created newest-first and names the creator', async () => {
		const t = await seedTask('Filed by the Captain', {
			createdBy: captainId,
			createdAt: '2030-01-01T00:00:00Z',
			description: 'Because the release needs de-risking.',
		});
		const c = await buildProgressActivityCandidates(db, projectId, teamId);
		expect(c.created[0].identifier).toBe(t.identifier);
		expect(c.created[0].actor).toBe('Captain');
		expect(c.created[0].excerpt).toBe('Because the release needs de-risking.');
	});

	it('resolves the closer and close time from the status-change comment', async () => {
		const t = await seedTask('Shipped', {
			status: TaskStatus.Done,
			progressSummary: 'Payments are live.',
		});
		await seedCloseComment(t.id, { actorId: captainId, at: '2029-05-05T10:00:00Z' });

		const c = await buildProgressActivityCandidates(db, projectId, teamId);
		const row = c.closed.find((r) => r.identifier === t.identifier);
		expect(row?.actor).toBe('Captain');
		expect(new Date(row?.at ?? 0).toISOString()).toBe('2029-05-05T10:00:00.000Z');
		expect(row?.excerpt).toBe('Payments are live.');
	});

	// A task closed, re-opened and closed again should report the *latest* close.
	it('takes the latest close when a task was re-opened and closed again', async () => {
		const t = await seedTask('Re-done', { status: TaskStatus.Done });
		await seedCloseComment(t.id, { actorId: captainId, at: '2029-01-01T00:00:00Z' });
		await seedCloseComment(t.id, { actorId: captainId, at: '2029-09-09T00:00:00Z' });

		const c = await buildProgressActivityCandidates(db, projectId, teamId);
		const row = c.closed.find((r) => r.identifier === t.identifier);
		expect(new Date(row?.at ?? 0).toISOString()).toBe('2029-09-09T00:00:00.000Z');
	});

	// A cascade close nulls the comment author and puts the real actor in the payload.
	it('names the triggering actor for a cascade close', async () => {
		const t = await seedTask('Closed by cascade', { status: TaskStatus.Done });
		await seedCloseComment(t.id, { cascadeActorId: captainId, at: '2029-06-06T00:00:00Z' });

		const c = await buildProgressActivityCandidates(db, projectId, teamId);
		expect(c.closed.find((r) => r.identifier === t.identifier)?.actor).toBe('Captain');
	});

	// No close comment (legacy data, or a task created straight into `done`) must not drop the row.
	it('keeps a closed task with no status-change comment, falling back to updated_at', async () => {
		const t = await seedTask('Closed without a comment', {
			status: TaskStatus.Done,
			updatedAt: '2028-03-03T00:00:00Z',
		});
		const c = await buildProgressActivityCandidates(db, projectId, teamId);
		const row = c.closed.find((r) => r.identifier === t.identifier);
		expect(row).toBeDefined();
		expect(row?.actor).toBeNull();
		expect(new Date(row?.at ?? 0).toISOString()).toBe('2028-03-03T00:00:00.000Z');
	});

	it('never offers a cancelled task as closed', async () => {
		const t = await seedTask('Abandoned outright', { status: TaskStatus.Cancelled });
		const c = await buildProgressActivityCandidates(db, projectId, teamId);
		expect(c.closed.map((r) => r.identifier)).not.toContain(t.identifier);
	});

	it('truncates the excerpt so a long summary cannot widen the payload', async () => {
		await seedTask('Verbose', {
			progressSummary: 'x'.repeat(5000),
			updatedAt: '2031-01-01T00:00:00Z',
		});
		const c = await buildProgressActivityCandidates(db, projectId, teamId);
		expect(c.actioned[0].excerpt?.length).toBe(200);
	});
});

describe('buildProgressActivitySnapshot', () => {
	it('captures the identifier and title, and caps each column at five', async () => {
		const tasks = [];
		for (let i = 0; i < 7; i++) tasks.push(await seedTask(`Snapshot task ${i}`));

		const { activity, unknown } = await buildProgressActivitySnapshot(db, projectId, {
			actioned: tasks.map((t) => ({ task: t.identifier, summary: `Line for ${t.identifier}` })),
		});
		expect(unknown).toEqual([]);
		expect(activity.actioned.length).toBe(5);
		expect(activity.actioned[0].identifier).toBe(tasks[0].identifier);
		expect(activity.actioned[0].title).toBe('Snapshot task 0');
		expect(activity.created).toEqual([]);
	});

	it('reports an identifier that does not resolve instead of dropping it silently', async () => {
		const t = await seedTask('Real task');
		const { activity, unknown } = await buildProgressActivitySnapshot(db, projectId, {
			closed: [
				{ task: t.identifier, summary: 'Done properly.' },
				{ task: 'PA-9999', summary: 'This task does not exist.' },
			],
		});
		expect(activity.closed.length).toBe(1);
		expect(unknown).toEqual(['PA-9999']);
	});

	it('accepts a lowercase identifier, as agents often write them', async () => {
		const t = await seedTask('Case check');
		const { activity, unknown } = await buildProgressActivitySnapshot(db, projectId, {
			actioned: [{ task: t.identifier.toLowerCase(), summary: 'Still fine.' }],
		});
		expect(unknown).toEqual([]);
		expect(activity.actioned[0].identifier).toBe(t.identifier);
	});

	// The page renders the stored line in full, so an over-long line has to be cut back to a
	// finished thought here rather than clipped behind an ellipsis there.
	it('trims an over-long Captain line back to its last complete sentence', async () => {
		const t = await seedTask('Long line');
		const first = 'Live cards work end to end.';
		const { activity } = await buildProgressActivitySnapshot(db, projectId, {
			actioned: [
				{
					task: t.identifier,
					summary: `${first} ${'Refunds are the last remaining gap. '.repeat(10)}`,
				},
			],
		});
		const stored = activity.actioned[0].summary;
		expect(stored.length).toBeLessThanOrEqual(200);
		expect(stored.startsWith(first)).toBe(true);
		expect(stored.endsWith('.')).toBe(true);
		// Whole sentences only: never a dangling fragment of the one that did not fit.
		expect(stored.split('. ').at(-1)).toBe('Refunds are the last remaining gap.');
	});

	it('falls back to a whole word when nothing finishes inside the budget', async () => {
		const t = await seedTask('Run on');
		const { activity } = await buildProgressActivitySnapshot(db, projectId, {
			actioned: [{ task: t.identifier, summary: `${'refactoring '.repeat(40)}done` }],
		});
		const stored = activity.actioned[0].summary;
		expect(stored.length).toBeLessThanOrEqual(200);
		expect(stored.endsWith('refactoring')).toBe(true);
	});

	it('hard-slices a line carrying no boundary of any kind', async () => {
		const t = await seedTask('No spaces');
		const { activity } = await buildProgressActivitySnapshot(db, projectId, {
			actioned: [{ task: t.identifier, summary: 'y'.repeat(1000) }],
		});
		expect(activity.actioned[0].summary.length).toBe(200);
	});

	it('leaves a line that already fits exactly as written', async () => {
		const t = await seedTask('Short line');
		const { activity } = await buildProgressActivitySnapshot(db, projectId, {
			actioned: [{ task: t.identifier, summary: 'Payments can now take live cards end to end.' }],
		});
		expect(activity.actioned[0].summary).toBe('Payments can now take live cards end to end.');
	});

	it('skips an entry with no summary rather than storing a blank row', async () => {
		const t = await seedTask('No line');
		const { activity } = await buildProgressActivitySnapshot(db, projectId, {
			actioned: [{ task: t.identifier, summary: '   ' }],
		});
		expect(activity.actioned).toEqual([]);
	});
});

describe('readProgressActivity', () => {
	// Every project starts with `{}` (migration 049), so reads must tolerate an absent or
	// half-written document rather than assuming the three keys exist.
	it('returns empty columns for the default and for malformed values', () => {
		expect(readProgressActivity({})).toEqual({ actioned: [], created: [], closed: [] });
		expect(readProgressActivity(null)).toEqual({ actioned: [], created: [], closed: [] });
		expect(readProgressActivity({ actioned: 'nope' })).toEqual({
			actioned: [],
			created: [],
			closed: [],
		});
	});

	it('drops entries missing an identifier or summary and falls back to the identifier for a title', () => {
		const out = readProgressActivity({
			actioned: [
				{ identifier: 'PA-1', summary: 'Fine.' },
				{ identifier: 'PA-2' },
				{ summary: 'No identifier.' },
			],
		});
		expect(out.actioned.length).toBe(1);
		expect(out.actioned[0].title).toBe('PA-1');
	});
});
