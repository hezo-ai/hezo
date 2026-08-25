import { ChatSystemMessageKind } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '074_team_chat.sql';

// Seeds two conversations at schema 073 - one with messages of every kind the
// old CHECK admitted, one empty - applies the migration, and asserts: every
// seeded row and its kind survived, `last_message_id` was backfilled to each
// conversation's newest message (and left NULL on the empty one), the new
// kinds insert while an unknown one still fails, the reads watermark table
// accepts and upserts rows, and - the drift guard - every value of the shared
// enum inserts, so the enum and the constraint cannot part ways silently.
describe('074_team_chat migration', () => {
	let h: DataPreservationHarness;
	let conversationId: string;
	let emptyConversationId: string;
	let userId: string;
	let seeded: string[];

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('HQ', 'hq-team') RETURNING id`,
		);
		const teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, is_internal)
			 VALUES ($1, 'HQ', 'hq', 'HQ', true) RETURNING id`,
			[teamId],
		);
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name) VALUES ($1, 'agent', 'CEO') RETURNING id`,
			[teamId],
		);
		const user = await h.db.query<{ id: string }>(
			`INSERT INTO users (display_name, is_superuser) VALUES ('Operator', true) RETURNING id`,
		);
		userId = user.rows[0].id;
		const convo = async (): Promise<string> => {
			const r = await h.db.query<{ id: string }>(
				`INSERT INTO chat_conversations (member_id, team_id, project_id, channel)
				 VALUES ($1, $2, $3, 'web') RETURNING id`,
				[member.rows[0].id, teamId, project.rows[0].id],
			);
			return r.rows[0].id;
		};
		conversationId = await convo();
		emptyConversationId = await convo();

		const insert = async (role: string, content: string, kind: string | null): Promise<string> => {
			const r = await h.db.query<{ id: string }>(
				`INSERT INTO chat_messages (conversation_id, role, channel, status, content, system_kind)
				 VALUES ($1, $2::chat_message_role, 'web', 'complete', $3, $4) RETURNING id`,
				[conversationId, role, content, kind],
			);
			return r.rows[0].id;
		};
		seeded = [
			await insert('user', 'how are the projects doing?', null),
			await insert('assistant', 'here is the plan', null),
			await insert('system', 'Conversation converted to task HQ-4', 'converted_task'),
			await insert('system', 'Waiting for growth-analyst/HM-336.', 'credential_wait'),
		];

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('preserves every seeded row and its kind', async () => {
		const rows = await h.db.query<{ id: string; system_kind: string | null }>(
			`SELECT id, system_kind FROM chat_messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
			[conversationId],
		);
		expect(rows.rows.map((r) => r.id)).toEqual(seeded);
		expect(rows.rows.map((r) => r.system_kind)).toEqual([
			null,
			null,
			'converted_task',
			'credential_wait',
		]);
	});

	it('backfills last_message_id to the newest message, and leaves an empty thread NULL', async () => {
		const rows = await h.db.query<{ id: string; last_message_id: string | null }>(
			`SELECT id, last_message_id FROM chat_conversations WHERE id = ANY($1::uuid[])`,
			[[conversationId, emptyConversationId]],
		);
		const byId = new Map(rows.rows.map((r) => [r.id, r.last_message_id]));
		expect(byId.get(conversationId)).toBe(seeded[seeded.length - 1]);
		expect(byId.get(emptyConversationId)).toBeNull();
	});

	it('admits the new kinds and still rejects an unknown one', async () => {
		for (const kind of ['budget_exceeded', 'capacity_wait', 'task_created']) {
			await expect(
				h.db.query(
					`INSERT INTO chat_messages (conversation_id, role, channel, status, content, system_kind)
					 VALUES ($1, 'system', 'web', 'complete', $2, $2)`,
					[conversationId, kind],
				),
			).resolves.toBeDefined();
		}
		await expect(
			h.db.query(
				`INSERT INTO chat_messages (conversation_id, role, channel, status, content, system_kind)
				 VALUES ($1, 'system', 'web', 'complete', 'nope', 'not_a_kind')`,
				[conversationId],
			),
		).rejects.toThrow();
	});

	it('admits every kind the shared enum names', async () => {
		for (const kind of Object.values(ChatSystemMessageKind)) {
			await expect(
				h.db.query(
					`INSERT INTO chat_messages (conversation_id, role, channel, status, content, system_kind)
					 VALUES ($1, 'system', 'web', 'complete', $2, $2)`,
					[conversationId, kind],
				),
			).resolves.toBeDefined();
		}
	});

	it('stores suggested replies on a message and leaves old rows NULL', async () => {
		await h.db.query(`UPDATE chat_messages SET suggested_replies = $2::jsonb WHERE id = $1`, [
			seeded[1],
			JSON.stringify(['Yes, go ahead', 'Not yet']),
		]);
		const rows = await h.db.query<{ id: string; suggested_replies: unknown }>(
			`SELECT id, suggested_replies FROM chat_messages WHERE id = ANY($1::uuid[])`,
			[[seeded[0], seeded[1]]],
		);
		const byId = new Map(rows.rows.map((r) => [r.id, r.suggested_replies]));
		expect(byId.get(seeded[0])).toBeNull();
		expect(byId.get(seeded[1])).toEqual(['Yes, go ahead', 'Not yet']);
	});

	it('links a task to its originating conversation, severed if the thread goes', async () => {
		const team = await h.db.query<{ id: string; project: string }>(
			`SELECT t.id, p.id AS project FROM teams t JOIN projects p ON p.team_id = t.id LIMIT 1`,
		);
		const task = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, origin_chat_conversation_id)
			 VALUES ($1, $2, 1, 'HQ-1', 'From chat', $3) RETURNING id`,
			[team.rows[0].id, team.rows[0].project, emptyConversationId],
		);
		const row = await h.db.query<{ origin: string | null }>(
			`SELECT origin_chat_conversation_id AS origin FROM tasks WHERE id = $1`,
			[task.rows[0].id],
		);
		expect(row.rows[0].origin).toBe(emptyConversationId);
		// ON DELETE SET NULL: losing the conversation never cascades into tasks.
		await h.db.query(`DELETE FROM chat_conversations WHERE id = $1`, [emptyConversationId]);
		const after = await h.db.query<{ origin: string | null }>(
			`SELECT origin_chat_conversation_id AS origin FROM tasks WHERE id = $1`,
			[task.rows[0].id],
		);
		expect(after.rows[0].origin).toBeNull();
	});

	it('upserts the reads watermark only on real change', async () => {
		await h.db.query(
			`INSERT INTO chat_conversation_reads (user_id, conversation_id, last_read_message_id)
			 VALUES ($1, $2, $3)`,
			[userId, conversationId, seeded[0]],
		);
		await h.db.query(
			`UPDATE chat_conversation_reads SET last_read_message_id = $3, updated_at = now()
			 WHERE user_id = $1 AND conversation_id = $2 AND last_read_message_id IS DISTINCT FROM $3`,
			[userId, conversationId, seeded[3]],
		);
		const row = await h.db.query<{ last_read_message_id: string }>(
			`SELECT last_read_message_id FROM chat_conversation_reads
			 WHERE user_id = $1 AND conversation_id = $2`,
			[userId, conversationId],
		);
		expect(row.rows[0].last_read_message_id).toBe(seeded[3]);
	});
});
