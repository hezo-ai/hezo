import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
});

afterAll(async () => {
	await safeClose(db);
});

describe('instance-level skills', () => {
	it('an instance skill (team_id NULL) is shared with every team', async () => {
		// Create an instance-level skill.
		const createRes = await app.request('/api/skills', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Shared Convention', content: '# Shared\nUse tabs.' }),
		});
		expect(createRes.status).toBe(201);
		const skill = (await createRes.json()).data;
		expect(skill.team_id).toBeNull();

		// It is listed under the instance skills.
		const instRes = await app.request('/api/skills', { headers: authHeader(token) });
		expect((await instRes.json()).data.some((s: { slug: string }) => s.slug === skill.slug)).toBe(
			true,
		);

		// A team's own skills list includes the instance skill.
		const teamRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Skills Team' }),
		});
		const teamId = (await teamRes.json()).data.id;
		const teamSkillsRes = await app.request(`/api/teams/${teamId}/skills`, {
			headers: authHeader(token),
		});
		const teamSkills = (await teamSkillsRes.json()).data as { slug: string }[];
		expect(teamSkills.some((s) => s.slug === skill.slug)).toBe(true);

		// And it is readable by slug under the team (instance fallback).
		const oneRes = await app.request(`/api/teams/${teamId}/skills/${skill.slug}`, {
			headers: authHeader(token),
		});
		expect(oneRes.status).toBe(200);
		expect((await oneRes.json()).data.team_id).toBeNull();
	});

	it('edits and deletes an instance skill', async () => {
		const createRes = await app.request('/api/skills', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Editable', content: '# v1' }),
		});
		const slug = (await createRes.json()).data.slug;

		// PATCH content + tags.
		const patch = await app.request(`/api/skills/${slug}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '# v2 updated', tags: ['ops'] }),
		});
		expect(patch.status).toBe(200);
		const patched = (await patch.json()).data;
		expect(patched.content).toBe('# v2 updated');
		expect(patched.tags).toEqual(['ops']);
		expect(patched.team_id).toBeNull();

		// DELETE.
		const del = await app.request(`/api/skills/${slug}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(200);

		const list = await app.request('/api/skills', { headers: authHeader(token) });
		expect((await list.json()).data.some((s: { slug: string }) => s.slug === slug)).toBe(false);

		// DELETE again → 404.
		const again = await app.request(`/api/skills/${slug}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(again.status).toBe(404);
	});
});
