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

// A real PNG: 8-byte signature + IHDR carrying width/height so
// readImageDimensions can measure it (mirrors image-dimensions.test.ts).
function png(width: number, height: number): Buffer {
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(25);
	ihdr.writeUInt32BE(13, 0);
	ihdr.write('IHDR', 4, 'ascii');
	ihdr.writeUInt32BE(width, 8);
	ihdr.writeUInt32BE(height, 12);
	return Buffer.concat([sig, ihdr]);
}

type McpBlock = { type: string; text?: string; data?: string; mimeType?: string };

async function rawMcp(
	authToken: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<McpBlock[]> {
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
	const body = (await res.json()) as { result: { content: McpBlock[] } };
	return body.result.content;
}

async function callTool(
	authToken: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const content = await rawMcp(authToken, toolName, args);
	return JSON.parse(content[0].text ?? '{}');
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

	const teamRes = await createTestTeam(db, { name: 'Dim Co' });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Main', description: 'Dims.' });
	projectId = (await projectRes.json()).data.id;

	const agentRes = await app.request(`/api/projects/${projectId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Dim Bot' }),
	});
	agentId = (await agentRes.json()).data.id;

	const taskRes = await app.request(`/api/projects/${projectId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Dims', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('asset image dimensions & inline image content', () => {
	it('captures dimensions on write and returns the image inline on read', async () => {
		const tk = await agentToken();
		const write = await callTool(tk, 'write_project_asset', {
			project: projectId,
			filename: 'diagrams/header.png',
			content: png(1600, 1200).toString('base64'),
			encoding: 'base64',
		});
		expect(write.written).toBe(true);
		expect(write.width).toBe(1600);
		expect(write.height).toBe(1200);

		const content = await rawMcp(tk, 'read_project_asset', {
			project: projectId,
			filename: 'diagrams/header.png',
		});
		// [ metadata text block, image block ]
		expect(content).toHaveLength(2);
		const meta = JSON.parse(content[0].text ?? '{}');
		expect(meta.width).toBe(1600);
		expect(meta.height).toBe(1200);
		expect(meta.binary).toBe(true);
		expect(typeof meta.url).toBe('string');
		const image = content[1];
		expect(image.type).toBe('image');
		expect(image.mimeType).toBe('image/png');
		expect(image.data).toBe(png(1600, 1200).toString('base64'));
	});

	it('omits the inline image when include_image is false', async () => {
		const tk = await agentToken();
		await callTool(tk, 'write_project_asset', {
			project: projectId,
			filename: 'diagrams/small.png',
			content: png(320, 240).toString('base64'),
			encoding: 'base64',
		});
		const content = await rawMcp(tk, 'read_project_asset', {
			project: projectId,
			filename: 'diagrams/small.png',
			include_image: false,
		});
		expect(content).toHaveLength(1);
		expect(content.some((b) => b.type === 'image')).toBe(false);
		const meta = JSON.parse(content[0].text ?? '{}');
		expect(meta.width).toBe(320);
		expect(meta.height).toBe(240);
	});

	it('leaves SVG as inline text with no dimensions or image block', async () => {
		const tk = await agentToken();
		await callTool(tk, 'write_project_asset', {
			project: projectId,
			filename: 'diagrams/logo.svg',
			content: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
		});
		const content = await rawMcp(tk, 'read_project_asset', {
			project: projectId,
			filename: 'diagrams/logo.svg',
		});
		expect(content).toHaveLength(1);
		const meta = JSON.parse(content[0].text ?? '{}');
		expect(typeof meta.content).toBe('string');
		expect(meta.width).toBeUndefined();
		expect(meta.binary).toBeUndefined();
	});

	it('lists raster dimensions in list_project_assets', async () => {
		const tk = await agentToken();
		await callTool(tk, 'write_project_asset', {
			project: projectId,
			filename: 'diagrams/listed.png',
			content: png(800, 600).toString('base64'),
			encoding: 'base64',
		});
		const list = await callTool(tk, 'list_project_assets', { project: projectId });
		const files = list.files as Array<{ filename: string; width?: number; height?: number }>;
		const entry = files.find((f) => f.filename === 'diagrams/listed.png');
		expect(entry?.width).toBe(800);
		expect(entry?.height).toBe(600);
		// A non-raster (SVG) entry carries no dimensions.
		const svg = files.find((f) => f.filename === 'diagrams/logo.svg');
		expect(svg && 'width' in svg).toBe(false);
	});

	it('captures dimensions on the multipart upload path', async () => {
		const bytes = png(640, 480);
		const copy = new Uint8Array(bytes.byteLength);
		copy.set(bytes);
		const fd = new FormData();
		fd.set('file', new File([copy], 'upload.png', { type: 'image/png' }));
		const res = await app.request(`/api/projects/${projectId}/assets`, {
			method: 'POST',
			headers: { ...authHeader(token) },
			body: fd,
		});
		expect(res.status).toBe(201);
		const data = (await res.json()).data;
		expect(data.width).toBe(640);
		expect(data.height).toBe(480);
	});

	it('lazily backfills missing dimensions on read for pre-existing rows', async () => {
		const tk = await agentToken();
		await callTool(tk, 'write_project_asset', {
			project: projectId,
			filename: 'diagrams/backfill.png',
			content: png(1024, 768).toString('base64'),
			encoding: 'base64',
		});
		// Simulate a row written before this feature: clear the dimensions.
		await db.query(
			`UPDATE assets SET width = NULL, height = NULL
			 WHERE project_id = $1 AND original_filename = $2`,
			[projectId, 'diagrams/backfill.png'],
		);
		const content = await rawMcp(tk, 'read_project_asset', {
			project: projectId,
			filename: 'diagrams/backfill.png',
			include_image: false,
		});
		const meta = JSON.parse(content[0].text ?? '{}');
		expect(meta.width).toBe(1024);
		expect(meta.height).toBe(768);
		// And it was persisted back so future reads don't re-parse.
		const row = await db.query<{ width: number | null; height: number | null }>(
			`SELECT width, height FROM assets WHERE project_id = $1 AND original_filename = $2`,
			[projectId, 'diagrams/backfill.png'],
		);
		expect(row.rows[0].width).toBe(1024);
		expect(row.rows[0].height).toBe(768);
	});

	it('falls back to metadata + url (no inline image) above the size cap', async () => {
		const tk = await agentToken();
		await callTool(tk, 'write_project_asset', {
			project: projectId,
			filename: 'diagrams/big.png',
			content: png(2000, 1500).toString('base64'),
			encoding: 'base64',
		});
		// Force the recorded byte_size over the inline cap without a 4 MB blob.
		await db.query(
			`UPDATE assets SET byte_size = 5000000
			 WHERE project_id = $1 AND original_filename = $2`,
			[projectId, 'diagrams/big.png'],
		);
		const content = await rawMcp(tk, 'read_project_asset', {
			project: projectId,
			filename: 'diagrams/big.png',
		});
		expect(content.some((b) => b.type === 'image')).toBe(false);
		const meta = JSON.parse(content[0].text ?? '{}');
		expect(meta.width).toBe(2000);
		expect(meta.height).toBe(1500);
		expect(typeof meta.url).toBe('string');
	});
});
