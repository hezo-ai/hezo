import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugFor } from './helpers/app';

/**
 * Remaining branch coverage for packages/server/src/routes/teams.ts not reached
 * by teams.test.ts / team-save-as-template.test.ts / team-template-apply.test.ts:
 *   - PATCH team: name+slug regeneration, mcp_servers / mpp_config / settings
 *     merge fields, and the empty-set no-op read-back
 *   - save-as-template / apply-type requireAdminEquivalent denial (403)
 *   - apply-type missing template_id (400)
 */

let app: Hono<Env>;
let db: Db;
let token: string;
let nonAdminToken: string;
let projectSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const plain = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Plain User', false) RETURNING id",
	);
	nonAdminToken = await signAdminJwt(ctx.masterKeyManager, plain.rows[0].id);

	const teamRes = await createTestTeam(db, { name: 'Teams Branch Co' });
	const teamId = (await teamRes.json()).data.id;
	projectSlug = await projectSlugFor(db, teamId);
});

afterAll(async () => {
	await safeClose(db);
});

function jsonHeaders(t: string) {
	return { ...authHeader(t), 'Content-Type': 'application/json' };
}

describe('PATCH /projects/:projectId/team — field arms', () => {
	it('renames the team and regenerates the slug', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/team`, {
			method: 'PATCH',
			headers: jsonHeaders(token),
			body: JSON.stringify({ name: 'Renamed Branch Team' }),
		});
		expect(res.status).toBe(200);
		const row = (await res.json()).data as { name: string; slug: string };
		expect(row.name).toBe('Renamed Branch Team');
		expect(row.slug).toBe('renamed-branch-team');
	});

	it('merges mcp_servers, mpp_config, and settings jsonb', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/team`, {
			method: 'PATCH',
			headers: jsonHeaders(token),
			body: JSON.stringify({
				mcp_servers: [{ name: 'svc' }],
				mpp_config: { mode: 'fast' },
				settings: { theme: 'dark' },
			}),
		});
		expect(res.status).toBe(200);
		const row = (await res.json()).data as {
			mcp_servers: Array<{ name: string }>;
			mpp_config: { mode: string };
			settings: { theme: string };
		};
		expect(row.mcp_servers[0].name).toBe('svc');
		expect(row.mpp_config.mode).toBe('fast');
		expect(row.settings.theme).toBe('dark');
	});

	it('merges (does not replace) the settings jsonb across two PATCHes', async () => {
		await app.request(`/api/projects/${projectSlug}/team`, {
			method: 'PATCH',
			headers: jsonHeaders(token),
			body: JSON.stringify({ settings: { density: 'compact' } }),
		});
		const res = await app.request(`/api/projects/${projectSlug}/team`, {
			method: 'PATCH',
			headers: jsonHeaders(token),
			body: JSON.stringify({ settings: { locale: 'en' } }),
		});
		const row = (await res.json()).data as { settings: Record<string, string> };
		// settings = settings || $::jsonb — both keys persist.
		expect(row.settings.density).toBe('compact');
		expect(row.settings.locale).toBe('en');
	});

	it('treats an empty PATCH as a no-op read-back', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/team`, {
			method: 'PATCH',
			headers: jsonHeaders(token),
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.id).toBeTruthy();
	});
});

describe('save-as-template / apply-type — authorization + validation arms', () => {
	it('403s save-as-template for a non-superuser admin', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/save-as-template`, {
			method: 'POST',
			headers: jsonHeaders(nonAdminToken),
			body: JSON.stringify({ name: 'My Type' }),
		});
		expect(res.status).toBe(403);
	});

	it('403s apply-type for a non-superuser admin', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/apply-type`, {
			method: 'POST',
			headers: jsonHeaders(nonAdminToken),
			body: JSON.stringify({ template_id: '00000000-0000-0000-0000-000000000000' }),
		});
		expect(res.status).toBe(403);
	});

	it('400s apply-type when template_id is missing', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/apply-type`, {
			method: 'POST',
			headers: jsonHeaders(token),
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/template_id is required/);
	});
});
