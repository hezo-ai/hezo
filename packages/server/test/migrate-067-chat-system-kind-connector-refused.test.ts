import { ChatSystemMessageKind } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '067_chat_system_kind_connector_refused.sql';

// Seeds a chat thread at schema 066 carrying one row of each kind the CHECK
// admitted before this migration, applies it, and asserts: every seeded row and
// its kind survived, the new kind inserts, an unknown kind still fails, and -
// the drift guard - every value of the shared enum inserts, so the enum and the
// constraint cannot part ways without failing here.
describe('067_chat_system_kind_connector_refused migration', () => {
	let h: DataPreservationHarness;
	let conversationId: string;
	let convertedId: string;
	let handoffId: string;
	let plainId: string;

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
		const convo = await h.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel)
			 VALUES ($1, $2, $3, 'web') RETURNING id`,
			[member.rows[0].id, teamId, project.rows[0].id],
		);
		conversationId = convo.rows[0].id;

		const insert = async (role: string, content: string, kind: string | null): Promise<string> => {
			const r = await h.db.query<{ id: string }>(
				`INSERT INTO chat_messages (conversation_id, role, channel, status, content, system_kind)
				 VALUES ($1, $2::chat_message_role, 'web', 'complete', $3, $4) RETURNING id`,
				[conversationId, role, content, kind],
			);
			return r.rows[0].id;
		};
		plainId = await insert('assistant', 'here is the plan', null);
		convertedId = await insert('system', 'Conversation converted to task HQ-4', 'converted_task');
		handoffId = await insert(
			'system',
			'This chat turn named @dev without waking them',
			'handoff_not_delivered',
		);

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('preserves every seeded row and its kind', async () => {
		const rows = await h.db.query<{ id: string; system_kind: string | null; content: string }>(
			`SELECT id, system_kind, content FROM chat_messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
			[conversationId],
		);
		expect(rows.rows.map((r) => r.id)).toEqual([plainId, convertedId, handoffId]);
		expect(rows.rows.map((r) => r.system_kind)).toEqual([
			null,
			'converted_task',
			'handoff_not_delivered',
		]);
		expect(rows.rows[1].content).toBe('Conversation converted to task HQ-4');
	});

	it('admits the new kind and still rejects an unknown one', async () => {
		await expect(
			h.db.query(
				`INSERT INTO chat_messages (conversation_id, role, channel, status, content, system_kind)
				 VALUES ($1, 'system', 'web', 'complete', 'connector "ibkr" refused this run', 'connector_refused')`,
				[conversationId],
			),
		).resolves.toBeDefined();
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
});
