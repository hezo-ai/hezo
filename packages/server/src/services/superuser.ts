import { DEFAULT_TEAM_ID, MemberType } from '@hezo/shared';
import type { Db } from '../db/database';

/**
 * The instance's single superuser.
 *
 * One instance has one superuser, seeded the first time someone completes the
 * master-key setup. Several sign-in paths need to reach it and they do not agree
 * on whether it may be created: setup makes one, while every later path is
 * asking about an instance that has already been set up, and creating a
 * superuser there would turn "this instance is not ready" into a silent success.
 */

/** The superuser's id, or null on an instance that has not been set up. */
export async function getSuperuserId(db: Db): Promise<string | null> {
	const result = await db.query<{ id: string }>(
		'SELECT id FROM users WHERE is_superuser = true ORDER BY created_at LIMIT 1',
	);
	return result.rows[0]?.id ?? null;
}

/** The superuser's id, creating the account and its team membership if absent. */
export async function ensureSuperuserId(db: Db): Promise<string> {
	const existing = await getSuperuserId(db);
	if (existing) return existing;

	const inserted = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Admin', true) RETURNING id",
	);
	const userId = inserted.rows[0].id;
	await addUserToDefaultTeam(db, userId);
	return userId;
}

async function addUserToDefaultTeam(db: Db, userId: string): Promise<void> {
	const existing = await db.query(
		`SELECT m.id FROM members m
		 JOIN member_users mu ON mu.id = m.id
		 WHERE mu.user_id = $1 AND m.team_id = $2`,
		[userId, DEFAULT_TEAM_ID],
	);
	if (existing.rows.length > 0) return;

	const member = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, $2, (SELECT display_name FROM users WHERE id = $3))
		 RETURNING id`,
		[DEFAULT_TEAM_ID, MemberType.User, userId],
	);
	await db.query(`INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, 'admin')`, [
		member.rows[0].id,
		userId,
	]);
}
