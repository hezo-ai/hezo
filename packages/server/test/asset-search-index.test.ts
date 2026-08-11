import { ATTACHMENT_EXTENSIONS, isTextAssetMime } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { blobBytes, safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

// Every path that creates an `assets` row must populate `search_text`, or the
// asset's contents are silently unfindable. The bytes only exist in the caller's
// hand, so there is no single place the database could derive this - which is why
// `InsertAssetInput.searchText` is required and why this file walks every writer.

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let taskId: string;
let agentId: string;

const utf8 = (s: string) => new TextEncoder().encode(s);

async function mcp(
	authToken: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: toolName, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
	return JSON.parse(body.result.content[0].text ?? '{}');
}

async function agentToken(): Promise<string> {
	const { token: t } = await mintAgentToken(db, masterKeyManager, agentId, teamId, taskId);
	return t;
}

async function upload(
	filename: string,
	mime: string,
	bytes: Uint8Array,
	path = `/api/projects/${projectId}/assets`,
): Promise<Response> {
	const fd = new FormData();
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	fd.set('file', new File([blobBytes(copy)], filename, { type: mime }));
	return app.request(path, { method: 'POST', headers: { ...authHeader(token) }, body: fd });
}

/** The stored search text for an asset path. Throws if the row is missing, so a
 * mistyped path fails loudly instead of reading as a null `search_text`. */
async function searchTextOf(filename: string): Promise<string | null> {
	const r = await db.query<{ search_text: string | null }>(
		'SELECT search_text FROM assets WHERE project_id = $1 AND original_filename = $2',
		[projectId, filename],
	);
	if (r.rows.length === 0) throw new Error(`no asset row at '${filename}'`);
	return r.rows[0].search_text;
}

/** Does the asset's generated tsvector match this as-you-type term? */
async function matches(filename: string, term: string): Promise<boolean> {
	const r = await db.query<{ m: boolean }>(
		`SELECT search_tsv @@ to_tsquery('english', $3) AS m FROM assets
		 WHERE project_id = $1 AND original_filename = $2`,
		[projectId, filename, term],
	);
	return r.rows[0]?.m ?? false;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Index Co' });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Main', description: 'Idx.' });
	projectId = (await projectRes.json()).data.id;

	const agentRes = await app.request(`/api/projects/${projectId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Index Bot' }),
	});
	agentId = (await agentRes.json()).data.id;

	const taskRes = await app.request(`/api/projects/${projectId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Idx', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('search_text is populated by every asset write path', () => {
	it('library upload indexes a text asset and leaves a binary one filename-only', async () => {
		const res = await upload('notes.md', 'text/markdown', utf8('quarterly revenue projections'));
		expect(res.status).toBe(201);
		expect(await searchTextOf('notes.md')).toBe('quarterly revenue projections');
		expect(await matches('notes.md', 'revenue:*')).toBe(true);

		await upload('hero.png', 'image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
		expect(await searchTextOf('hero.png')).toBeNull();
		expect(await matches('hero.png', 'hero:*')).toBe(true);
	});

	it('task-thread attachment upload indexes its text', async () => {
		const res = await upload(
			'brief.txt',
			'text/plain',
			utf8('onboarding funnel rewrite'),
			`/api/projects/${projectId}/tasks/${taskId}/assets`,
		);
		expect(res.status).toBe(201);
		const filename = ((await res.json()) as { data: { original_filename: string } }).data
			.original_filename;
		expect(await searchTextOf(filename)).toBe('onboarding funnel rewrite');
	});

	it('the MCP multipart endpoint indexes its text', async () => {
		const tk = await agentToken();
		const fd = new FormData();
		fd.set(
			'file',
			new File([blobBytes(utf8('streamed upload body'))], 'streamed.txt', {
				type: 'text/plain',
			}),
		);
		fd.set('path', 'uploads/streamed.txt');
		fd.set('project', projectId);
		const res = await app.request('/mcp/assets', {
			method: 'POST',
			headers: { ...authHeader(tk) },
			body: fd,
		});
		expect(res.status).toBe(201);
		expect(await searchTextOf('uploads/streamed.txt')).toBe('streamed upload body');
	});

	it('write_project_asset indexes utf8 content and skips base64 binaries', async () => {
		const tk = await agentToken();
		await mcp(tk, 'write_project_asset', {
			project: projectId,
			filename: 'reports/q3.md',
			content: '# Q3\n\nPipeline coverage improved.',
		});
		expect(await searchTextOf('reports/q3.md')).toContain('Pipeline coverage improved');

		await mcp(tk, 'write_project_asset', {
			project: projectId,
			filename: 'reports/chart.png',
			content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
			encoding: 'base64',
		});
		expect(await searchTextOf('reports/chart.png')).toBeNull();
	});

	it('write_project_asset strips markup from an HTML asset', async () => {
		const tk = await agentToken();
		await mcp(tk, 'write_project_asset', {
			project: projectId,
			filename: 'mockups/pricing.html',
			content: '<div class="tier"><h1>Enterprise pricing</h1><script>var x=1</script></div>',
		});
		expect(await searchTextOf('mockups/pricing.html')).toBe('Enterprise pricing');
		expect(await matches('mockups/pricing.html', 'enterprise:*')).toBe(true);
		// Markup tokens must not become searchable content.
		expect(await matches('mockups/pricing.html', 'div:*')).toBe(false);
	});

	it('overwriting a path replaces the stored text rather than keeping the old', async () => {
		// The upsert's UPDATE branch: bytes and search text must move together.
		const tk = await agentToken();
		await mcp(tk, 'write_project_asset', {
			project: projectId,
			filename: 'iterate.md',
			content: 'first draft about widgets',
		});
		await mcp(tk, 'write_project_asset', {
			project: projectId,
			filename: 'iterate.md',
			content: 'second draft about sprockets',
		});
		expect(await searchTextOf('iterate.md')).toBe('second draft about sprockets');
		expect(await matches('iterate.md', 'sprockets:*')).toBe(true);
		expect(await matches('iterate.md', 'widgets:*')).toBe(false);
	});

	it('edit_project_asset reindexes the edited body', async () => {
		const tk = await agentToken();
		await mcp(tk, 'write_project_asset', {
			project: projectId,
			filename: 'edited.md',
			content: 'status is amber',
		});
		const edited = await mcp(tk, 'edit_project_asset', {
			project: projectId,
			filename: 'edited.md',
			old_string: 'amber',
			new_string: 'green',
		});
		expect(edited.edited).toBe(true);
		expect(await searchTextOf('edited.md')).toBe('status is green');
		expect(await matches('edited.md', 'green:*')).toBe(true);
		expect(await matches('edited.md', 'amber:*')).toBe(false);
	});

	it('copy_project_asset carries the source text to the copy', async () => {
		const tk = await agentToken();
		await mcp(tk, 'write_project_asset', {
			project: projectId,
			filename: 'templates/report.md',
			content: 'reusable template body',
		});
		const copied = await mcp(tk, 'copy_project_asset', {
			project: projectId,
			from: 'templates/report.md',
			to: '2026-q3/report.md',
		});
		expect(copied.copied).toBe(true);
		expect(await searchTextOf('2026-q3/report.md')).toBe('reusable template body');
		expect(await searchTextOf('templates/report.md')).toBe('reusable template body');
	});

	it('move_project_asset reindexes the path without touching the text', async () => {
		// The generated column recomputes on any UPDATE touching original_filename,
		// which is why the move path needs no code of its own.
		const tk = await agentToken();
		await mcp(tk, 'write_project_asset', {
			project: projectId,
			filename: 'staging/roadmap.md',
			content: 'milestones and owners',
		});
		await mcp(tk, 'move_project_asset', {
			project: projectId,
			from: 'staging/roadmap.md',
			to: 'published/roadmap.md',
		});
		expect(await searchTextOf('published/roadmap.md')).toBe('milestones and owners');
		expect(await matches('published/roadmap.md', 'published:*')).toBe(true);
		expect(await matches('published/roadmap.md', 'staging:*')).toBe(false);
	});

	it('accepts a text asset containing a NUL byte', async () => {
		// Postgres `text` rejects NUL, and search_tsv is a GENERATED column, so an
		// unscrubbed NUL would fail this upload outright rather than degrade search.
		const res = await upload('nul.txt', 'text/plain', utf8('alpha\u0000beta'));
		expect(res.status).toBe(201);
		expect(await searchTextOf('nul.txt')).toBe('alpha beta');
	});

	it('accepts a text asset whose content is one enormous token', async () => {
		// A lexeme over 2 KB makes to_tsvector throw; the extractor drops the run.
		const res = await upload('minified.txt', 'text/plain', utf8(`head ${'x'.repeat(9000)} tail`));
		expect(res.status).toBe(201);
		expect(await searchTextOf('minified.txt')).toBe('head tail');
	});

	it('indexes exactly the content types isTextAssetMime accepts', async () => {
		// The extractor's predicate and the search branch's expectations are one
		// rule; walk the whole attachment allowlist so a new extension cannot
		// silently land on the wrong side of it.
		for (const [ext, mime] of Object.entries(ATTACHMENT_EXTENSIONS)) {
			// A `/` in the File name is stripped by basename normalization, so keep
			// these flat and let the upload's own response name the stored path.
			const res = await upload(`sample-${ext}.${ext}`, mime, utf8('probe body'));
			expect(res.status, `${ext} upload`).toBe(201);
			const stored = await searchTextOf(
				((await res.json()) as { data: { original_filename: string } }).data.original_filename,
			);
			expect(stored !== null, `${ext} (${mime})`).toBe(isTextAssetMime(mime));
		}
	});
});
