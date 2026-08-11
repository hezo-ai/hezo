import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '057_credential_requests_in_inbox.sql';

describe('057_credential_requests_in_inbox migration', () => {
	let h: DataPreservationHarness;
	let teamId = '';
	let taskId = '';
	let pendingCommentId = '';
	let fulfilledCommentId = '';
	let textCommentId = '';
	let existingMentionId = '';
	let adminUserId = '';
	let superuserId = '';
	let outsiderUserId = '';
	const askedAt = '2026-06-01T09:00:00.000Z';

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0]?.id ?? '';

		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Acme App', 'acme-app', 'ACM') RETURNING id`,
			[teamId],
		);

		const agent = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Captain') RETURNING id`,
			[teamId],
		);

		// The three user shapes the backfill has to tell apart: a team admin and a
		// superuser both get a row; an unrelated member user gets none.
		const users = await h.db.query<{ id: string; display_name: string }>(
			`INSERT INTO users (display_name, is_superuser) VALUES
			   ('Team Admin', false),
			   ('Root', true),
			   ('Plain Member', false)
			 RETURNING id, display_name`,
		);
		const byName = (name: string) => users.rows.find((u) => u.display_name === name)?.id ?? '';
		adminUserId = byName('Team Admin');
		superuserId = byName('Root');
		outsiderUserId = byName('Plain Member');

		for (const [userId, role] of [
			[adminUserId, 'admin'],
			[outsiderUserId, 'member'],
		] as const) {
			const member = await h.db.query<{ id: string }>(
				`INSERT INTO members (team_id, member_type, display_name)
				 VALUES ($1, 'user', 'Human') RETURNING id`,
				[teamId],
			);
			await h.db.query(`INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, $3)`, [
				member.rows[0]?.id,
				userId,
				role,
			]);
		}

		const task = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, status)
			 VALUES ($1, $2, 1, 'ACM-1', 'Wire up analytics', 'in_progress'::task_status)
			 RETURNING id`,
			[teamId, project.rows[0]?.id],
		);
		taskId = task.rows[0]?.id ?? '';

		// Unanswered — the row the backfill exists for, deliberately dated weeks back.
		const pending = await h.db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content, created_at)
			 VALUES ($1, $2, 'credential_request'::comment_content_type, $3::jsonb, $4::timestamptz)
			 RETURNING id`,
			[
				taskId,
				agent.rows[0]?.id,
				JSON.stringify({ name: 'UMAMI_API_TOKEN', kind: 'api_key', instructions: 'Need it.' }),
				askedAt,
			],
		);
		pendingCommentId = pending.rows[0]?.id ?? '';

		// Already answered — nothing to ask for, so no inbox row.
		const fulfilled = await h.db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content, chosen_option)
			 VALUES ($1, $2, 'credential_request'::comment_content_type, $3::jsonb, $4::jsonb)
			 RETURNING id`,
			[
				taskId,
				agent.rows[0]?.id,
				JSON.stringify({ name: 'OLD_KEY', kind: 'api_key', instructions: 'Needed it.' }),
				JSON.stringify({ secret_id: null, fulfilled_at: askedAt }),
			],
		);
		fulfilledCommentId = fulfilled.rows[0]?.id ?? '';

		// An ordinary @admin mention with its own row: must come through untouched.
		const text = await h.db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb) RETURNING id`,
			[taskId, agent.rows[0]?.id, JSON.stringify({ text: '@admin thoughts?' })],
		);
		textCommentId = text.rows[0]?.id ?? '';
		const mention = await h.db.query<{ id: string }>(
			`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id, read_at)
			 VALUES ($1, $2, $3, $4, now()) RETURNING id`,
			[teamId, taskId, textCommentId, adminUserId],
		);
		existingMentionId = mention.rows[0]?.id ?? '';

		await h.applyTarget(TARGET);
	});

	afterAll(() => h.close());

	it('backfills an unread inbox row for the team admin and the superuser', async () => {
		const rows = await h.db.query<{ user_id: string; read_at: string | null }>(
			`SELECT user_id, read_at FROM admin_mentions WHERE comment_id = $1 ORDER BY user_id`,
			[pendingCommentId],
		);
		expect(rows.rows).toHaveLength(2);
		expect(new Set(rows.rows.map((r) => r.user_id))).toEqual(new Set([adminUserId, superuserId]));
		expect(rows.rows.every((r) => r.read_at === null)).toBe(true);
	});

	it('dates the backfilled row from the request, not from the migration', async () => {
		const row = await h.db.query<{ created_at: string }>(
			`SELECT created_at FROM admin_mentions WHERE comment_id = $1 LIMIT 1`,
			[pendingCommentId],
		);
		expect(new Date(row.rows[0]?.created_at ?? 0).toISOString()).toBe(askedAt);
	});

	it('leaves a non-admin team member out of the fan-out', async () => {
		const rows = await h.db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM admin_mentions WHERE user_id = $1`,
			[outsiderUserId],
		);
		expect(rows.rows[0]?.count).toBe(0);
	});

	it('raises nothing for a credential request that was already answered', async () => {
		const rows = await h.db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM admin_mentions WHERE comment_id = $1`,
			[fulfilledCommentId],
		);
		expect(rows.rows[0]?.count).toBe(0);
	});

	it('preserves the pre-existing mention row, its id and its read state', async () => {
		const kept = await h.db.query<{ id: string; read_at: string | null; user_id: string }>(
			`SELECT id, read_at, user_id FROM admin_mentions WHERE comment_id = $1`,
			[textCommentId],
		);
		expect(kept.rows).toHaveLength(1);
		expect(kept.rows[0]?.id).toBe(existingMentionId);
		expect(kept.rows[0]?.user_id).toBe(adminUserId);
		expect(kept.rows[0]?.read_at).not.toBeNull();
	});

	it('preserves the credential-request comments themselves', async () => {
		const comments = await h.db.query<{ id: string; content: Record<string, unknown> }>(
			`SELECT id, content FROM task_comments
			 WHERE content_type = 'credential_request'::comment_content_type
			 ORDER BY created_at`,
			[],
		);
		expect(comments.rows).toHaveLength(2);
		expect(comments.rows.map((r) => r.content.name).sort()).toEqual(['OLD_KEY', 'UMAMI_API_TOKEN']);
	});

	it('is idempotent against a row the app already wrote', async () => {
		// Re-running the same insert must not duplicate — the ON CONFLICT is what
		// lets an already-notified admin keep their read state on a re-ask.
		const before = await h.db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM admin_mentions WHERE comment_id = $1`,
			[pendingCommentId],
		);
		await h.db.query(
			`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id)
			 VALUES ($1, $2, $3, $4) ON CONFLICT (comment_id, user_id) DO NOTHING`,
			[teamId, taskId, pendingCommentId, adminUserId],
		);
		const after = await h.db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM admin_mentions WHERE comment_id = $1`,
			[pendingCommentId],
		);
		expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
	});
});
