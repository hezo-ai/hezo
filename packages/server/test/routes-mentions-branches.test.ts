import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAdminJwt } from '../src/middleware/auth';
import { authHeader, createTestProject, createTestTeam } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

/**
 * Branch coverage for packages/server/src/routes/mentions.ts: the instance-wide
 * POST /mentions/resolve (HQ gate, array validation, dedupe/trim, signed asset
 * urls), the project-scoped POST /docs/resolve (kb slugs, project docs, asset
 * refs, cross-product filter, oversize 400), and GET /mentions/search across
 * every kind arm (admin suggestion, agents, tasks, kb, docs, limit clamping).
 */

let ctx: ServerTestContext;
let teamId: string;
let projectId: string;
let projectSlug: string;
let taskIdentifier: string;
let assetFilename: string;

function jsonHeaders(token: string): Record<string, string> {
	return { ...authHeader(token), 'Content-Type': 'application/json' };
}

beforeAll(async () => {
	ctx = await createTestContext();

	const teamRes = await createTestTeam(ctx.db, { name: 'Mention Branch Co' });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(ctx.db, teamId, { name: 'Mention Branch Project' });
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	// An agent to @-mention (unique slug instance-wide so /mentions/resolve links it).
	const agentRes = await ctx.app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: jsonHeaders(ctx.token),
		body: JSON.stringify({ title: 'Unique Mention Bot', slug: 'unique-mention-bot' }),
	});
	const mentionAgentId = (await agentRes.json()).data.id;

	// A task with a stable identifier.
	const taskRes = await ctx.app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: jsonHeaders(ctx.token),
		body: JSON.stringify({
			project_id: projectId,
			title: 'Wire the widget',
			assignee_id: mentionAgentId,
		}),
	});
	taskIdentifier = (await taskRes.json()).data.identifier;

	// A global skill (kb doc).
	await ctx.app.request('/api/skills', {
		method: 'POST',
		headers: jsonHeaders(ctx.token),
		body: JSON.stringify({
			name: 'Release Checklist',
			slug: 'release-checklist.md',
			content: 'Check everything twice.',
		}),
	});

	// A project doc.
	await ctx.app.request(`/api/projects/${projectSlug}/docs/handbook.md`, {
		method: 'PUT',
		headers: jsonHeaders(ctx.token),
		body: JSON.stringify({ content: 'Team handbook.' }),
	});

	// An uploaded asset.
	const fd = new FormData();
	fd.set(
		'file',
		new File([new TextEncoder().encode('# unique asset')], 'unique-brief.md', {
			type: 'text/markdown',
		}),
	);
	const assetRes = await ctx.app.request(`/api/projects/${projectSlug}/assets`, {
		method: 'POST',
		headers: authHeader(ctx.token),
		body: fd,
	});
	assetFilename = (await assetRes.json()).data.original_filename;
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

describe('POST /api/mentions/resolve (instance-wide)', () => {
	it('resolves tasks, filenames, assets, and agents with signed asset urls', async () => {
		const res = await ctx.app.request('/api/mentions/resolve', {
			method: 'POST',
			headers: jsonHeaders(ctx.token),
			body: JSON.stringify({
				tasks: [taskIdentifier, ` ${taskIdentifier.toLowerCase()} `, ''],
				filenames: ['handbook.md'],
				assets: [assetFilename, 42, null],
				agents: ['UNIQUE-MENTION-BOT'],
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()).data as {
			tasks: Array<{ identifier: string; project_slug: string }>;
			assets: Array<{ filename: string; signed_url: string }>;
			agents: Array<{ slug: string }>;
		};
		expect(body.tasks).toHaveLength(1);
		expect(body.tasks[0].identifier).toBe(taskIdentifier);
		expect(body.tasks[0].project_slug).toBe(projectSlug);
		expect(body.assets).toHaveLength(1);
		expect(body.assets[0].filename).toBe(assetFilename);
		expect(body.assets[0].signed_url).toMatch(/^\/api\/assets\/[0-9a-f-]+\?exp=\d+&sig=/);
		expect(body.agents.map((a) => a.slug)).toContain('unique-mention-bot');
	});

	it('treats omitted fields as empty arrays', async () => {
		const res = await ctx.app.request('/api/mentions/resolve', {
			method: 'POST',
			headers: jsonHeaders(ctx.token),
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()).data;
		expect(body.tasks).toEqual([]);
		expect(body.assets).toEqual([]);
		expect(body.agents).toEqual([]);
	});

	it('400s when a field is not an array', async () => {
		const res = await ctx.app.request('/api/mentions/resolve', {
			method: 'POST',
			headers: jsonHeaders(ctx.token),
			body: JSON.stringify({ tasks: 'in-1' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('400s when a field exceeds 100 entries', async () => {
		const res = await ctx.app.request('/api/mentions/resolve', {
			method: 'POST',
			headers: jsonHeaders(ctx.token),
			body: JSON.stringify({ agents: Array.from({ length: 101 }, (_, i) => `a-${i}`) }),
		});
		expect(res.status).toBe(400);
	});

	it('denies a board user without HQ access', async () => {
		const outsider = await ctx.db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('No HQ', false) RETURNING id",
		);
		const outsiderToken = await signAdminJwt(ctx.masterKeyManager, outsider.rows[0].id);
		const res = await ctx.app.request('/api/mentions/resolve', {
			method: 'POST',
			headers: jsonHeaders(outsiderToken),
			body: JSON.stringify({ tasks: [taskIdentifier] }),
		});
		expect(res.status).toBe(403);
	});
});

describe('POST /projects/:projectId/docs/resolve', () => {
	it('resolves kb slugs, project docs, and assets together', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/docs/resolve`, {
			method: 'POST',
			headers: jsonHeaders(ctx.token),
			body: JSON.stringify({
				kb_slugs: ['RELEASE-CHECKLIST.MD', ' release-checklist.md ', ''],
				project_docs: [
					{ project_slug: projectSlug, filename: 'handbook.md' },
					{ project_slug: projectSlug, filename: 'handbook.md' }, // duplicate deduped
					{ project_slug: '', filename: 'skipped.md' }, // empty slug skipped
					'not-an-object', // non-object skipped
					{ project_slug: projectSlug, filename: 42 }, // non-string filename skipped
				],
				assets: [{ project_slug: projectSlug, filename: assetFilename }],
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()).data as {
			kb_docs: Array<{ slug: string; title: string; size: number }>;
			project_docs: Array<{ project_slug: string; filename: string; size: number }>;
			assets: Array<{ filename: string; content_type: string; signed_url: string }>;
		};
		expect(body.kb_docs).toHaveLength(1);
		expect(body.kb_docs[0].title).toBe('Release Checklist');
		expect(body.kb_docs[0].size).toBe('Check everything twice.'.length);
		expect(body.project_docs).toHaveLength(1);
		expect(body.project_docs[0].filename).toBe('handbook.md');
		expect(body.assets).toHaveLength(1);
		expect(body.assets[0].content_type).toBe('text/markdown');
		expect(body.assets[0].signed_url).toMatch(/^\/api\/assets\//);
	});

	it('returns empty sets when nothing is requested', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/docs/resolve`, {
			method: 'POST',
			headers: jsonHeaders(ctx.token),
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data).toEqual({ kb_docs: [], project_docs: [], assets: [] });
	});

	it('filters cross-product matches back to the exact requested pairs', async () => {
		// Requesting (project, other.md) and (other-slug, handbook.md) must not
		// resolve (project, handbook.md) even though the SQL ANY() arrays cover it.
		const res = await ctx.app.request(`/api/projects/${projectSlug}/docs/resolve`, {
			method: 'POST',
			headers: jsonHeaders(ctx.token),
			body: JSON.stringify({
				project_docs: [
					{ project_slug: projectSlug, filename: 'other.md' },
					{ project_slug: 'some-other-project', filename: 'handbook.md' },
				],
				assets: [
					{ project_slug: projectSlug, filename: 'other.md' },
					{ project_slug: 'some-other-project', filename: assetFilename },
				],
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()).data;
		expect(body.project_docs).toHaveLength(0);
		expect(body.assets).toHaveLength(0);
	});

	it('400s when any list exceeds 100 entries', async () => {
		const many = Array.from({ length: 101 }, (_, i) => ({
			project_slug: projectSlug,
			filename: `f-${i}.md`,
		}));
		const res = await ctx.app.request(`/api/projects/${projectSlug}/docs/resolve`, {
			method: 'POST',
			headers: jsonHeaders(ctx.token),
			body: JSON.stringify({ assets: many }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('100');
	});
});

describe('GET /projects/:projectId/mentions/search', () => {
	async function search(params: string): Promise<Array<Record<string, string>>> {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/mentions/search?${params}`, {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		return (await res.json()).data;
	}

	it('kind=all with empty q returns every kind, admin suggestion first', async () => {
		const rows = await search(`q=&kind=all&project_slug=${encodeURIComponent(projectSlug)}`);
		expect(rows[0]).toMatchObject({ kind: 'agent', handle: 'admin' });
		const kinds = new Set(rows.map((r) => r.kind));
		expect(kinds.has('agent')).toBe(true);
		expect(kinds.has('task')).toBe(true);
		expect(kinds.has('kb')).toBe(true);
		expect(kinds.has('doc')).toBe(true);
	});

	it('surfaces the admin suggestion on a prefix of "admin"', async () => {
		const rows = await search('q=adm&kind=agent');
		expect(rows.some((r) => r.handle === 'admin')).toBe(true);
	});

	it('kind=agent filters by title substring', async () => {
		const rows = await search('q=Unique Mention&kind=agent');
		expect(rows.some((r) => r.handle === 'unique-mention-bot')).toBe(true);
		// No task/kb/doc rows leak into a kind-scoped search.
		expect(rows.every((r) => r.kind === 'agent')).toBe(true);
	});

	it('kind=task matches by identifier prefix and by title', async () => {
		const byIdentifier = await search(`q=${taskIdentifier.toLowerCase()}&kind=task`);
		expect(byIdentifier.some((r) => r.handle === taskIdentifier)).toBe(true);
		expect(byIdentifier[0].sublabel).toContain(projectSlug);

		const byTitle = await search('q=widget&kind=task');
		expect(byTitle.some((r) => r.handle === taskIdentifier)).toBe(true);
	});

	it('kind=kb matches skills by name', async () => {
		const rows = await search('q=Release&kind=kb');
		expect(rows.some((r) => r.handle === 'release-checklist.md')).toBe(true);
		expect(rows.every((r) => r.sublabel === 'Skill')).toBe(true);
	});

	it('kind=doc requires project_slug (absent -> no doc rows)', async () => {
		const rows = await search('q=handbook&kind=doc');
		expect(rows).toHaveLength(0);
	});

	it('kind=doc with project_slug returns the project docs', async () => {
		const rows = await search(
			`q=handbook&kind=doc&project_slug=${encodeURIComponent(projectSlug)}`,
		);
		expect(rows.some((r) => r.handle === 'handbook.md')).toBe(true);
		expect(rows[0].sublabel).toContain(projectSlug);
	});

	it('clamps out-of-range and non-numeric limits', async () => {
		const clamped = await search('q=&kind=agent&limit=999');
		expect(clamped.length).toBeLessThanOrEqual(51); // 50 per kind + admin suggestion
		const fallback = await search('q=&kind=agent&limit=abc');
		expect(fallback.length).toBeGreaterThan(0);
		const floor = await search('q=&kind=task&limit=0');
		// limit is clamped up to 1, so at most one task row returns.
		expect(floor.filter((r) => r.kind === 'task').length).toBeLessThanOrEqual(1);
	});

	it('escapes SQL LIKE wildcards in the query', async () => {
		const rows = await search('q=%&kind=kb');
		// A literal '%' matches nothing (it is escaped, not a wildcard).
		expect(rows.every((r) => r.handle !== 'release-checklist.md')).toBe(true);
	});
});
