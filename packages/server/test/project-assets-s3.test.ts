import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3AssetStore } from '../src/assets/drivers/s3';
import { parseAssetStorageUrl } from '../src/assets/url';
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
import { createS3Sim, type S3Sim } from './helpers/s3-sim';

/**
 * End-to-end with the S3 driver active: every asset flow (REST upload, signed
 * serve, MCP tools, deletes, project deletion) stores and reads blobs ONLY in
 * the bucket — nothing ever lands on the host filesystem.
 */

const PREFIX = 'itest';

let sim: S3Sim;
let app: Hono<Env>;
let db: Db;
let token: string;
let dataDir: string;
let teamId: string;
let projectId: string;
let agentToken: string;

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function simKey(project: string, assetId: string): string {
	return `${PREFIX}/${project}/${assetId}`;
}

async function callToolViaMcp(
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
	return JSON.parse(body.result.content[0].text);
}

async function uploadProjectAsset(filename: string, mime: string, bytes: Uint8Array) {
	const fd = new FormData();
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	fd.set('file', new File([blobBytes(copy)], filename, { type: mime }));
	return app.request(`/api/projects/${projectId}/assets`, {
		method: 'POST',
		headers: { ...authHeader(token) },
		body: fd,
	});
}

beforeAll(async () => {
	sim = await createS3Sim({ pageSize: 2 });
	const assetStore = new S3AssetStore(parseAssetStorageUrl(sim.storeUrl(PREFIX)));
	const ctx = await createTestApp({ assetStore });
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	dataDir = ctx.dataDir;

	const teamRes = await createTestTeam(db, { name: 'S3 Assets Co' });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Bucketed', description: 'x' });
	projectId = (await projectRes.json()).data.id;

	const agentRes = await app.request(`/api/projects/${projectId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'S3 Bot' }),
	});
	const agentId = (await agentRes.json()).data.id;
	const taskRes = await app.request(`/api/projects/${projectId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'S3 Task', assignee_id: agentId }),
	});
	const taskId = (await taskRes.json()).data.id;
	({ token: agentToken } = await mintAgentToken(db, ctx.masterKeyManager, agentId, teamId, taskId, {
		projectId,
	}));
});

afterAll(async () => {
	await safeClose(db);
	await sim.destroy();
});

describe('asset flows with the S3 store active', () => {
	it('REST upload lands in the bucket (content-type + sha metadata), not on disk', async () => {
		const res = await uploadProjectAsset('photo.png', 'image/png', PNG_BYTES);
		expect(res.status).toBe(201);
		const body = await res.json();
		const stored = sim.objects.get(simKey(projectId, body.data.id));
		expect(stored).toBeDefined();
		expect(Buffer.compare(stored!.body, Buffer.from(PNG_BYTES))).toBe(0);
		expect(stored!.contentType).toBe('image/png');
		expect(stored!.meta.sha256).toBe(
			createHash('sha256').update(Buffer.from(PNG_BYTES)).digest('hex'),
		);

		// The host filesystem holds no asset blobs in S3 mode.
		expect(existsSync(join(dataDir, 'assets'))).toBe(false);
	});

	it('the signed URL serves the bytes straight from the bucket', async () => {
		const up = await (await uploadProjectAsset('serve-me.png', 'image/png', PNG_BYTES)).json();
		const res = await app.request(up.data.url);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/png');
		expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), Buffer.from(PNG_BYTES))).toBe(0);
	});

	it('a missing object serves 404, but a storage failure serves 500 — never a fake 404', async () => {
		const up = await (await uploadProjectAsset('flaky.png', 'image/png', PNG_BYTES)).json();
		sim.failNext('get');
		const failed = await app.request(up.data.url);
		expect(failed.status).toBe(500);
		// After the injected failure clears, the same URL serves fine.
		const ok = await app.request(up.data.url);
		expect(ok.status).toBe(200);
		// A genuinely missing blob is a 404.
		sim.objects.delete(simKey(projectId, up.data.id));
		const gone = await app.request(up.data.url);
		expect(gone.status).toBe(404);
	});

	it('write_project_asset stores to the bucket and overwriting cleans the replaced object', async () => {
		const first = (await callToolViaMcp(agentToken, 'write_project_asset', {
			filename: 'notes.md',
			content: '# v1',
		})) as { id: string };
		expect(sim.objects.has(simKey(projectId, first.id))).toBe(true);

		const second = (await callToolViaMcp(agentToken, 'write_project_asset', {
			filename: 'notes.md',
			content: '# v2',
		})) as { id: string };
		expect(second.id).not.toBe(first.id);
		expect(sim.objects.has(simKey(projectId, second.id))).toBe(true);
		expect(sim.objects.has(simKey(projectId, first.id))).toBe(false);

		const read = (await callToolViaMcp(agentToken, 'read_project_asset', {
			filename: 'notes.md',
		})) as { content: string };
		expect(read.content).toBe('# v2');
	});

	it('copy_project_asset duplicates the object under a new id', async () => {
		await callToolViaMcp(agentToken, 'write_project_asset', {
			filename: 'template.md',
			content: 'tpl',
		});
		const copied = (await callToolViaMcp(agentToken, 'copy_project_asset', {
			from: 'template.md',
			to: 'copies/report.md',
		})) as { copied?: boolean; id?: string; error?: string };
		expect(copied.error).toBeUndefined();
		const read = (await callToolViaMcp(agentToken, 'read_project_asset', {
			filename: 'copies/report.md',
		})) as { content: string };
		expect(read.content).toBe('tpl');
	});

	it('POST /mcp/assets uploads a binary into the bucket and read returns a fetchable url', async () => {
		const fd = new FormData();
		const copy = new Uint8Array(PNG_BYTES.byteLength);
		copy.set(PNG_BYTES);
		fd.set('file', new File([blobBytes(copy)], 'shot.png', { type: 'image/png' }));
		const res = await app.request('/mcp/assets', {
			method: 'POST',
			headers: { ...authHeader(agentToken) },
			body: fd,
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(sim.objects.has(simKey(projectId, body.data.id))).toBe(true);

		const read = (await callToolViaMcp(agentToken, 'read_project_asset', {
			filename: 'shot.png',
		})) as { binary?: boolean; url?: string };
		expect(read.binary).toBe(true);
		// The URL is absolute for in-container curl; the same signed path serves here.
		const parsed = new URL(read.url as string);
		// The agent-facing origin is the caller's own tunnel loopback, not a host name.
		expect(parsed.hostname).toBe('localhost');
		const served = await app.request(`${parsed.pathname}${parsed.search}`);
		expect(served.status).toBe(200);
	});

	it('admin DELETE removes the object from the bucket', async () => {
		const up = await (await uploadProjectAsset('doomed.png', 'image/png', PNG_BYTES)).json();
		const res = await app.request(`/api/projects/${projectId}/assets/${up.data.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect(sim.objects.has(simKey(projectId, up.data.id))).toBe(false);
	});

	it('project deletion empties the project prefix in the bucket (paginated)', async () => {
		const projRes = await createTestProject(db, teamId, { name: 'Doomed Proj', description: 'x' });
		const doomedProjectId = (await projRes.json()).data.id;
		// Enough objects to force list pagination (sim pageSize is 2), including
		// an orphan with no DB row.
		for (let i = 0; i < 5; i++) {
			const fd = new FormData();
			const copy = new Uint8Array(PNG_BYTES.byteLength);
			copy.set(PNG_BYTES);
			fd.set('file', new File([blobBytes(copy)], `f${i}.png`, { type: 'image/png' }));
			const res = await app.request(`/api/projects/${doomedProjectId}/assets`, {
				method: 'POST',
				headers: { ...authHeader(token) },
				body: fd,
			});
			expect(res.status).toBe(201);
		}
		sim.objects.set(simKey(doomedProjectId, 'orphan-blob'), {
			body: Buffer.from('orphan'),
			contentType: 'application/octet-stream',
			meta: {},
		});

		// The seeded planning/coherence tasks keep the project open — close them
		// so the delete route's open-task guard passes.
		await db.query(`UPDATE tasks SET status = 'cancelled' WHERE project_id = $1`, [
			doomedProjectId,
		]);
		const del = await app.request(`/api/projects/${doomedProjectId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(200);

		const remaining = [...sim.objects.keys()].filter((k) =>
			k.startsWith(`${PREFIX}/${doomedProjectId}/`),
		);
		expect(remaining).toEqual([]);
	});
});
