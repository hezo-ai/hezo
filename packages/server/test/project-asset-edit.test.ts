import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let taskId: string;
let agentId: string;

async function callTool(
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
	const body = (await res.json()) as { result: { content: Array<{ text?: string }> } };
	return JSON.parse(body.result.content[0].text ?? '{}');
}

async function agentToken(): Promise<string> {
	const { token: t } = await mintAgentToken(db, masterKeyManager, agentId, teamId, taskId);
	return t;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Asset Edit Co' });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Main', description: 'Assets.' });
	projectId = (await projectRes.json()).data.id;

	const agentRes = await app.request(`/api/projects/${projectId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Asset Bot' }),
	});
	agentId = (await agentRes.json()).data.id;

	const taskRes = await app.request(`/api/projects/${projectId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Assets', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('edit_project_asset', () => {
	it('changes one span of a text asset and reports what landed', async () => {
		const tk = await agentToken();
		const html = '<html>\n<body>\n<h1>Todo</h1>\n<p>Draft copy.</p>\n</body>\n</html>';
		await callTool(tk, 'write_project_asset', {
			project: projectId,
			filename: 'mockup.html',
			content: html,
		});

		const edited = await callTool(tk, 'edit_project_asset', {
			project: projectId,
			filename: 'mockup.html',
			old_string: '<p>Draft copy.</p>',
			new_string: '<p>Approved copy.</p>',
		});
		expect(edited.error).toBeUndefined();
		expect(edited.edited).toBe(true);
		expect(edited.replacements).toBe(1);
		expect(edited.reference).toBe('assets/mockup.html');
		// The hunk is what makes verification free - no second read needed.
		expect(String(edited.hunk)).toContain('<p>Approved copy.</p>');

		const read = await callTool(tk, 'read_project_asset', {
			project: projectId,
			filename: 'mockup.html',
		});
		expect(read.content).toBe(
			'<html>\n<body>\n<h1>Todo</h1>\n<p>Approved copy.</p>\n</body>\n</html>',
		);
		expect(edited.byte_size).toBe(Buffer.byteLength(read.content as string, 'utf8'));
	});

	it('refuses a binary asset, a missing one, and an ambiguous anchor', async () => {
		const tk = await agentToken();
		// A minimal PNG is enough: the refusal is on content type, not pixels.
		const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		await callTool(tk, 'write_project_asset', {
			project: projectId,
			filename: 'logo.png',
			content: pngBytes.toString('base64'),
			encoding: 'base64',
		});
		const binary = await callTool(tk, 'edit_project_asset', {
			project: projectId,
			filename: 'logo.png',
			old_string: 'a',
			new_string: 'b',
		});
		expect(binary.edited).toBeUndefined();
		expect(String(binary.error)).toContain('binary');

		const missing = await callTool(tk, 'edit_project_asset', {
			project: projectId,
			filename: 'nope.html',
			old_string: 'a',
			new_string: 'b',
		});
		expect(String(missing.error)).toContain('not found');

		await callTool(tk, 'write_project_asset', {
			project: projectId,
			filename: 'repeats.md',
			content: 'one\nsame\ntwo\nsame\nthree',
		});
		const ambiguous = await callTool(tk, 'edit_project_asset', {
			project: projectId,
			filename: 'repeats.md',
			old_string: 'same',
			new_string: 'changed',
		});
		expect(ambiguous.edited).toBeUndefined();
		expect(String(ambiguous.error)).toContain('matches 2 places');

		// Refused edits leave the asset untouched.
		const unchanged = await callTool(tk, 'read_project_asset', {
			project: projectId,
			filename: 'repeats.md',
		});
		expect(unchanged.content).toBe('one\nsame\ntwo\nsame\nthree');

		const all = await callTool(tk, 'edit_project_asset', {
			project: projectId,
			filename: 'repeats.md',
			old_string: 'same',
			new_string: 'changed',
			replace_all: true,
		});
		expect(all.replacements).toBe(2);
	});
});

describe('read_project_asset windowing', () => {
	it('pages a large text asset instead of dead-ending on result_too_large', async () => {
		const tk = await agentToken();
		// Comfortably past the 64KB result budget - the size a self-contained
		// interactive HTML mockup reaches in practice.
		const big = '<div>filler content</div>\n'.repeat(4000);
		await callTool(tk, 'write_project_asset', {
			project: projectId,
			filename: 'big-mockup.html',
			content: big,
		});

		const first = await callTool(tk, 'read_project_asset', {
			project: projectId,
			filename: 'big-mockup.html',
		});
		expect(first.error).toBeUndefined();
		expect(first.truncated).toBe(true);
		expect(first.total_bytes).toBe(Buffer.byteLength(big, 'utf8'));
		expect(Number(first.next_offset)).toBeGreaterThan(0);
		// The continuation sentence names the call and the parameter to use.
		expect(String(first.paging_hint)).toContain('read_project_asset');

		let assembled = first.content as string;
		let offset = first.next_offset as number | null;
		for (let guard = 0; offset !== null && guard < 100; guard++) {
			const next = await callTool(tk, 'read_project_asset', {
				project: projectId,
				filename: 'big-mockup.html',
				offset,
			});
			assembled += next.content as string;
			offset = next.next_offset as number | null;
		}
		expect(offset).toBeNull();
		expect(assembled).toBe(big);
	});

	it('lists byte_size so a caller can tell before reading whether paging is needed', async () => {
		const tk = await agentToken();
		const listed = (await callTool(tk, 'list_project_assets', { project: projectId })) as {
			items: Array<{ filename: string; byte_size?: number }>;
		};
		const entry = listed.items.find((a) => a.filename === 'big-mockup.html');
		expect(entry?.byte_size).toBe(
			Buffer.byteLength('<div>filler content</div>\n'.repeat(4000), 'utf8'),
		);
	});
});
