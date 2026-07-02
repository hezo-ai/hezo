import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '011_asset_deletion_request.sql';

describe('011_asset_deletion_request migration', () => {
	let h: DataPreservationHarness;
	let taskId: string;
	let memberId: string;
	let seededCommentId: string;
	let seededWakeupId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// Seed representative rows at the schema-010 enums: a pending
		// credential_request comment and a credential_provided wakeup.
		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Main', 'main', 'MA') RETURNING id`,
			[teamId],
		);
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Bot') RETURNING id`,
			[teamId],
		);
		memberId = member.rows[0].id;
		const task = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority, labels)
			 VALUES ($1, $2, 1, 'MA-1', 'Seeded', 'backlog', 'medium', '{}') RETURNING id`,
			[teamId, project.rows[0].id],
		);
		taskId = task.rows[0].id;

		const comment = await h.db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'credential_request'::comment_content_type, '{"name":"API_KEY"}'::jsonb)
			 RETURNING id`,
			[taskId, memberId],
		);
		seededCommentId = comment.rows[0].id;

		const wakeup = await h.db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, payload)
			 VALUES ($1, $2, 'credential_provided'::wakeup_source, '{}'::jsonb)
			 RETURNING id`,
			[memberId, teamId],
		);
		seededWakeupId = wakeup.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds asset_deletion_request to comment_content_type and asset_deletion_resolved to wakeup_source', async () => {
		const comments = await h.db.query<{ enumlabel: string }>(
			`SELECT e.enumlabel FROM pg_enum e
			 JOIN pg_type t ON t.oid = e.enumtypid
			 WHERE t.typname = 'comment_content_type'`,
		);
		expect(comments.rows.map((r) => r.enumlabel)).toContain('asset_deletion_request');

		const sources = await h.db.query<{ enumlabel: string }>(
			`SELECT e.enumlabel FROM pg_enum e
			 JOIN pg_type t ON t.oid = e.enumtypid
			 WHERE t.typname = 'wakeup_source'`,
		);
		expect(sources.rows.map((r) => r.enumlabel)).toContain('asset_deletion_resolved');
	});

	it('preserves pre-existing comments and wakeups', async () => {
		const comment = await h.db.query<{ content_type: string; content: { name: string } }>(
			`SELECT content_type, content FROM task_comments WHERE id = $1`,
			[seededCommentId],
		);
		expect(comment.rows.length).toBe(1);
		expect(comment.rows[0].content_type).toBe('credential_request');
		expect(comment.rows[0].content.name).toBe('API_KEY');

		const wakeup = await h.db.query<{ source: string }>(
			`SELECT source FROM agent_wakeup_requests WHERE id = $1`,
			[seededWakeupId],
		);
		expect(wakeup.rows.length).toBe(1);
		expect(wakeup.rows[0].source).toBe('credential_provided');
	});

	it('accepts rows using the new enum values after the migration', async () => {
		const comment = await h.db.query<{ content_type: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'asset_deletion_request'::comment_content_type,
			         '{"assets":[{"id":"00000000-0000-0000-0000-000000000000","path":"old.png"}],"reason":"stale"}'::jsonb)
			 RETURNING content_type`,
			[taskId, memberId],
		);
		expect(comment.rows[0].content_type).toBe('asset_deletion_request');

		const wakeup = await h.db.query<{ source: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, payload)
			 SELECT $1, team_id, 'asset_deletion_resolved'::wakeup_source, '{}'::jsonb
			 FROM members WHERE id = $1
			 RETURNING source`,
			[memberId],
		);
		expect(wakeup.rows[0].source).toBe('asset_deletion_resolved');
	});
});
