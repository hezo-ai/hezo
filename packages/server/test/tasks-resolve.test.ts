import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	projectSlugFor,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let projectSlug: string;
let teamId: string;
let otherInternalSlug: string;
let projectAId: string;
let projectBId: string;
let projectASlug: string;
let projectBSlug: string;
let agentId: string;
let aIdentifier: string;
let bIdentifier: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const makeTeam = async (name: string) => {
		const r = await createTestTeam(db, { name });
		return (await r.json()).data as { id: string; slug: string };
	};

	const team = await makeTeam('Resolve Co');
	teamId = team.id;
	const otherTeam = await makeTeam('Other Resolve Co');
	otherInternalSlug = `${await projectSlugFor(db, otherTeam.id)}`;

	const agentRes = await app.request(`/api/projects/${await projectSlugFor(db, team.id)}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Worker Bot' }),
	});
	agentId = (await agentRes.json()).data.id;

	const makeProject = async (name: string, description: string) => {
		const r = await createTestProject(db, teamId, { name, description });
		return (await r.json()).data as { id: string; slug: string };
	};

	const projA = await makeProject('Alpha Portal', 'Alpha project description.');
	projectAId = projA.id;
	projectASlug = projA.slug;

	const projB = await makeProject('Beta Service', 'Beta project description.');
	projectBId = projB.id;
	projectBSlug = projB.slug;

	const makeTask = async (projectId: string, title: string) => {
		const r = await app.request(`/api/projects/${await projectSlugFor(db, team.id)}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ project_id: projectId, title, assignee_id: agentId }),
		});
		return (await r.json()).data as { id: string; identifier: string };
	};
	aIdentifier = (await makeTask(projectAId, 'Alpha work')).identifier;
	bIdentifier = (await makeTask(projectBId, 'Beta work')).identifier;
});

afterAll(async () => {
	await safeClose(db);
});

describe('POST /teams/:teamId/tasks/resolve', () => {
	it('resolves known identifiers with title and project_slug', async () => {
		const r = await app.request(`/api/projects/${projectASlug}/tasks/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifiers: [aIdentifier, bIdentifier] }),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.data).toHaveLength(2);
		const byId = new Map(
			(body.data as Array<{ identifier: string; title: string; project_slug: string }>).map(
				(row) => [row.identifier.toLowerCase(), row],
			),
		);
		const a = byId.get(aIdentifier.toLowerCase());
		const b = byId.get(bIdentifier.toLowerCase());
		expect(a?.title).toBe('Alpha work');
		expect(a?.project_slug).toBe(projectASlug);
		expect(b?.title).toBe('Beta work');
		expect(b?.project_slug).toBe(projectBSlug);
	});

	it('is case-insensitive', async () => {
		const r = await app.request(`/api/projects/${projectASlug}/tasks/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifiers: [aIdentifier.toLowerCase()] }),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.data).toHaveLength(1);
		expect(body.data[0].identifier.toLowerCase()).toBe(aIdentifier.toLowerCase());
	});

	it('silently drops unknown identifiers', async () => {
		const r = await app.request(`/api/projects/${projectASlug}/tasks/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifiers: [aIdentifier, 'DOES-NOT-EXIST-999'] }),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.data).toHaveLength(1);
	});

	it("enforces team scoping (cannot resolve another team's task)", async () => {
		const r = await app.request(`/api/projects/${otherInternalSlug}/tasks/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifiers: [aIdentifier] }),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.data).toHaveLength(0);
	});

	it('rejects non-array body', async () => {
		const r = await app.request(`/api/projects/${projectASlug}/tasks/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifiers: 'nope' }),
		});
		expect(r.status).toBe(400);
	});

	it('rejects arrays longer than 100', async () => {
		const big = Array.from({ length: 101 }, (_, i) => `DOES-NOT-EXIST-${i}`);
		const r = await app.request(`/api/projects/${projectASlug}/tasks/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifiers: big }),
		});
		expect(r.status).toBe(400);
	});

	it('returns empty array for empty input', async () => {
		const r = await app.request(`/api/projects/${projectASlug}/tasks/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifiers: [] }),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.data).toEqual([]);
	});
});
