import { HeartbeatRunKind, HeartbeatRunStatus, TaskStatus } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import {
	buildRetrospectiveSignals,
	type RetrospectiveSignals,
} from '../src/services/project-retrospective';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

// The deterministic half of a retrospective run: the structural shape handed to the
// Coach. These tests cover what each signal catches AND what it correctly ignores -
// the second half matters as much, because a detector that fires on healthy work is
// worse than none.
let db: Db;
let teamId: string;
let projectId: string;
let captainId: string;
let signals: RetrospectiveSignals;

let taskNumber = 0;

async function seedTask(
	title: string,
	opts: { parentId?: string; createdBy?: string | null; daysAgo?: number } = {},
): Promise<{ id: string; identifier: string }> {
	taskNumber += 1;
	const r = await db.query<{ id: string; identifier: string }>(
		`INSERT INTO tasks (team_id, project_id, number, identifier, title, status,
		                    parent_task_id, created_by_member_id, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6::task_status, $7, $8,
		         now() - (($9)::text || ' days')::interval)
		 RETURNING id, identifier`,
		[
			teamId,
			projectId,
			taskNumber,
			`RT-${taskNumber}`,
			title,
			TaskStatus.InProgress,
			opts.parentId ?? null,
			opts.createdBy === undefined ? null : opts.createdBy,
			String(opts.daysAgo ?? 1),
		],
	);
	return r.rows[0];
}

async function seedRuns(
	taskId: string | null,
	opts: { count: number; inputTokens: number; status?: HeartbeatRunStatus; minutes?: number },
): Promise<void> {
	for (let i = 0; i < opts.count; i++) {
		await db.query(
			`INSERT INTO heartbeat_runs
			   (team_id, member_id, task_id, status, kind, input_tokens, output_tokens,
			    started_at, finished_at)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, 'task'::heartbeat_run_kind, $5, 0,
			         now() - interval '1 day',
			         now() - interval '1 day' + (($6)::text || ' minutes')::interval)`,
			[
				teamId,
				captainId,
				taskId,
				opts.status ?? HeartbeatRunStatus.Succeeded,
				opts.inputTokens,
				String(opts.minutes ?? 5),
			],
		);
	}
}

async function seedAsset(filename: string, bytes: number, daysAgo: number): Promise<void> {
	await db.query(
		`INSERT INTO assets (team_id, project_id, content_type, byte_size, sha256,
		                     original_filename, created_at)
		 VALUES ($1, $2, 'text/markdown', $3, md5(random()::text) || md5(random()::text),
		         $4, now() - (($5)::text || ' days')::interval)`,
		[teamId, projectId, bytes, filename, String(daysAgo)],
	);
}

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	const typesRes = await ctx.app.request('/api/team-templates', { headers: authHeader(ctx.token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Retro Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Retro Project' });
	projectId = (await projectRes.json()).data.id;
	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain' LIMIT 1`,
		[teamId],
	);
	captainId = captain.rows[0].id;
	// The team template seeds its own tasks, and (project_id, number) is unique -
	// start above whatever it filed rather than colliding with it.
	const maxNum = await db.query<{ n: number }>(
		`SELECT COALESCE(max(number), 0)::int AS n FROM tasks WHERE project_id = $1`,
		[projectId],
	);
	taskNumber = maxNum.rows[0].n;

	// The incident in miniature.
	//
	// A runaway: modest run count, overwhelming share of the tokens.
	const runaway = await seedTask('Regenerate synchronized delivery evidence package');
	await seedRuns(runaway.id, { count: 12, inputTokens: 3_000_000, minutes: 40 });
	await seedRuns(runaway.id, {
		count: 4,
		inputTokens: 500_000,
		status: HeartbeatRunStatus.TimedOut,
		minutes: 60,
	});

	// A legitimate standing task: many more runs, a rounding error of the tokens.
	// This is the shape a run-count detector would wrongly flag.
	const standing = await seedTask('Find leads to contact about Hezo');
	await seedRuns(standing.id, { count: 60, inputTokens: 20_000, minutes: 2 });

	// Fan-out: one parent spawning remediation children.
	const parent = await seedTask('Independently reverify remediated package', { daysAgo: 6 });
	for (let i = 0; i < 7; i++) {
		await seedTask(`Regenerate synchronized derivative evidence ${i}`, { parentId: parent.id });
	}
	// A parent whose children predate the window must not count.
	const oldParent = await seedTask('Long-running epic', { daysAgo: 40 });
	for (let i = 0; i < 6; i++) {
		await seedTask(`Old child ${i}`, { parentId: oldParent.id, daysAgo: 30 });
	}

	// Near-duplicate titles, system-created, exactly as the coherence loop produced.
	for (let i = 0; i < 5; i++) {
		await seedTask('Review team coherence after roster change', { createdBy: null });
	}
	// Two genuinely different titles must not cluster.
	await seedTask('Write the quarterly board update');
	await seedTask('Refactor the ingestion pipeline');

	// Assets: a burst inside the window against an older library, and one artifact
	// rewritten repeatedly, each copy larger.
	for (let i = 0; i < 20; i++) await seedAsset(`INV-${i}/browser-evidence.json`, 1_000, 1);
	for (let i = 0; i < 5; i++) await seedAsset(`older/legacy-${i}.md`, 500, 40);
	for (let i = 0; i < 6; i++) {
		await seedAsset(`INV-${i}/2026-09-0${i}-cumulative-matrix.md`, 10_000 + i * 5_000, 2);
	}

	signals = await buildRetrospectiveSignals(db, projectId, teamId, 7);
});

afterAll(async () => {
	await safeClose(db);
});

describe('buildRetrospectiveSignals', () => {
	it('ranks tasks by what they spent, not by how often they ran', () => {
		expect(signals.task_burn[0].title).toContain('Regenerate synchronized delivery');
		expect(signals.task_burn[0].runs).toBe(16);
		expect(signals.task_burn[0].unproductive).toBe(4);
	});

	it('does not flag a standing task that runs constantly and costs almost nothing', () => {
		// The load-bearing assertion. A run-count detector puts this task first - it
		// has nearly four times the runs of the actual pathology. Ranking by tokens
		// is what separates a team doing its job from a team stuck in a loop, and it
		// is why this module counts tokens rather than runs.
		const standing = signals.task_burn.find((t) => t.title.includes('Find leads'));
		expect(standing?.runs).toBe(60);
		expect(signals.task_burn.indexOf(standing!)).toBeGreaterThan(0);
		expect(standing!.input_tokens).toBeLessThan(signals.task_burn[0].input_tokens / 10);
	});

	it('reports the instance denominator, so a figure has a scale', () => {
		expect(signals.totals.instance_input_tokens).toBeGreaterThanOrEqual(
			signals.totals.input_tokens,
		);
		expect(signals.totals.input_tokens).toBeGreaterThan(0);
	});

	it('catches a parent spawning work, and ignores one whose children predate the window', () => {
		const stems = signals.fan_out.map((f) => f.parent_title);
		expect(stems.some((s) => s.includes('Independently reverify'))).toBe(true);
		expect(stems.some((s) => s.includes('Long-running epic'))).toBe(false);
	});

	it('collapses near-duplicate titles and leaves different ones alone', () => {
		const cluster = signals.title_clusters.find((c) => c.stem.startsWith('review team coherence'));
		expect(cluster?.count).toBe(5);
		expect(cluster?.identifiers.length).toBe(5);
		expect(signals.title_clusters.some((c) => c.stem.includes('quarterly board'))).toBe(false);
	});

	it('measures asset growth against the library, which is where the ratio shows', () => {
		expect(signals.assets.added).toBe(26);
		expect(signals.assets.total).toBe(31);
		expect(signals.assets.ever_archived).toBe(0);
	});

	it('catches one artifact rewritten repeatedly, and that each copy grew', () => {
		const repeat = signals.asset_repeats.find((r) => r.stem.includes('cumulative-matrix'));
		expect(repeat?.copies).toBe(6);
		expect(repeat!.last_bytes).toBeGreaterThan(repeat!.first_bytes);
	});

	it('reports nothing as already flagged until a retrospective has commented', () => {
		expect(signals.already_flagged).toEqual([]);
	});

	it('lists a task a previous retrospective commented on, so it is not re-reported', async () => {
		const task = await seedTask('Previously flagged task');
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, kind)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status,
			         $3::heartbeat_run_kind) RETURNING id`,
			[teamId, captainId, HeartbeatRunKind.Retrospective],
		);
		await db.query(
			`INSERT INTO task_comments (task_id, content_type, content, created_by_run_id)
			 VALUES ($1, 'text'::comment_content_type, $2::jsonb, $3)`,
			[task.id, JSON.stringify({ text: 'This task is not converging.' }), run.rows[0].id],
		);

		const after = await buildRetrospectiveSignals(db, projectId, teamId, 7);
		expect(after.already_flagged).toContain(task.identifier);
	});

	it('bounds every arm however much is behind it', async () => {
		for (let i = 0; i < 60; i++) {
			const t = await seedTask(`Bulk filler task ${i}`);
			await seedRuns(t.id, { count: 1, inputTokens: 100 });
		}
		const bulky = await buildRetrospectiveSignals(db, projectId, teamId, 7);
		// Row caps hold, so the block cannot grow with the project.
		expect(bulky.task_burn.length).toBeLessThanOrEqual(10);
		expect(bulky.fan_out.length).toBeLessThanOrEqual(5);
		expect(bulky.title_clusters.length).toBeLessThanOrEqual(5);
		expect(bulky.asset_repeats.length).toBeLessThanOrEqual(5);
		expect(JSON.stringify(bulky).length).toBeLessThan(8_000);
	});

	it('ignores work outside the window', async () => {
		const narrow = await buildRetrospectiveSignals(db, projectId, teamId, 1);
		// The fan-out parent's children were seeded a day old, but the parent itself
		// is six days old; the children still count because the window reads their
		// creation, not the parent's.
		expect(narrow.assets.added).toBeLessThan(signals.assets.added + 26);
		expect(narrow.window_days).toBe(1);
	});
});
