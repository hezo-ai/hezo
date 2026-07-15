import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '029_multi_conversation.sql';

// Seeds the pre-existing global CEO conversation (+ a message) at schema 028,
// applies the multi-conversation migration, and asserts: the new columns exist,
// the old global row survives as the default open web thread, and a second external
// thread can be created + resolved via the new partial unique index.
describe('029_multi_conversation migration', () => {
	let h: DataPreservationHarness;
	let ceoMemberId: string;
	let teamId: string;
	let projectId: string;
	let globalConvoId: string;
	let messageId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('HQ', 'hq-team') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, is_internal)
			 VALUES ($1, 'HQ', 'hq', 'HQ', true) RETURNING id`,
			[teamId],
		);
		projectId = project.rows[0].id;
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'CEO') RETURNING id`,
			[teamId],
		);
		ceoMemberId = member.rows[0].id;

		const convo = await h.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, title)
			 VALUES ($1, $2, $3, 'Global') RETURNING id`,
			[ceoMemberId, teamId, projectId],
		);
		globalConvoId = convo.rows[0].id;
		const msg = await h.db.query<{ id: string }>(
			`INSERT INTO chat_messages (conversation_id, role, channel, status, content)
			 VALUES ($1, 'user', 'web', 'complete', 'hello') RETURNING id`,
			[globalConvoId],
		);
		messageId = msg.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds the multi-conversation columns', async () => {
		const cols = await h.db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_name = 'chat_conversations'`,
		);
		const names = cols.rows.map((r) => r.column_name);
		expect(names).toContain('channel');
		expect(names).toContain('external_thread_id');
		expect(names).toContain('last_activity_at');
		expect(names).toContain('closed_at');
	});

	it('preserves the pre-existing global conversation as the default open web thread', async () => {
		const kept = await h.db.query<{
			title: string;
			channel: string;
			external_thread_id: string | null;
			closed_at: string | null;
		}>(
			`SELECT title, channel::text AS channel, external_thread_id, closed_at
			 FROM chat_conversations WHERE id = $1`,
			[globalConvoId],
		);
		expect(kept.rows).toHaveLength(1);
		expect(kept.rows[0].title).toBe('Global');
		expect(kept.rows[0].channel).toBe('web');
		expect(kept.rows[0].external_thread_id).toBeNull();
		expect(kept.rows[0].closed_at).toBeNull();
		// The message it held is still attached.
		const m = await h.db.query(`SELECT 1 FROM chat_messages WHERE id = $1`, [messageId]);
		expect(m.rows.length).toBe(1);
	});

	it('allows a second external thread and enforces one open conversation per external id', async () => {
		await h.db.query(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel, external_thread_id)
			 VALUES ($1, $2, $3, 'telegram', '555:2')`,
			[ceoMemberId, teamId, projectId],
		);
		// A duplicate *open* external thread violates the partial unique index.
		await expect(
			h.db.query(
				`INSERT INTO chat_conversations (member_id, team_id, project_id, channel, external_thread_id)
				 VALUES ($1, $2, $3, 'telegram', '555:2')`,
				[ceoMemberId, teamId, projectId],
			),
		).rejects.toThrow();
	});

	it('lets a closed external thread be re-created (index scoped to open threads)', async () => {
		await h.db.query(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel, external_thread_id, closed_at)
			 VALUES ($1, $2, $3, 'telegram', '555:9', now())`,
			[ceoMemberId, teamId, projectId],
		);
		// A fresh open thread with the same external id is allowed once the prior is closed.
		const fresh = await h.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel, external_thread_id)
			 VALUES ($1, $2, $3, 'telegram', '555:9') RETURNING id`,
			[ceoMemberId, teamId, projectId],
		);
		expect(fresh.rows).toHaveLength(1);
	});

	it('allows many web threads with a NULL external id', async () => {
		await h.db.query(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel)
			 VALUES ($1, $2, $3, 'web'), ($1, $2, $3, 'web')`,
			[ceoMemberId, teamId, projectId],
		);
		const webCount = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM chat_conversations
			 WHERE channel = 'web' AND external_thread_id IS NULL`,
		);
		// The original global row + the two just inserted.
		expect(webCount.rows[0].c).toBeGreaterThanOrEqual(3);
	});
});
