import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { isAdminUserSql } from '../src/lib/admin-sql';
import { safeClose } from './helpers';
import { createTestApp, createTestTeam } from './helpers/app';

let db: Db;
let teamA: string;
let teamB: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	teamA = (await (await createTestTeam(db, { name: 'Admin SQL A' })).json()).data.id;
	teamB = (await (await createTestTeam(db, { name: 'Admin SQL B' })).json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

/** A user, a superuser or not, with a membership of `role` in each team given. */
async function user(superuser: boolean, memberships: Array<[string, 'admin' | 'member']>) {
	const u = await db.query<{ id: string }>(
		'INSERT INTO users (display_name, is_superuser) VALUES ($1, $2) RETURNING id',
		['Person', superuser],
	);
	for (const [team, role] of memberships) {
		const m = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name) VALUES ($1, 'user', 'Person')
			 RETURNING id`,
			[team],
		);
		await db.query(
			'INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, $3::membership_role)',
			[m.rows[0].id, u.rows[0].id, role],
		);
	}
	return u.rows[0].id;
}

async function isAdmin(userId: string | null, teamId: string): Promise<boolean> {
	const r = await db.query<{ admin: boolean }>(
		`SELECT ${isAdminUserSql('$1::uuid', '$2::uuid')} AS admin`,
		[userId, teamId],
	);
	return r.rows[0].admin;
}

describe('isAdminUserSql', () => {
	it("counts a team's admin for that team only", async () => {
		const id = await user(false, [[teamA, 'admin']]);
		expect(await isAdmin(id, teamA)).toBe(true);
		expect(await isAdmin(id, teamB)).toBe(false);
	});

	it('counts a superuser everywhere, even as a plain member of the team', async () => {
		expect(await isAdmin(await user(true, []), teamB)).toBe(true);
		expect(await isAdmin(await user(true, [[teamA, 'member']]), teamA)).toBe(true);
	});

	it('does not count a member who is not an admin, or no user at all', async () => {
		expect(await isAdmin(await user(false, [[teamA, 'member']]), teamA)).toBe(false);
		expect(await isAdmin(null, teamA)).toBe(false);
	});
});
