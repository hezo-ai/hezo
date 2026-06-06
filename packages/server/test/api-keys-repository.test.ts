import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	deleteApiKey,
	findApiKeyByPrefix,
	insertApiKey,
	listTeamApiKeys,
	touchApiKeyLastUsed,
} from '../src/repositories/api-keys';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

/**
 * Exercises the first Phase 3 repository directly against PGlite (not just
 * through the route), proving the typed Kysely-over-PGlite write/read/delete
 * path: parameterized INSERT … RETURNING, team-scoped ordered SELECT, and that
 * the public column list never leaks key_hash.
 */

let db: PGlite;
let teamId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	const teamRes = await ctx.app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Repo Co' }),
	});
	teamId = (await teamRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('api-keys repository', () => {
	it('inserts and returns the created row without key_hash', async () => {
		const row = await insertApiKey(db, {
			teamId,
			name: 'Repo Key',
			prefix: 'abcd1234',
			keyHash: 'deadbeef',
		});
		expect(row.id).toBeTruthy();
		expect(row.team_id).toBe(teamId);
		expect(row.name).toBe('Repo Key');
		expect(row.prefix).toBe('abcd1234');
		expect(row).not.toHaveProperty('key_hash');
	});

	it('lists keys for the team newest-first, public columns only', async () => {
		await insertApiKey(db, { teamId, name: 'Older', prefix: 'p0000000', keyHash: 'h0' });
		await insertApiKey(db, { teamId, name: 'Newer', prefix: 'p1111111', keyHash: 'h1' });

		const rows = await listTeamApiKeys(db, teamId);
		expect(rows.length).toBeGreaterThanOrEqual(3);
		// created_at DESC: the most recently inserted name appears before the older.
		const names = rows.map((r) => r.name);
		expect(names.indexOf('Newer')).toBeLessThan(names.indexOf('Older'));
		for (const r of rows) expect(r).not.toHaveProperty('key_hash');
	});

	it('scopes the list to the team', async () => {
		const rows = await listTeamApiKeys(db, '00000000-0000-0000-0000-000000000000');
		expect(rows).toHaveLength(0);
	});

	it('deletes a key by id', async () => {
		const row = await insertApiKey(db, {
			teamId,
			name: 'Doomed',
			prefix: 'pdddddd0',
			keyHash: 'hd',
		});
		await deleteApiKey(db, row.id);
		const rows = await listTeamApiKeys(db, teamId);
		expect(rows.find((r) => r.id === row.id)).toBeUndefined();
	});

	it('finds a key by prefix (exposing key_hash for the auth path) and stamps last_used_at', async () => {
		const created = await insertApiKey(db, {
			teamId,
			name: 'Auth Path',
			prefix: 'pauth000',
			keyHash: 'storedhash',
		});

		const found = await findApiKeyByPrefix(db, 'pauth000');
		expect(found).toBeDefined();
		expect(found?.id).toBe(created.id);
		expect(found?.team_id).toBe(teamId);
		expect(found?.key_hash).toBe('storedhash');

		expect(await findApiKeyByPrefix(db, 'nomatch0')).toBeUndefined();

		await touchApiKeyLastUsed(db, created.id);
		const [row] = await listTeamApiKeys(db, teamId).then((rows) =>
			rows.filter((r) => r.id === created.id),
		);
		expect(row.last_used_at).not.toBeNull();
	});
});
