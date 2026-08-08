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

// A comment's author avatar: human authors resolve to their user_icons image and
// agent authors to their agent_icons image, both returned as a signed
// `author_icon_url` on the comments feed (skeleton + full). Regression guard for
// the admin avatar never rendering in the thread.

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectSlug: string;
let taskId: string;
let agentId: string;
let agentSlug: string;
let adminUserId: string;

function pngWithDimensions(width: number, height: number): Buffer {
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(25);
	ihdr.writeUInt32BE(13, 0);
	ihdr.write('IHDR', 4, 'ascii');
	ihdr.writeUInt32BE(width, 8);
	ihdr.writeUInt32BE(height, 12);
	return Buffer.concat([sig, ihdr]);
}

function iconForm(bytes: Buffer): FormData {
	const fd = new FormData();
	fd.set('file', new Blob([blobBytes(bytes)], { type: 'image/png' }), 'icon.png');
	return fd;
}

async function postComment(auth: string, text: string): Promise<string> {
	const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
		method: 'POST',
		headers: { ...authHeader(auth), 'Content-Type': 'application/json' },
		body: JSON.stringify({ content_type: 'text', content: { text } }),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data.id;
}

interface SkeletonRow {
	id: string;
	author_icon_url: string | null;
	author_user_id?: string;
}

async function skeletons(): Promise<SkeletonRow[]> {
	const res = await app.request(
		`/api/projects/${projectSlug}/tasks/${taskId}/comments?view=skeleton`,
		{ headers: authHeader(token) },
	);
	expect(res.status).toBe(200);
	return (await res.json()).data;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamData = (await (await createTestTeam(db, { name: 'Avatar Co' })).json()).data;
	teamId = teamData.id;
	const projectData = (
		await (await createTestProject(db, teamId, { name: 'Main', description: 'Test.' })).json()
	).data;
	projectSlug = projectData.slug;

	const agent = (
		await (
			await app.request(`/api/projects/${projectSlug}/agents`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'Avatar Bot' }),
			})
		).json()
	).data;
	agentId = agent.id;
	agentSlug = agent.slug;

	const task = (
		await (
			await app.request(`/api/projects/${projectSlug}/tasks`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ title: 'Avatar Task', assignee_id: agentId }),
			})
		).json()
	).data;
	taskId = task.id;

	const users = (await (await app.request('/api/users', { headers: authHeader(token) })).json())
		.data as { id: string; is_superuser: boolean }[];
	adminUserId = users.find((u) => u.is_superuser)?.id ?? users[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('comment author avatar', () => {
	it('returns the admin user avatar as author_icon_url on their comment', async () => {
		await app.request(`/api/users/${adminUserId}/icon`, {
			method: 'PUT',
			headers: authHeader(token),
			body: iconForm(pngWithDimensions(512, 512)),
		});
		const commentId = await postComment(token, 'from the admin');

		const rows = await skeletons();
		const row = rows.find((r) => r.id === commentId);
		expect(row).toBeDefined();
		expect(row?.author_icon_url).toMatch(
			new RegExp(`^/api/users/${adminUserId}/icon\\?exp=\\d+&sig=[^&]+&v=\\d+$`),
		);
		// The internal attribution column is not leaked to the client.
		expect(row).not.toHaveProperty('author_user_id');

		// The signed URL actually serves the uploaded bytes.
		const serve = await app.request(row?.author_icon_url as string);
		expect(serve.status).toBe(200);
		expect(Buffer.from(await serve.arrayBuffer()).equals(pngWithDimensions(512, 512))).toBe(true);
	});

	it('returns the agent avatar as author_icon_url on an agent comment', async () => {
		await app.request(`/api/projects/${projectSlug}/agents/${agentSlug}/icon`, {
			method: 'PUT',
			headers: authHeader(token),
			body: iconForm(pngWithDimensions(256, 256)),
		});
		const agentAuth = await mintAgentToken(db, masterKeyManager, agentId, teamId, taskId);
		const commentId = await postComment(agentAuth.token, 'from the bot');

		const rows = await skeletons();
		const row = rows.find((r) => r.id === commentId);
		expect(row?.author_icon_url).toMatch(
			new RegExp(`^/api/agents/${agentId}/icon\\?exp=\\d+&sig=[^&]+&v=\\d+$`),
		);
	});

	it('is null for an author with no uploaded avatar', async () => {
		await app.request(`/api/users/${adminUserId}/icon`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		const commentId = await postComment(token, 'admin without an avatar');

		const rows = await skeletons();
		const row = rows.find((r) => r.id === commentId);
		expect(row?.author_icon_url).toBeNull();
	});

	it('also carries author_icon_url in full mode', async () => {
		await app.request(`/api/users/${adminUserId}/icon`, {
			method: 'PUT',
			headers: authHeader(token),
			body: iconForm(pngWithDimensions(512, 512)),
		});
		const commentId = await postComment(token, 'full-mode avatar');

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
			headers: authHeader(token),
		});
		const row = ((await res.json()).data as SkeletonRow[]).find((r) => r.id === commentId);
		expect(row?.author_icon_url).toMatch(new RegExp(`^/api/users/${adminUserId}/icon\\?`));
	});
});
