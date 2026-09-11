import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '074_approval_resolved_wakeup.sql';

describe('074_approval_resolved_wakeup migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let taskId: string;
	let plainCommentId: string;
	let resolvedWithTimestampId: string;
	let resolvedWithoutTimestampId: string;
	let wakeupId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema before 074

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Acme', 'acme', 'AC') RETURNING id`,
			[teamId],
		);
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Chief') RETURNING id`,
			[teamId],
		);
		const task = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, 1, 'AC-1', 'Team setup') RETURNING id`,
			[teamId, project.rows[0].id],
		);
		taskId = task.rows[0].id;

		// Three pre-existing comments covering the three shapes the backfill has to
		// tell apart: never answered, answered with a recorded timestamp, and
		// answered by a writer that records none.
		const plain = await h.db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, content_type, content, created_at)
			 VALUES ($1, 'text'::comment_content_type, '{"text":"hello"}'::jsonb,
			         TIMESTAMPTZ '2026-01-02 09:00:00Z')
			 RETURNING id`,
			[taskId],
		);
		plainCommentId = plain.rows[0].id;
		const withTs = await h.db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, content_type, content, chosen_option, created_at)
			 VALUES ($1, 'action'::comment_content_type,
			         '{"kind":"hire_proposal","approval_id":"a-1"}'::jsonb,
			         '{"status":"approved","resolved_at":"2026-01-03T10:00:00.000Z"}'::jsonb,
			         TIMESTAMPTZ '2026-01-02 09:01:00Z')
			 RETURNING id`,
			[taskId],
		);
		resolvedWithTimestampId = withTs.rows[0].id;
		const withoutTs = await h.db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, content_type, content, chosen_option, created_at)
			 VALUES ($1, 'credential_request'::comment_content_type, '{"name":"API_KEY"}'::jsonb,
			         '"provided"'::jsonb, TIMESTAMPTZ '2026-01-02 09:02:00Z')
			 RETURNING id`,
			[taskId],
		);
		resolvedWithoutTimestampId = withoutTs.rows[0].id;

		// A wakeup on an existing source, to prove extending the enum leaves the
		// rows already stored on it readable.
		const wakeup = await h.db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, payload)
			 VALUES ($1, $2, 'automation'::wakeup_source, '{"reason":"hire_resolved"}'::jsonb)
			 RETURNING id`,
			[member.rows[0].id, teamId],
		);
		wakeupId = wakeup.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds approval_resolved to wakeup_source without disturbing the rows already on it', async () => {
		const values = await h.db.query<{ enumlabel: string }>(
			`SELECT enumlabel FROM pg_enum e
			 JOIN pg_type t ON t.oid = e.enumtypid
			 WHERE t.typname = 'wakeup_source'`,
		);
		expect(values.rows.map((r) => r.enumlabel)).toContain('approval_resolved');

		const kept = await h.db.query<{ id: string; source: string }>(
			'SELECT id, source FROM agent_wakeup_requests WHERE team_id = $1',
			[teamId],
		);
		expect(kept.rows.length).toBe(1);
		expect(kept.rows[0].id).toBe(wakeupId);
		expect(kept.rows[0].source).toBe('automation');
	});

	it('preserves every pre-existing comment and backfills chosen_at only for answered ones', async () => {
		const rows = await h.db.query<{
			id: string;
			chosen_at: string | null;
			content: Record<string, unknown>;
		}>('SELECT id, chosen_at, content FROM task_comments WHERE task_id = $1 ORDER BY created_at', [
			taskId,
		]);
		expect(rows.rows.length).toBe(3);
		expect(rows.rows.map((r) => r.id)).toEqual([
			plainCommentId,
			resolvedWithTimestampId,
			resolvedWithoutTimestampId,
		]);
		// The content the rows carried is untouched.
		expect(rows.rows[1].content.kind).toBe('hire_proposal');

		// Unanswered: nothing to stamp.
		expect(rows.rows[0].chosen_at).toBeNull();
		// Answered with a recorded time: that time, not the migration's.
		expect(new Date(rows.rows[1].chosen_at as string).toISOString()).toBe(
			'2026-01-03T10:00:00.000Z',
		);
		// Answered by a writer that records none: the comment's own creation time.
		// Both are in the past, so no backfilled row can look newer than a run that
		// has already finished.
		expect(new Date(rows.rows[2].chosen_at as string).toISOString()).toBe(
			'2026-01-02T09:02:00.000Z',
		);
	});

	it('stamps chosen_at when a card is answered, and only on the first answer', async () => {
		await h.db.query(
			`UPDATE task_comments SET chosen_option = '{"status":"approved"}'::jsonb WHERE id = $1`,
			[plainCommentId],
		);
		const first = await h.db.query<{ chosen_at: string | null }>(
			'SELECT chosen_at FROM task_comments WHERE id = $1',
			[plainCommentId],
		);
		expect(first.rows[0].chosen_at).not.toBeNull();

		// Refreshing the display snapshot must not move the answer's timestamp -
		// both resolvers rewrite `content` in the same statement that settles it,
		// and a later edit would otherwise read as a fresh answer.
		await h.db.query(
			`UPDATE task_comments SET content = content || '{"title":"Renamed"}'::jsonb WHERE id = $1`,
			[plainCommentId],
		);
		const second = await h.db.query<{ chosen_at: string }>(
			'SELECT chosen_at FROM task_comments WHERE id = $1',
			[plainCommentId],
		);
		expect(second.rows[0].chosen_at).toEqual(first.rows[0].chosen_at);
	});

	it('indexes the answered-card probe the backoff runs once per dispatch', async () => {
		const r = await h.db.query<{ indexdef: string }>(
			`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_comments_task_chosen_at'`,
		);
		expect(r.rows.length).toBe(1);
		const def = r.rows[0].indexdef.toLowerCase();
		expect(def).toContain('task_id');
		expect(def).toContain('chosen_at');
		// Partial: a task's answered cards are a small minority of its comments.
		expect(def).toContain('where');
	});
});
