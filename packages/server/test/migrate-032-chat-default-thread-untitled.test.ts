import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '032_chat_default_thread_untitled.sql';

// Seeds three conversations at schema 031 — one titled 'Main' (the legacy default),
// one with a real user-visible title, and one already untitled — applies the
// migration, and asserts the 'Main' title is cleared to NULL while the real title
// and the already-NULL row are preserved untouched.
describe('032_chat_default_thread_untitled migration', () => {
	let h: DataPreservationHarness;
	let mainConvo: string;
	let namedConvo: string;
	let untitledConvo: string;

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

		const insert = async (title: string | null): Promise<string> => {
			const r = await h.db.query<{ id: string }>(
				`INSERT INTO chat_conversations (member_id, team_id, project_id, channel, title)
				 VALUES ($1, $2, $3, 'web', $4) RETURNING id`,
				[ceoId, teamId, projectId, title],
			);
			return r.rows[0].id;
		};
		mainConvo = await insert('Main');
		namedConvo = await insert('Roadmap');
		untitledConvo = await insert(null);

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it("clears the legacy 'Main' title to NULL", async () => {
		const r = await h.db.query<{ title: string | null }>(
			`SELECT title FROM chat_conversations WHERE id = $1`,
			[mainConvo],
		);
		expect(r.rows[0].title).toBeNull();
	});

	it('preserves a real user-visible title', async () => {
		const r = await h.db.query<{ title: string | null }>(
			`SELECT title FROM chat_conversations WHERE id = $1`,
			[namedConvo],
		);
		expect(r.rows[0].title).toBe('Roadmap');
	});

	it('leaves an already-untitled thread untouched', async () => {
		const r = await h.db.query<{ id: string; title: string | null }>(
			`SELECT id, title FROM chat_conversations WHERE id = $1`,
			[untitledConvo],
		);
		expect(r.rows.length).toBe(1);
		expect(r.rows[0].title).toBeNull();
	});
});
