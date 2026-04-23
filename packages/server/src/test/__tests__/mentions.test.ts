import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;
let otherCompanyId: string;
let projectSlug: string;
let otherProjectSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const makeCompany = async (name: string) => {
		const r = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name }),
		});
		return (await r.json()).data.id as string;
	};

	companyId = await makeCompany('Mentions Co');
	otherCompanyId = await makeCompany('Other Mentions Co');

	await app.request(`/api/companies/${companyId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Picker Bot' }),
	});

	const projA = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Operations Hub', description: 'Ops project.' }),
	});
	const projAData = (await projA.json()).data as { id: string; slug: string };
	projectSlug = projAData.slug;

	const projB = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Beta Service', description: 'Beta project.' }),
	});
	const projBData = (await projB.json()).data as { id: string; slug: string };
	otherProjectSlug = projBData.slug;

	await app.request(`/api/companies/${companyId}/kb-docs`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Onboarding Guide', content: 'Hello onboarding world' }),
	});

	await app.request(`/api/companies/${companyId}/projects/${projectSlug}/docs/notes.md`, {
		method: 'PUT',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ content: 'Some ops notes.' }),
	});

	await app.request(`/api/companies/${companyId}/projects/${otherProjectSlug}/docs/spec.md`, {
		method: 'PUT',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ content: 'Beta service spec.' }),
	});
});

afterAll(async () => {
	await safeClose(db);
});

describe('POST /companies/:companyId/docs/resolve', () => {
	it('resolves kb docs with title, size, updated_at', async () => {
		const r = await app.request(`/api/companies/${companyId}/docs/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ kb_slugs: ['onboarding-guide'] }),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.data.kb_docs).toHaveLength(1);
		const doc = body.data.kb_docs[0];
		expect(doc.slug).toBe('onboarding-guide');
		expect(doc.title).toBe('Onboarding Guide');
		expect(doc.size).toBe('Hello onboarding world'.length);
		expect(typeof doc.updated_at).toBe('string');
	});

	it('resolves project docs matching project_slug + filename', async () => {
		const r = await app.request(`/api/companies/${companyId}/docs/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_docs: [
					{ project_slug: projectSlug, filename: 'notes.md' },
					{ project_slug: otherProjectSlug, filename: 'spec.md' },
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
		expect(byKey.get(`${otherProjectSlug}/spec.md`)?.size).toBe('Beta service spec.'.length);
	});

	it('does not cross company boundaries', async () => {
		const r = await app.request(`/api/companies/${otherCompanyId}/docs/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				kb_slugs: ['onboarding-guide'],
				project_docs: [{ project_slug: projectSlug, filename: 'notes.md' }],
			}),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.data.kb_docs).toHaveLength(0);
		expect(body.data.project_docs).toHaveLength(0);
	});

	it('rejects oversize payloads', async () => {
		const big = Array.from({ length: 101 }, (_, i) => `slug-${i}`);
		const r = await app.request(`/api/companies/${companyId}/docs/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ kb_slugs: big }),
		});
		expect(r.status).toBe(400);
	});
});

describe('GET /companies/:companyId/mentions/search', () => {
	it('returns agents, issues, kb docs, and project docs', async () => {
		const r = await app.request(
			`/api/companies/${companyId}/mentions/search?q=&kind=all&limit=10`,
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
		const r = await app.request(`/api/companies/${companyId}/mentions/search?q=onboard&kind=all`, {
			headers: authHeader(token),
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		const handles = (body.data as Array<{ handle: string }>).map((row) => row.handle);
		expect(handles).toContain('kb/onboarding-guide');
	});

	it('prefers short-form handles when project_slug matches', async () => {
		const r = await app.request(
			`/api/companies/${companyId}/mentions/search?q=notes&kind=doc&project_slug=${encodeURIComponent(projectSlug)}`,
			{ headers: authHeader(token) },
		);
		expect(r.status).toBe(200);
		const body = await r.json();
		const rows = body.data as Array<{ handle: string; kind: string }>;
		expect(rows.some((row) => row.handle === 'doc/notes.md')).toBe(true);
	});

	it('falls back to qualified handles for docs in other projects', async () => {
		const r = await app.request(
			`/api/companies/${companyId}/mentions/search?q=spec&kind=doc&project_slug=${encodeURIComponent(projectSlug)}`,
			{ headers: authHeader(token) },
		);
		expect(r.status).toBe(200);
		const body = await r.json();
		const rows = body.data as Array<{ handle: string; kind: string }>;
		expect(rows.some((row) => row.handle === `doc/${otherProjectSlug}/spec.md`)).toBe(true);
	});

	it('does not leak results across companies', async () => {
		const r = await app.request(
			`/api/companies/${otherCompanyId}/mentions/search?q=onboard&kind=all`,
			{ headers: authHeader(token) },
		);
		expect(r.status).toBe(200);
		const body = await r.json();
		const handles = (body.data as Array<{ handle: string }>).map((row) => row.handle);
		expect(handles).not.toContain('kb/onboarding-guide');
	});
});
