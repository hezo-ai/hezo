import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '050_chat_session_suspended.sql';

/**
 * A chat session survives its container being suspended.
 *
 * The interesting part is the singleton guard, not the enum value: a suspended
 * session still owns its row and its container, so it has to keep blocking a
 * second session the way a running one does. Stating the predicate as "not
 * terminal" is what makes that true without naming the new value - which the
 * same transaction could not use anyway.
 */
describe('050_chat_session_suspended migration', () => {
	let h: DataPreservationHarness;
	let memberId: string;
	let otherMemberId: string;
	let teamId: string;
	let projectId: string;
	let runningSessionId: string;
	let stoppedSessionId: string;

	const insertSession = async (member: string, status: string): Promise<string> => {
		const r = await h.db.query<{ id: string }>(
			`INSERT INTO chat_sessions (member_id, team_id, project_id, container_id, runtime_type, status)
			 VALUES ($1, $2, $3, 'ctr-chat', 'claude_code', $4::chat_session_status) RETURNING id`,
			[member, teamId, projectId, status],
		);
		return r.rows[0].id;
	};

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('HQ', 'hq') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, is_internal)
			 VALUES ($1, 'HQ', 'hq', 'HQ', true) RETURNING id`,
			[teamId],
		);
		projectId = project.rows[0].id;
		const member = async (name: string): Promise<string> => {
			const r = await h.db.query<{ id: string }>(
				`INSERT INTO members (team_id, display_name, member_type) VALUES ($1, $2, 'agent') RETURNING id`,
				[teamId, name],
			);
			return r.rows[0].id;
		};
		memberId = await member('CEO');
		otherMemberId = await member('Coach');

		runningSessionId = await insertSession(memberId, 'running');
		stoppedSessionId = await insertSession(otherMemberId, 'stopped');

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds the suspended status', async () => {
		const r = await h.db.query<{ label: string }>(
			`SELECT e.enumlabel AS label FROM pg_enum e
			 JOIN pg_type t ON t.oid = e.enumtypid
			 WHERE t.typname = 'chat_session_status' ORDER BY e.enumsortorder`,
		);
		expect(r.rows.map((row) => row.label)).toEqual([
			'starting',
			'running',
			'crashed',
			'stopped',
			'suspended',
		]);
	});

	it('preserves the pre-existing sessions and their statuses', async () => {
		const r = await h.db.query<{ id: string; status: string }>(
			'SELECT id, status::text FROM chat_sessions ORDER BY status',
		);
		expect(r.rows).toEqual([
			{ id: runningSessionId, status: 'running' },
			{ id: stoppedSessionId, status: 'stopped' },
		]);
	});

	it('lets an existing session move to suspended', async () => {
		await h.db.query(
			`UPDATE chat_sessions SET status = 'suspended'::chat_session_status WHERE id = $1`,
			[runningSessionId],
		);
		const r = await h.db.query<{ status: string }>(
			'SELECT status::text FROM chat_sessions WHERE id = $1',
			[runningSessionId],
		);
		expect(r.rows[0].status).toBe('suspended');
	});

	it('counts a suspended session as live in the singleton guard', async () => {
		// It still owns its row and its container; a second session alongside it
		// would give the operator two chats racing the same container.
		await expect(insertSession(memberId, 'starting')).rejects.toThrow();
	});

	it('still allows a fresh session once the previous one ended', async () => {
		await h.db.query(
			`UPDATE chat_sessions SET status = 'stopped'::chat_session_status WHERE id = $1`,
			[runningSessionId],
		);
		const fresh = await insertSession(memberId, 'starting');
		expect(fresh).toBeTruthy();
		// And the guard still holds against the new one.
		await expect(insertSession(memberId, 'running')).rejects.toThrow();
	});
});
