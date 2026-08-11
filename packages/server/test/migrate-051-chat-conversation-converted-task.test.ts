import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '051_chat_conversation_converted_task.sql';

// Seeds a conversation and a task at schema 050, applies the conversion column
// migration, and asserts: pre-existing conversations survive with the new
// column NULL, the column is settable to a task, and deleting the task demotes
// the conversation (SET NULL) rather than blocking or cascading.
describe('051_chat_conversation_converted_task migration', () => {
	let h: DataPreservationHarness;
	let convoId: string;
	let taskId: string;

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
		const convo = await h.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel)
			 VALUES ($1, $2, $3, 'web') RETURNING id`,
			[ceoId, teamId, projectId],
		);
		convoId = convo.rows[0].id;
		const task = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, 1, 'HQ-1', 'From chat') RETURNING id`,
			[teamId, projectId],
		);
		taskId = task.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds converted_task_id, NULL on pre-existing rows, with data preserved', async () => {
		const row = await h.db.query<{ converted_task_id: string | null; channel: string }>(
			`SELECT converted_task_id, channel::text AS channel FROM chat_conversations WHERE id = $1`,
			[convoId],
		);
		expect(row.rows.length).toBe(1);
		expect(row.rows[0].converted_task_id).toBeNull();
		expect(row.rows[0].channel).toBe('web');
	});

	it('accepts a task reference on conversion', async () => {
		await h.db.query(
			`UPDATE chat_conversations SET converted_task_id = $2, closed_at = now() WHERE id = $1`,
			[convoId, taskId],
		);
		const row = await h.db.query<{ converted_task_id: string | null }>(
			`SELECT converted_task_id FROM chat_conversations WHERE id = $1`,
			[convoId],
		);
		expect(row.rows[0].converted_task_id).toBe(taskId);
	});

	it('demotes the conversation when the task is deleted (SET NULL, no cascade)', async () => {
		await h.db.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
		const row = await h.db.query<{ converted_task_id: string | null; closed_at: string | null }>(
			`SELECT converted_task_id, closed_at FROM chat_conversations WHERE id = $1`,
			[convoId],
		);
		expect(row.rows.length).toBe(1);
		expect(row.rows[0].converted_task_id).toBeNull();
		expect(row.rows[0].closed_at).not.toBeNull();
	});
});
