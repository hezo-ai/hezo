import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugFor } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let projectSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Pref Test Co' });
	const team = (await teamRes.json()).data as { slug: string };
	projectSlug = `${await projectSlugFor(db, team.id)}`;
});

afterAll(async () => {
	await safeClose(db);
});

describe('Team preferences', () => {
	it('returns null when no preferences exist', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/preferences`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toBeNull();
	});

	it('creates preferences on first PATCH', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/preferences`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content: '# Preferences\n\nPrefer functional patterns.',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.content).toContain('functional patterns');
	});

	it('reads preferences after creation', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/preferences`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.content).toContain('functional patterns');
	});

	it('updates preferences and creates revision', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/preferences`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content: '# Preferences\n\nPrefer functional patterns.\nUse dark themes.',
				change_summary: 'Added dark themes preference',
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.content).toContain('dark themes');

		// Check revision was created with previous content
		const revRes = await app.request(`/api/projects/${projectSlug}/preferences/revisions`, {
			headers: authHeader(token),
		});
		expect(revRes.status).toBe(200);
		const revBody = await revRes.json();
		expect(revBody.data.length).toBe(1);
		expect(revBody.data[0].content).toContain('functional patterns');
		expect(revBody.data[0].content).not.toContain('dark themes');
		expect(revBody.data[0].change_summary).toBe('Added dark themes preference');
	});

	it('returns empty revisions when no preferences exist', async () => {
		const coRes = await createTestTeam(db, { name: 'Empty Prefs Co' });
		const emptyTeam = (await coRes.json()).data as { slug: string };

		const res = await app.request(
			`/api/projects/${await projectSlugFor(db, emptyTeam.id)}/preferences/revisions`,
			{
				headers: authHeader(token),
			},
		);
		expect(res.status).toBe(200);
		expect((await res.json()).data).toEqual([]);
	});

	it('restores preferences to a prior revision', async () => {
		await app.request(`/api/projects/${projectSlug}/preferences`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content: '# Preferences\n\nReverted body',
				change_summary: 'pre-restore checkpoint',
			}),
		});

		const restoreRes = await app.request(`/api/projects/${projectSlug}/preferences/restore`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ revision_number: 1 }),
		});
		expect(restoreRes.status).toBe(200);
		const restored = await restoreRes.json();
		expect(restored.data.content).toContain('functional patterns');
		expect(restored.data.content).not.toContain('Reverted body');

		const revRes = await app.request(`/api/projects/${projectSlug}/preferences/revisions`, {
			headers: authHeader(token),
		});
		const revs = (await revRes.json()).data;
		expect(revs[0].change_summary).toBe('Restored content from revision 1');
	});

	it('returns 404 when restoring an unknown revision number', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/preferences/restore`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ revision_number: 9999 }),
		});
		expect(res.status).toBe(404);
	});
});
