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
let teamId: string;
let teamSlug: string;
let otherInternalSlug: string;
let projectSlug: string;
let otherProjectSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const makeTeam = async (name: string) => {
		const r = await createTestTeam(db, { name });
		return (await r.json()).data as { id: string; slug: string };
	};

	const team = await makeTeam('Mentions Co');
	teamId = team.id;
	teamSlug = team.slug;
	const otherTeam = await makeTeam('Other Mentions Co');
	otherInternalSlug = `${await projectSlugFor(db, otherTeam.id)}`;

	// The primary project (notes.md + the onboarding skill) lives in `teamId`.
	const projA = await createTestProject(db, teamId, {
		name: 'Operations Hub',
		description: 'Ops project.',
	});
	const projAData = (await projA.json()).data as { id: string; slug: string };
	projectSlug = projAData.slug;
	await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Picker Bot' }),
	});

	// Under the 1:1 teams↔projects model a distinct second project (spec.md, used
	// to prove bare search stays scoped to the current project) requires its own team.
	const betaTeam = await makeTeam('Beta Service Co');
	const projB = await createTestProject(db, betaTeam.id, {
		name: 'Beta Service',
		description: 'Beta project.',
	});
	const projBData = (await projB.json()).data as { id: string; slug: string };
	otherProjectSlug = projBData.slug;

	// kb docs were unified into the global skills database; mentions resolve/search read from skills.
	// Skills are referenced by slug; mentions still address them by a filename-shaped slug.
	await app.request('/api/skills', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Onboarding Guide',
			slug: 'onboarding-guide.md',
			content: 'Hello onboarding world',
		}),
	});

	await app.request(`/api/projects/${projectSlug}/docs/notes.md`, {
		method: 'PUT',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ content: 'Some ops notes.' }),
	});

	await app.request(`/api/projects/${projectSlug}/docs/runbook.md`, {
		method: 'PUT',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ content: 'Ops runbook.' }),
	});

	// spec.md lives on a project in a *different* team, so bare search scoped to
	// the primary project must never surface it. Resolve is team-scoped, so it
	// also stays invisible from the primary team — exercised below.
	await app.request(`/api/projects/${otherProjectSlug}/docs/spec.md`, {
		method: 'PUT',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ content: 'Beta service spec.' }),
	});
});

afterAll(async () => {
	await safeClose(db);
});

describe('POST /teams/:teamId/docs/resolve', () => {
	it('resolves kb docs with title, size, updated_at', async () => {
		const r = await app.request(`/api/projects/${projectSlug}/docs/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ kb_slugs: ['onboarding-guide.md'] }),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.data.kb_docs).toHaveLength(1);
		const doc = body.data.kb_docs[0];
		expect(doc.slug).toBe('onboarding-guide.md');
		expect(doc.title).toBe('Onboarding Guide');
		expect(doc.size).toBe('Hello onboarding world'.length);
		expect(typeof doc.updated_at).toBe('string');
	});

	it('resolves project docs matching project_slug + filename', async () => {
		const r = await app.request(`/api/projects/${projectSlug}/docs/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_docs: [
					{ project_slug: projectSlug, filename: 'notes.md' },
					{ project_slug: projectSlug, filename: 'runbook.md' },
				],
			}),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.data.project_docs).toHaveLength(2);
		const byKey = new Map<string, { size: number }>();
		for (const d of body.data.project_docs as Array<{
			project_slug: string;
			filename: string;
			size: number;
		}>) {
			byKey.set(`${d.project_slug}/${d.filename}`, { size: d.size });
		}
		expect(byKey.get(`${projectSlug}/notes.md`)?.size).toBe('Some ops notes.'.length);
		expect(byKey.get(`${projectSlug}/runbook.md`)?.size).toBe('Ops runbook.'.length);
	});

	it('resolves global kb docs everywhere but keeps project docs team-scoped', async () => {
		const r = await app.request(`/api/projects/${otherInternalSlug}/docs/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				kb_slugs: ['onboarding-guide.md'],
				project_docs: [{ project_slug: projectSlug, filename: 'notes.md' }],
			}),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		// Skills are instance-global: the kb doc resolves from any team's context.
		expect(body.data.kb_docs).toHaveLength(1);
		// Project docs remain team-scoped — another team's project doc is not resolved.
		expect(body.data.project_docs).toHaveLength(0);
	});

	it('rejects oversize payloads', async () => {
		const big = Array.from({ length: 101 }, (_, i) => `slug-${i}`);
		const r = await app.request(`/api/projects/${projectSlug}/docs/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ kb_slugs: big }),
		});
		expect(r.status).toBe(400);
	});
});

describe('GET /teams/:teamId/mentions/search', () => {
	it('returns agents, kb docs, and project docs when project_slug is provided', async () => {
		const r = await app.request(
			`/api/projects/${projectSlug}/mentions/search?q=&kind=all&limit=10&project_slug=${encodeURIComponent(projectSlug)}`,
			{ headers: authHeader(token) },
		);
		expect(r.status).toBe(200);
		const body = await r.json();
		const kinds = new Set((body.data as Array<{ kind: string }>).map((row) => row.kind));
		expect(kinds.has('agent')).toBe(true);
		expect(kinds.has('kb')).toBe(true);
		expect(kinds.has('doc')).toBe(true);
	});

	it('filters by query string', async () => {
		const r = await app.request(`/api/projects/${projectSlug}/mentions/search?q=onboard&kind=all`, {
			headers: authHeader(token),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		const handles = (body.data as Array<{ handle: string }>).map((row) => row.handle);
		expect(handles).toContain('onboarding-guide.md');
	});

	it('returns bare filenames for docs in the current project', async () => {
		const r = await app.request(
			`/api/projects/${projectSlug}/mentions/search?q=notes&kind=doc&project_slug=${encodeURIComponent(projectSlug)}`,
			{ headers: authHeader(token) },
		);
		expect(r.status).toBe(200);
		const body = await r.json();
		const rows = body.data as Array<{ handle: string; kind: string }>;
		expect(rows.some((row) => row.handle === 'notes.md')).toBe(true);
	});

	it('does not surface docs from other projects via bare search', async () => {
		const r = await app.request(
			`/api/projects/${projectSlug}/mentions/search?q=spec&kind=doc&project_slug=${encodeURIComponent(projectSlug)}`,
			{ headers: authHeader(token) },
		);
		expect(r.status).toBe(200);
		const body = await r.json();
		const rows = body.data as Array<{ handle: string; kind: string }>;
		expect(rows.every((row) => row.handle !== 'spec.md')).toBe(true);
	});

	it('omits docs entirely when project_slug is absent', async () => {
		const r = await app.request(`/api/projects/${projectSlug}/mentions/search?q=notes&kind=doc`, {
			headers: authHeader(token),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		const rows = body.data as Array<{ handle: string; kind: string }>;
		expect(rows).toHaveLength(0);
	});

	it('surfaces global kb skills from any team context', async () => {
		const r = await app.request(
			`/api/projects/${otherInternalSlug}/mentions/search?q=onboard&kind=all`,
			{
				headers: authHeader(token),
			},
		);
		expect(r.status).toBe(200);
		const body = await r.json();
		const handles = (body.data as Array<{ handle: string }>).map((row) => row.handle);
		// Skills are instance-global, so the kb doc is searchable from every team.
		expect(handles).toContain('onboarding-guide.md');
	});

	it('surfaces the HQ instance agents (CEO/Coach) from a non-HQ project', async () => {
		const ceoRes = await app.request(
			`/api/projects/${projectSlug}/mentions/search?q=ceo&kind=agent`,
			{ headers: authHeader(token) },
		);
		expect(ceoRes.status).toBe(200);
		const ceoHandles = ((await ceoRes.json()).data as Array<{ handle: string }>).map(
			(row) => row.handle,
		);
		expect(ceoHandles).toContain('ceo');

		const coachRes = await app.request(
			`/api/projects/${projectSlug}/mentions/search?q=coach&kind=agent`,
			{ headers: authHeader(token) },
		);
		expect(coachRes.status).toBe(200);
		const coachHandles = ((await coachRes.json()).data as Array<{ handle: string }>).map(
			(row) => row.handle,
		);
		expect(coachHandles).toContain('coach');
	});

	it('lists each HQ instance agent exactly once (no team/HQ duplication)', async () => {
		const r = await app.request(
			`/api/projects/${projectSlug}/mentions/search?q=&kind=agent&limit=50`,
			{ headers: authHeader(token) },
		);
		expect(r.status).toBe(200);
		const handles = ((await r.json()).data as Array<{ handle: string }>).map((row) => row.handle);
		expect(handles.filter((h) => h === 'ceo')).toHaveLength(1);
		expect(handles.filter((h) => h === 'coach')).toHaveLength(1);
		// The team's own roster still appears alongside the instance agents.
		expect(handles).toContain('picker-bot');
	});
});
