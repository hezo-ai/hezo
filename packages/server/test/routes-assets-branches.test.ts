import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssetStore, WriteAssetResult } from '../src/assets/store';
import { AssetNotFoundError, AttachmentTooLargeError } from '../src/assets/store';
import { signAssetUrl } from '../src/lib/asset-urls';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

/**
 * Branch coverage for packages/server/src/routes/assets.ts: upload validation
 * failures (extension / MIME mismatch / folder depth), missing-file and
 * malformed multipart forms, list/delete/patch authorization + not-found arms,
 * the archive/restore + folder-move PATCH branches, the public signed-URL
 * serving route (missing/invalid signature, missing row, missing blob, headers,
 * CSP), and — via an injected failing AssetStore — the store-write/read error
 * mappings (TOO_LARGE, INTERNAL_ERROR).
 */

let ctx: ServerTestContext;
let teamId: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let taskIdentifier: string;
let agentId: string;
let agentToken: string;

function pngBytes(seed = 0): Uint8Array {
	const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const extra = new Uint8Array(24);
	for (let i = 0; i < extra.length; i++) extra[i] = (i + seed) & 0xff;
	const out = new Uint8Array(sig.length + extra.length);
	out.set(sig, 0);
	out.set(extra, sig.length);
	return out;
}

function fileForm(filename: string, mime: string, bytes: Uint8Array, folder?: string): FormData {
	const fd = new FormData();
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	fd.set('file', new File([copy.buffer], filename, { type: mime }));
	if (folder !== undefined) fd.set('folder', folder);
	return fd;
}

async function uploadProject(
	filename: string,
	mime: string,
	bytes: Uint8Array,
	folder?: string,
): Promise<Response> {
	return ctx.app.request(`/api/projects/${projectSlug}/assets`, {
		method: 'POST',
		headers: { ...authHeader(ctx.token) },
		body: fileForm(filename, mime, bytes, folder),
	});
}

beforeAll(async () => {
	ctx = await createTestContext();

	const teamRes = await createTestTeam(ctx.db, { name: 'Asset Branch Co' });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(ctx.db, teamId, { name: 'Asset Branch Project' });
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	const agentRes = await ctx.app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Branch Bot' }),
	});
	agentId = (await agentRes.json()).data.id;

	const taskRes = await ctx.app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Attach Here', assignee_id: agentId }),
	});
	const task = (await taskRes.json()).data;
	taskId = task.id;
	taskIdentifier = task.identifier;

	agentToken = (await mintAgentToken(ctx.db, ctx.masterKeyManager, agentId, teamId, taskId)).token;
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

describe('task attachment upload (POST /projects/:projectId/tasks/:taskId/assets)', () => {
	it('404s for an unknown task', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/tasks/zz-999/assets`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token) },
			body: fileForm('a.png', 'image/png', pngBytes(1)),
		});
		expect(res.status).toBe(404);
		expect((await res.json()).error.code).toBe('NOT_FOUND');
	});

	it('400s when the form has no file field', async () => {
		const fd = new FormData();
		fd.set('note', 'no file here');
		const res = await ctx.app.request(
			`/api/projects/${projectSlug}/tasks/${taskIdentifier.toLowerCase()}/assets`,
			{ method: 'POST', headers: { ...authHeader(ctx.token) }, body: fd },
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('stores the upload under uploads/<task-identifier> and records the row', async () => {
		const res = await ctx.app.request(
			`/api/projects/${projectSlug}/tasks/${taskIdentifier.toLowerCase()}/assets`,
			{
				method: 'POST',
				headers: { ...authHeader(ctx.token) },
				body: fileForm('shot.png', 'image/png', pngBytes(2)),
			},
		);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.original_filename).toBe(`uploads/${taskIdentifier}/shot.png`);
		expect(body.data.content_type).toBe('image/png');
		expect(body.data.url).toMatch(/^\/api\/assets\/[0-9a-f-]+\?exp=\d+&sig=/);

		const row = await ctx.db.query<{ team_id: string; project_id: string; byte_size: number }>(
			'SELECT team_id, project_id, byte_size FROM assets WHERE id = $1',
			[body.data.id],
		);
		expect(row.rows).toHaveLength(1);
		expect(row.rows[0].team_id).toBe(teamId);
		expect(row.rows[0].project_id).toBe(projectId);
		expect(row.rows[0].byte_size).toBe(pngBytes(2).byteLength);
	});
});

describe('project asset upload validation (POST /projects/:projectId/assets)', () => {
	it('404s for an unknown project', async () => {
		const res = await ctx.app.request('/api/projects/no-such-project/assets', {
			method: 'POST',
			headers: { ...authHeader(ctx.token) },
			body: fileForm('a.png', 'image/png', pngBytes(3)),
		});
		expect(res.status).toBe(404);
	});

	it('400s when the file field is a plain string, not a file', async () => {
		const fd = new FormData();
		fd.set('file', 'just-a-string.png');
		const res = await ctx.app.request(`/api/projects/${projectSlug}/assets`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token) },
			body: fd,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('400s on a malformed multipart body (parseBody failure)', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/assets`, {
			method: 'POST',
			headers: {
				...authHeader(ctx.token),
				'Content-Type': 'multipart/form-data; boundary=deadbeef',
			},
			body: 'this is not multipart at all',
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('rejects an unsupported extension', async () => {
		const res = await uploadProject('tool.exe', 'application/octet-stream', pngBytes(4));
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_ATTACHMENT');
	});

	it('rejects a declared MIME that mismatches the extension', async () => {
		const res = await uploadProject('photo.png', 'application/x-msdownload', pngBytes(5));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_ATTACHMENT');
		expect(body.error.message).toContain('Unsupported content type');
	});

	it('rejects a folder nested deeper than two levels', async () => {
		const res = await uploadProject('deep.png', 'image/png', pngBytes(6), 'a/b/c');
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_FOLDER');
	});
});

describe('GET /projects/:projectId/assets', () => {
	it('404s for an unknown project', async () => {
		const res = await ctx.app.request('/api/projects/nope/assets', {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(404);
	});

	it('lists active and archived assets with counts and signed urls', async () => {
		const a = (await (await uploadProject('list-a.png', 'image/png', pngBytes(7))).json()).data;
		const b = (await (await uploadProject('list-b.png', 'image/png', pngBytes(8))).json()).data;
		const archive = await ctx.app.request(`/api/projects/${projectSlug}/assets/${b.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ archived: true }),
		});
		expect(archive.status).toBe(200);

		const res = await ctx.app.request(`/api/projects/${projectSlug}/assets`, {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		const assets = (await res.json()).data as Array<{
			id: string;
			archived_at: string | null;
			comment_attachment_count: number;
			url: string;
		}>;
		const active = assets.find((r) => r.id === a.id);
		const archived = assets.find((r) => r.id === b.id);
		expect(active?.archived_at).toBeNull();
		expect(active?.comment_attachment_count).toBe(0);
		expect(active?.url).toMatch(/^\/api\/assets\//);
		expect(archived?.archived_at).not.toBeNull();
	});
});

describe('DELETE /projects/:projectId/assets/:assetId', () => {
	it('403s for agent auth', async () => {
		const up = (await (await uploadProject('keep.png', 'image/png', pngBytes(9))).json()).data;
		const res = await ctx.app.request(`/api/projects/${projectSlug}/assets/${up.id}`, {
			method: 'DELETE',
			headers: authHeader(agentToken),
		});
		expect(res.status).toBe(403);
		const still = await ctx.db.query('SELECT 1 FROM assets WHERE id = $1', [up.id]);
		expect(still.rows).toHaveLength(1);
	});

	it('404s for an unknown project slug', async () => {
		const res = await ctx.app.request(`/api/projects/ghost-project/assets/${randomUUID()}`, {
			method: 'DELETE',
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(404);
	});

	it('404s for an unknown asset', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/assets/${randomUUID()}`, {
			method: 'DELETE',
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(404);
	});

	it('deletes the row and the blob', async () => {
		const up = (await (await uploadProject('gone.png', 'image/png', pngBytes(10))).json()).data;
		const blobPath = join(ctx.dataDir, 'assets', projectId, up.id);
		expect(existsSync(blobPath)).toBe(true);

		const res = await ctx.app.request(`/api/projects/${projectSlug}/assets/${up.id}`, {
			method: 'DELETE',
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data).toBeNull();
		expect(existsSync(blobPath)).toBe(false);
		const row = await ctx.db.query('SELECT 1 FROM assets WHERE id = $1', [up.id]);
		expect(row.rows).toHaveLength(0);
	});
});

describe('PATCH /projects/:projectId/assets/:assetId', () => {
	async function patchAsset(assetId: string, body: string): Promise<Response> {
		return ctx.app.request(`/api/projects/${projectSlug}/assets/${assetId}`, {
			method: 'PATCH',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body,
		});
	}

	it('403s for agent auth', async () => {
		const up = (await (await uploadProject('agent-no.png', 'image/png', pngBytes(11))).json()).data;
		const res = await ctx.app.request(`/api/projects/${projectSlug}/assets/${up.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ folder: 'x' }),
		});
		expect(res.status).toBe(403);
		expect((await res.json()).error.code).toBe('FORBIDDEN');
	});

	it('404s for an unknown project', async () => {
		const res = await ctx.app.request(`/api/projects/nope/assets/${randomUUID()}`, {
			method: 'PATCH',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ folder: '' }),
		});
		expect(res.status).toBe(404);
	});

	it('400s on invalid JSON', async () => {
		const up = (await (await uploadProject('bad-json.png', 'image/png', pngBytes(12))).json()).data;
		const res = await patchAsset(up.id, '{not json');
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('Invalid JSON');
	});

	it('400s when both or neither of folder/archived are provided', async () => {
		const up = (await (await uploadProject('two-ops.png', 'image/png', pngBytes(13))).json()).data;
		const both = await patchAsset(up.id, JSON.stringify({ folder: 'a', archived: true }));
		expect(both.status).toBe(400);
		const neither = await patchAsset(up.id, JSON.stringify({}));
		expect(neither.status).toBe(400);
		expect((await neither.json()).error.message).toContain('exactly one');
	});

	it('404s for an unknown asset', async () => {
		const res = await patchAsset(randomUUID(), JSON.stringify({ archived: true }));
		expect(res.status).toBe(404);
	});

	it('400s when archived is not a boolean', async () => {
		const up = (await (await uploadProject('arch-str.png', 'image/png', pngBytes(14))).json()).data;
		const res = await patchAsset(up.id, JSON.stringify({ archived: 'yes' }));
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('archived must be a boolean');
	});

	it('archives, is idempotent on re-archive, and restores', async () => {
		const up = (await (await uploadProject('cycle.png', 'image/png', pngBytes(15))).json()).data;

		const archived = await patchAsset(up.id, JSON.stringify({ archived: true }));
		expect(archived.status).toBe(200);
		expect((await archived.json()).data.archived_at).not.toBeNull();
		const stamped = await ctx.db.query<{
			archived_at: string;
			archived_by_member_id: string | null;
		}>('SELECT archived_at, archived_by_member_id FROM assets WHERE id = $1', [up.id]);
		expect(stamped.rows[0].archived_at).not.toBeNull();
		expect(stamped.rows[0].archived_by_member_id).not.toBeNull();

		// Re-asserting the same state keeps the original stamp.
		const again = await patchAsset(up.id, JSON.stringify({ archived: true }));
		expect(again.status).toBe(200);
		const restamped = await ctx.db.query<{ archived_at: string }>(
			'SELECT archived_at FROM assets WHERE id = $1',
			[up.id],
		);
		expect(restamped.rows[0].archived_at).toEqual(stamped.rows[0].archived_at);

		const restored = await patchAsset(up.id, JSON.stringify({ archived: false }));
		expect(restored.status).toBe(200);
		expect((await restored.json()).data.archived_at).toBeNull();
	});

	it('400s when folder is not a string', async () => {
		const up = (await (await uploadProject('num-folder.png', 'image/png', pngBytes(16))).json())
			.data;
		const res = await patchAsset(up.id, JSON.stringify({ folder: 42 }));
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('folder is required');
	});

	it('400s on an over-deep folder', async () => {
		const up = (await (await uploadProject('deep-move.png', 'image/png', pngBytes(17))).json())
			.data;
		const res = await patchAsset(up.id, JSON.stringify({ folder: 'x/y/z' }));
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_FOLDER');
	});

	it('moves the asset into a folder and back, no-oping a same-path move', async () => {
		const up = (await (await uploadProject('mover.png', 'image/png', pngBytes(18))).json()).data;

		const moved = await patchAsset(up.id, JSON.stringify({ folder: 'bin/sub' }));
		expect(moved.status).toBe(200);
		const movedBody = (await moved.json()).data;
		expect(movedBody.original_filename).toBe('bin/sub/mover.png');
		expect(movedBody.url).toMatch(/^\/api\/assets\//);
		expect(movedBody.comment_attachment_count).toBe(0);

		// Re-asserting the same folder is a no-op that still returns the row.
		const same = await patchAsset(up.id, JSON.stringify({ folder: 'bin/sub' }));
		expect(same.status).toBe(200);
		expect((await same.json()).data.original_filename).toBe('bin/sub/mover.png');

		const root = await patchAsset(up.id, JSON.stringify({ folder: '' }));
		expect(root.status).toBe(200);
		expect((await root.json()).data.original_filename).toBe('mover.png');
	});

	it('409s when the destination path is already taken', async () => {
		await uploadProject('taken.png', 'image/png', pngBytes(19), 'full');
		const loose = (await (await uploadProject('taken.png', 'image/png', pngBytes(20))).json()).data;
		const res = await patchAsset(loose.id, JSON.stringify({ folder: 'full' }));
		expect(res.status).toBe(409);
		expect((await res.json()).error.code).toBe('CONFLICT');
	});
});

describe('public signed-URL serving (GET /api/assets/:assetId)', () => {
	it('401s without signature params', async () => {
		const res = await ctx.app.request(`/api/assets/${randomUUID()}`);
		expect(res.status).toBe(401);
		expect((await res.json()).error.message).toContain('Missing signature');
	});

	it('401s on an invalid signature', async () => {
		const up = (await (await uploadProject('sig.png', 'image/png', pngBytes(21))).json()).data;
		const res = await ctx.app.request(`/api/assets/${up.id}?exp=9999999999&sig=deadbeef`);
		expect(res.status).toBe(401);
		expect((await res.json()).error.message).toContain('Invalid or expired');
	});

	it('404s for a validly-signed but nonexistent asset row', async () => {
		const ghostId = randomUUID();
		const url = await signAssetUrl(ghostId, ctx.masterKeyManager);
		const res = await ctx.app.request(url);
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toContain('Asset not found');
	});

	it('404s when the blob is missing on disk', async () => {
		const up = (await (await uploadProject('vanish.png', 'image/png', pngBytes(22))).json()).data;
		rmSync(join(ctx.dataDir, 'assets', projectId, up.id));
		const res = await ctx.app.request(up.url);
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toContain('Asset file missing');
	});

	it('serves bytes with basename download filename, nosniff, and cache headers', async () => {
		const bytes = pngBytes(23);
		const up = (
			await (await uploadProject('served.png', 'image/png', bytes, 'gallery/main')).json()
		).data;
		const res = await ctx.app.request(up.url);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('content-length')).toBe(String(bytes.byteLength));
		expect(res.headers.get('content-disposition')).toContain('filename="served.png"');
		expect(res.headers.get('content-disposition')).not.toContain('gallery');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
		expect(res.headers.get('content-security-policy')).toBeNull();
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
	});

	it('serves html with a sandbox CSP pinned to an opaque origin', async () => {
		const up = (
			await (
				await uploadProject('mock.html', 'text/html', new TextEncoder().encode('<h1>x</h1>'))
			).json()
		).data;
		const res = await ctx.app.request(up.url);
		expect(res.status).toBe(200);
		const csp = res.headers.get('content-security-policy');
		expect(csp).toContain('sandbox');
		expect(csp).not.toContain('allow-same-origin');
	});
});

describe('asset store failures (injected failing store)', () => {
	// A store whose write/read fail on demand, exercising the error mappings the
	// filesystem driver cannot produce in a test: AttachmentTooLargeError -> 400,
	// generic write failure -> 500, generic read failure -> 500.
	const blobs = new Map<string, Buffer>();
	let readShouldFail = false;
	const failingStore: AssetStore = {
		kind: 'local',
		async write(projectIdArg: string, assetId: string, source: Blob): Promise<WriteAssetResult> {
			const name = (source as File).name ?? '';
			if (name.startsWith('too-large')) throw new AttachmentTooLargeError();
			if (name.startsWith('boom')) throw new Error('disk on fire');
			const buf = Buffer.from(await source.arrayBuffer());
			blobs.set(`${projectIdArg}/${assetId}`, buf);
			return { byteSize: buf.byteLength, sha256: '0'.repeat(64) };
		},
		async read(projectIdArg: string, assetId: string): Promise<Buffer> {
			if (readShouldFail) throw new Error('bucket unreachable');
			const buf = blobs.get(`${projectIdArg}/${assetId}`);
			if (!buf) throw new AssetNotFoundError(projectIdArg, assetId);
			return buf;
		},
		async delete() {},
		async deleteProjectAssets() {},
		async close() {},
	};

	let failApp: Awaited<ReturnType<typeof createTestApp>>;
	let failSlug: string;

	beforeAll(async () => {
		failApp = await createTestApp({ assetStore: failingStore });
		const teamRes = await createTestTeam(failApp.db, { name: 'Failing Store Co' });
		const failTeamId = (await teamRes.json()).data.id;
		const projectRes = await createTestProject(failApp.db, failTeamId, { name: 'Flaky' });
		failSlug = (await projectRes.json()).data.slug;
	});

	afterAll(async () => {
		await safeClose(failApp.db);
		rmSync(failApp.dataDir, { recursive: true, force: true });
	});

	async function uploadToFailing(filename: string): Promise<Response> {
		return failApp.app.request(`/api/projects/${failSlug}/assets`, {
			method: 'POST',
			headers: { ...authHeader(failApp.token) },
			body: fileForm(filename, 'image/png', pngBytes(30)),
		});
	}

	it('maps AttachmentTooLargeError from the store to 400 TOO_LARGE', async () => {
		const res = await uploadToFailing('too-large.png');
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('TOO_LARGE');
	});

	it('maps a generic store write failure to 500 INTERNAL_ERROR without a row', async () => {
		const res = await uploadToFailing('boom.png');
		expect(res.status).toBe(500);
		expect((await res.json()).error.code).toBe('INTERNAL_ERROR');
		const rows = await failApp.db.query(
			"SELECT 1 FROM assets WHERE original_filename = 'boom.png'",
		);
		expect(rows.rows).toHaveLength(0);
	});

	it('maps a generic store read failure to 500 (asset exists, fetch failed)', async () => {
		const up = await uploadToFailing('readable.png');
		expect(up.status).toBe(201);
		const { url } = (await up.json()).data;

		readShouldFail = true;
		try {
			const res = await failApp.app.request(url);
			expect(res.status).toBe(500);
			expect((await res.json()).error.message).toContain('Failed to read asset');
		} finally {
			readShouldFail = false;
		}
	});
});
