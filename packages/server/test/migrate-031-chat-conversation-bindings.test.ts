import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '031_chat_conversation_bindings.sql';

// Seeds a web conversation and a Telegram-origin conversation at schema 030, applies
// the bindings migration, and asserts: the table exists, each conversation got a
// binding for its origin channel, non-web conversations also got a web binding, and
// the (channel, external_thread_id) index routes an inbound thread to its conversation.
describe('031_chat_conversation_bindings migration', () => {
	let h: DataPreservationHarness;
	let webConvo: string;
	let tgConvo: string;

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
		const projectId = project.rows[0].id;
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name) VALUES ($1, 'agent', 'CEO') RETURNING id`,
			[teamId],
		);
		const ceoId = member.rows[0].id;

		const web = await h.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel) VALUES ($1, $2, $3, 'web') RETURNING id`,
			[ceoId, teamId, projectId],
		);
		webConvo = web.rows[0].id;
		const tg = await h.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel, external_thread_id)
			 VALUES ($1, $2, $3, 'telegram', '-100:7') RETURNING id`,
			[ceoId, teamId, projectId],
		);
		tgConvo = tg.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('creates the bindings table', async () => {
		const t = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.tables WHERE table_name = 'chat_conversation_bindings'`,
		);
		expect(t.rows[0].c).toBe(1);
	});

	it('backfills the origin binding for each conversation', async () => {
		const web = await h.db.query<{ channel: string; external_thread_id: string | null }>(
			`SELECT channel::text AS channel, external_thread_id FROM chat_conversation_bindings
			 WHERE conversation_id = $1 ORDER BY channel`,
			[webConvo],
		);
		expect(web.rows).toEqual([{ channel: 'web', external_thread_id: null }]);

		const tg = await h.db.query<{ channel: string; external_thread_id: string | null }>(
			`SELECT channel::text AS channel, external_thread_id FROM chat_conversation_bindings
			 WHERE conversation_id = $1 ORDER BY channel`,
			[tgConvo],
		);
		// Telegram origin binding + an added web binding, so it's reachable in the web switcher.
		expect(tg.rows).toEqual([
			{ channel: 'telegram', external_thread_id: '-100:7' },
			{ channel: 'web', external_thread_id: null },
		]);
	});

	it('routes an external thread id to its conversation', async () => {
		const r = await h.db.query<{ conversation_id: string }>(
			`SELECT conversation_id FROM chat_conversation_bindings
			 WHERE channel = 'telegram' AND external_thread_id = '-100:7'`,
		);
		expect(r.rows[0].conversation_id).toBe(tgConvo);
	});

	it('rejects a second binding for the same channel on one conversation', async () => {
		await expect(
			h.db.query(
				`INSERT INTO chat_conversation_bindings (conversation_id, channel, external_thread_id)
				 VALUES ($1, 'web', NULL)`,
				[webConvo],
			),
		).rejects.toThrow();
	});

	it('rejects two conversations bound to the same external thread', async () => {
		await expect(
			h.db.query(
				`INSERT INTO chat_conversation_bindings (conversation_id, channel, external_thread_id)
				 VALUES ($1, 'telegram', '-100:7')`,
				[webConvo],
			),
		).rejects.toThrow();
	});
});
