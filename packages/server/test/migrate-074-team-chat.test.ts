import { ChatSystemMessageKind } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '074_team_chat.sql';

// Seeds two conversations at schema 073 - one with messages of every kind the
// old CHECK admitted, one empty - plus a member memory row, applies the
// migration, and asserts: every seeded row, kind and memory survived,
// `last_message_id` was backfilled to each conversation's newest message (and
// left NULL on the empty one), the new kinds insert while an unknown one
// still fails, the reads watermark table accepts and upserts rows, and - the
// drift guard - every value of the shared enum inserts, so the enum and the
// constraint cannot part ways silently. The Phase-2 half: the recreated
// conversation-kind enum admits 'group' (memberless, one General per
// project), participants dedupe and die with their room, and a memory row
// carries exactly one scope.
describe('074_team_chat migration', () => {
	let h: DataPreservationHarness;
	let conversationId: string;
	let emptyConversationId: string;
	let userId: string;
	let teamId: string;
	let projectId: string;
	let memberId: string;
	let coworkerId: string;
	let seeded: string[];

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
			`INSERT INTO members (team_id, member_type, display_name) VALUES ($1, 'agent', 'CEO') RETURNING id`,
			[teamId],
		);
		memberId = member.rows[0].id;
		const user = await h.db.query<{ id: string }>(
			`INSERT INTO users (display_name, is_superuser) VALUES ('Operator', true) RETURNING id`,
		);
		userId = user.rows[0].id;
		await h.db.query(`INSERT INTO chat_memories (member_id, content) VALUES ($1, 'the plan')`, [
			memberId,
		]);
		const convo = async (): Promise<string> => {
			const r = await h.db.query<{ id: string }>(
				`INSERT INTO chat_conversations (member_id, team_id, project_id, channel)
				 VALUES ($1, $2, $3, 'web') RETURNING id`,
				[memberId, teamId, projectId],
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

		// A coworker thread seeded at the old schema: the enum recreate must carry
		// its kind and the single-stream close must not touch it.
		const coworker = await h.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel, external_thread_id, kind, title)
			 VALUES ($1, $2, $3, 'telegram', 'tg-123', 'coworker', 'Growth channel') RETURNING id`,
			[memberId, teamId, projectId],
		);
		coworkerId = coworker.rows[0].id;

		// A pinned-era pool member and its uptime history, seeded before the pin
		// flag is dropped: the member must survive the drop, the ledger row must
		// keep its flag.
		await h.db.query(
			`INSERT INTO container_pool_members (project_id, container_id, state, reserved_for_chat)
			 VALUES ($1, 'hq-pinned', 'idle', true)`,
			[projectId],
		);
		await h.db.query(
			`INSERT INTO container_uptime_entries (project_id, container_id, ended_at, end_reason, reserved_for_chat, backend)
			 VALUES ($1, 'hq-pinned', now(), 'suspended', true, 'docker')`,
			[projectId],
		);

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

	it('closes all but the most recently active open web thread per member', async () => {
		// Single-stream: the survivor is the live DM; the older thread stays fully
		// readable as History, nothing deleted.
		const rows = await h.db.query<{ id: string; closed_at: string | null }>(
			`SELECT id, closed_at FROM chat_conversations WHERE id = ANY($1::uuid[])`,
			[[conversationId, emptyConversationId]],
		);
		const byId = new Map(rows.rows.map((r) => [r.id, r.closed_at]));
		expect(byId.get(emptyConversationId)).toBeNull();
		expect(byId.get(conversationId)).not.toBeNull();
		const kept = await h.db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM chat_messages WHERE conversation_id = $1`,
			[conversationId],
		);
		expect(kept.rows[0].n).toBeGreaterThan(0);
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

	it('keeps kinds and the default through the enum recreate, and admits memberless groups', async () => {
		const kind = await h.db.query<{ kind: string }>(
			`SELECT kind::text AS kind FROM chat_conversations WHERE id = $1`,
			[conversationId],
		);
		expect(kind.rows[0].kind).toBe('assistant');
		const dflt = await h.db.query<{ kind: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel)
			 VALUES ($1, $2, $3, 'web') RETURNING kind::text AS kind`,
			[memberId, teamId, projectId],
		);
		expect(dflt.rows[0].kind).toBe('assistant');
		const group = await h.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (team_id, project_id, channel, kind, title)
			 VALUES ($1, $2, 'web', 'group', 'Launch room') RETURNING id`,
			[teamId, projectId],
		);
		expect(group.rows[0].id).toBeDefined();
		// The scope CHECK: a memberless conversation is only legal as a group.
		await expect(
			h.db.query(
				`INSERT INTO chat_conversations (team_id, project_id, channel) VALUES ($1, $2, 'web')`,
				[teamId, projectId],
			),
		).rejects.toThrow();
		// And an unknown kind still fails after the type swap.
		await expect(
			h.db.query(
				`INSERT INTO chat_conversations (team_id, project_id, channel, kind) VALUES ($1, $2, 'web', 'party')`,
				[teamId, projectId],
			),
		).rejects.toThrow();
	});

	it('enforces one General room per project', async () => {
		await h.db.query(
			`INSERT INTO chat_conversations (team_id, project_id, channel, kind, is_general, title)
			 VALUES ($1, $2, 'web', 'group', true, 'General')`,
			[teamId, projectId],
		);
		await expect(
			h.db.query(
				`INSERT INTO chat_conversations (team_id, project_id, channel, kind, is_general, title)
				 VALUES ($1, $2, 'web', 'group', true, 'General')`,
				[teamId, projectId],
			),
		).rejects.toThrow();
	});

	it('tracks participants per room, deduplicated, and gone with the room', async () => {
		const room = await h.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (team_id, project_id, channel, kind, title)
			 VALUES ($1, $2, 'web', 'group', 'Standup') RETURNING id`,
			[teamId, projectId],
		);
		const roomId = room.rows[0].id;
		await h.db.query(
			`INSERT INTO chat_conversation_participants (conversation_id, member_id) VALUES ($1, $2)`,
			[roomId, memberId],
		);
		await expect(
			h.db.query(
				`INSERT INTO chat_conversation_participants (conversation_id, member_id) VALUES ($1, $2)`,
				[roomId, memberId],
			),
		).rejects.toThrow();
		await h.db.query(`DELETE FROM chat_conversations WHERE id = $1`, [roomId]);
		const left = await h.db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM chat_conversation_participants WHERE conversation_id = $1`,
			[roomId],
		);
		expect(left.rows[0].n).toBe(0);
	});

	it('keeps member memories and admits room-scoped ones, exactly one scope each', async () => {
		const kept = await h.db.query<{ content: string }>(
			`SELECT content FROM chat_memories WHERE member_id = $1`,
			[memberId],
		);
		expect(kept.rows[0].content).toBe('the plan');
		const room = await h.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (team_id, project_id, channel, kind, title)
			 VALUES ($1, $2, 'web', 'group', 'Retro') RETURNING id`,
			[teamId, projectId],
		);
		const roomId = room.rows[0].id;
		await h.db.query(`INSERT INTO chat_memories (conversation_id, content) VALUES ($1, 'gist')`, [
			roomId,
		]);
		await expect(
			h.db.query(
				`INSERT INTO chat_memories (member_id, conversation_id, content) VALUES ($1, $2, 'both')`,
				[memberId, roomId],
			),
		).rejects.toThrow();
		await expect(
			h.db.query(`INSERT INTO chat_memories (content) VALUES ('neither')`),
		).rejects.toThrow();
		// Room memory dies with its room; the member row is untouched.
		await h.db.query(`DELETE FROM chat_conversations WHERE id = $1`, [roomId]);
		const gone = await h.db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM chat_memories WHERE conversation_id = $1`,
			[roomId],
		);
		expect(gone.rows[0].n).toBe(0);
	});

	it('carries a coworker thread through the enum recreate, open and untouched', async () => {
		const row = await h.db.query<{ kind: string; closed_at: string | null }>(
			`SELECT kind::text AS kind, closed_at FROM chat_conversations WHERE id = $1`,
			[coworkerId],
		);
		expect(row.rows[0].kind).toBe('coworker');
		// The single-stream close targets only open web assistant threads.
		expect(row.rows[0].closed_at).toBeNull();
	});

	it('severs last_message_id when its message goes, never the conversation', async () => {
		const convo = await h.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel, external_thread_id)
			 VALUES ($1, $2, $3, 'web', 'sever-probe') RETURNING id`,
			[memberId, teamId, projectId],
		);
		const msg = await h.db.query<{ id: string }>(
			`INSERT INTO chat_messages (conversation_id, role, channel, status, content)
			 VALUES ($1, 'user', 'web', 'complete', 'soon gone') RETURNING id`,
			[convo.rows[0].id],
		);
		await h.db.query(`UPDATE chat_conversations SET last_message_id = $2 WHERE id = $1`, [
			convo.rows[0].id,
			msg.rows[0].id,
		]);
		await h.db.query(`DELETE FROM chat_messages WHERE id = $1`, [msg.rows[0].id]);
		const after = await h.db.query<{ last_message_id: string | null }>(
			`SELECT last_message_id FROM chat_conversations WHERE id = $1`,
			[convo.rows[0].id],
		);
		expect(after.rows[0].last_message_id).toBeNull();
	});

	it('allows one General per project, so a second project gets its own', async () => {
		const team2 = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Second', 'second-team') RETURNING id`,
		);
		const project2 = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Second', 'second', 'SE') RETURNING id`,
			[team2.rows[0].id],
		);
		await expect(
			h.db.query(
				`INSERT INTO chat_conversations (team_id, project_id, channel, kind, is_general, title)
				 VALUES ($1, $2, 'web', 'group', true, 'General')`,
				[team2.rows[0].id, project2.rows[0].id],
			),
		).resolves.toBeDefined();
	});

	it('drops the pool pin flag, keeps the member and the ledger history', async () => {
		// The member row survives the column drop.
		const member = await h.db.query<{ state: string }>(
			`SELECT state::text AS state FROM container_pool_members WHERE container_id = 'hq-pinned'`,
		);
		expect(member.rows[0].state).toBe('idle');
		// The pin column is gone from the pool - a missed read now fails loudly.
		const poolCols = await h.db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_name = 'container_pool_members' AND column_name = 'reserved_for_chat'`,
		);
		expect(poolCols.rows).toHaveLength(0);
		// 053's partial idle index died with the column; the recreate covers every
		// member, predicate-free.
		const idx = await h.db.query<{ indexdef: string }>(
			`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_container_pool_members_idle'`,
		);
		expect(idx.rows).toHaveLength(1);
		expect(idx.rows[0].indexdef).not.toContain('WHERE');
		// The uptime ledger keeps its recorded history from the pinned era.
		const ledger = await h.db.query<{ reserved_for_chat: boolean }>(
			`SELECT reserved_for_chat FROM container_uptime_entries WHERE container_id = 'hq-pinned'`,
		);
		expect(ledger.rows[0].reserved_for_chat).toBe(true);
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
