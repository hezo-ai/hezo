import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { signAssetUrl } from '../src/lib/asset-urls';
import type { Env } from '../src/lib/types';
import { blobBytes, safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let dataDir: string;
let teamId: string;
let teamSlug: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let taskIdentifier: string;
let otherProjectId: string;
let otherProjectSlug: string;
let otherTaskId: string;

function buildPng(): Uint8Array {
	const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const extra = new Uint8Array(64);
	for (let i = 0; i < extra.length; i++) extra[i] = i;
	const out = new Uint8Array(sig.length + extra.length);
	out.set(sig, 0);
	out.set(extra, sig.length);
	return out;
}

async function uploadAsset(
	filename: string,
	mime: string,
	bytes: Uint8Array,
	targetTaskId: string = taskId,
	targetProjectSlug: string = projectSlug,
): Promise<Response> {
	const fd = new FormData();
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	fd.set('file', new File([blobBytes(copy)], filename, { type: mime }));
	return app.request(`/api/projects/${targetProjectSlug}/tasks/${targetTaskId}/assets`, {
		method: 'POST',
		headers: { ...authHeader(token) },
		body: fd,
	});
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = ctx.dataDir;

	const teamRes = await createTestTeam(db, { name: 'Attach Co' });
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;
	teamSlug = teamData.slug;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Main',
		description: 'Attachments project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Attach Bot' }),
	});
	const agentId = (await agentRes.json()).data.id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Attachable Task',
			assignee_id: agentId,
		}),
	});
	if (taskRes.status !== 201) {
		throw new Error(`Task create failed: ${taskRes.status} ${await taskRes.text()}`);
	}
	const taskData = (await taskRes.json()).data;
	taskId = taskData.id;
	taskIdentifier = taskData.identifier;

	// A team owns exactly one project, so the cross-project isolation case needs a
	// second team to host the "other" project.
	const otherTeamRes = await createTestTeam(db, { name: 'Other Attach Co' });
	const otherTeamId = (await otherTeamRes.json()).data.id;

	const otherProjectRes = await createTestProject(db, otherTeamId, {
		name: 'Other',
		description: 'Isolation test.',
	});
	const otherProjectData = (await otherProjectRes.json()).data;
	otherProjectId = otherProjectData.id;
	otherProjectSlug = otherProjectData.slug;

	const otherAgentRes = await app.request(`/api/projects/${otherProjectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Other Bot' }),
	});
	const otherAgentId = (await otherAgentRes.json()).data.id;

	const otherTaskRes = await app.request(`/api/projects/${otherProjectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: otherProjectId,
			title: 'Other Task',
			assignee_id: otherAgentId,
		}),
	});
	otherTaskId = (await otherTaskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('asset upload', () => {
	it('rejects unsupported extensions', async () => {
		const res = await uploadAsset('virus.exe', 'application/octet-stream', new Uint8Array([0]));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_ATTACHMENT');
	});

	it('rejects disallowed MIMEs even with allowed extension', async () => {
		const res = await uploadAsset('sneaky.png', 'application/x-msdownload', buildPng());
		expect(res.status).toBe(400);
	});

	it('stores an uploaded PNG on disk with computed sha256', async () => {
		const bytes = buildPng();
		const expectedSha = createHash('sha256').update(bytes).digest('hex');
		const res = await uploadAsset('shot.png', 'image/png', bytes);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(body.data.content_type).toBe('image/png');
		// Task-thread uploads are filed under uploads/<task-identifier>.
		expect(body.data.original_filename).toBe(`uploads/${taskIdentifier}/shot.png`);
		expect(body.data.byte_size).toBe(bytes.byteLength);
		expect(body.data.url).toMatch(/^\/api\/assets\/[0-9a-f-]+\?exp=\d+&sig=/);

		const onDisk = join(dataDir, 'assets', projectId, body.data.id);
		expect(existsSync(onDisk)).toBe(true);
		const written = readFileSync(onDisk);
		expect(createHash('sha256').update(written).digest('hex')).toBe(expectedSha);
	});

	it('rejects uploads above 10 MB', async () => {
		const huge = new Uint8Array(10 * 1024 * 1024 + 1);
		const res = await uploadAsset('large.png', 'image/png', huge);
		expect(res.status).toBe(400);
	});

	it('accepts a zip however the browser spelled its content type', async () => {
		// Windows Chrome and Edge read `application/x-zip-compressed` out of the
		// registry; Firefox and Safari send `application/zip`. The extension decides,
		// so every spelling stores the one canonical type.
		const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
		for (const [name, declared] of [
			['bundle.zip', 'application/x-zip-compressed'],
			['export.zip', 'application/zip'],
			['blob.zip', 'application/octet-stream'],
		]) {
			const res = await uploadAsset(name, declared, zip);
			expect(res.status, `${name} declared ${declared}`).toBe(201);
			const body = await res.json();
			expect(body.data.content_type).toBe('application/zip');
			expect(body.data.original_filename).toBe(`uploads/${taskIdentifier}/${name}`);
			expect(body.data.byte_size).toBe(zip.byteLength);
		}
	});

	it('stores the other archive formats under their canonical types', async () => {
		const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
		for (const [name, declared, expected] of [
			['logs.tar', '', 'application/x-tar'],
			// A double extension resolves through its last segment, name intact.
			['backup.tar.gz', 'application/x-gzip', 'application/gzip'],
			['snapshot.tgz', '', 'application/gzip'],
			['files.7z', '', 'application/x-7z-compressed'],
			['legacy.rar', 'application/x-rar-compressed', 'application/vnd.rar'],
		]) {
			const res = await uploadAsset(name, declared, bytes);
			expect(res.status, name).toBe(201);
			const body = await res.json();
			expect(body.data.content_type, name).toBe(expected);
			expect(body.data.original_filename).toBe(`uploads/${taskIdentifier}/${name}`);
		}
	});

	it('serves an archive as a forced download', async () => {
		const upload = await uploadAsset(
			'served.zip',
			'application/zip',
			new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
		);
		expect(upload.status).toBe(201);
		const { url } = (await upload.json()).data;

		// An archive has nothing to render, so it must never come back inline.
		const res = await app.request(url);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/zip');
		expect(res.headers.get('content-disposition')).toBe('attachment; filename="served.zip"');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(
			new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
		);
	});
});

describe('signed URLs', () => {
	let assetId: string;
	let signedUrl: string;

	beforeAll(async () => {
		const res = await uploadAsset('signed.png', 'image/png', buildPng());
		const body = await res.json();
		assetId = body.data.id;
		signedUrl = body.data.url;
	});

	it('returns the file when the signature is valid', async () => {
		const res = await app.request(signedUrl);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('content-disposition')).toContain('signed.png');
		const buf = new Uint8Array(await res.arrayBuffer());
		expect(buf.byteLength).toBeGreaterThan(0);
	});

	it('rejects requests with a tampered signature', async () => {
		const tampered = signedUrl.replace(
			/sig=[^&]+/,
			'sig=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
		);
		const res = await app.request(tampered);
		expect(res.status).toBe(401);
	});

	it('rejects expired signatures', async () => {
		const expired = await signAssetUrl(assetId, masterKeyManager, -10);
		const res = await app.request(expired);
		expect(res.status).toBe(401);
	});

	it('returns 404 for unknown asset ids with valid signature', async () => {
		const fakeUrl = await signAssetUrl('00000000-0000-0000-0000-000000000000', masterKeyManager);
		const res = await app.request(fakeUrl);
		expect(res.status).toBe(404);
	});

	it('rejects URLs missing exp or sig', async () => {
		const res = await app.request(`/api/assets/${assetId}`);
		expect(res.status).toBe(401);
	});
});

describe('comment + attachments', () => {
	it('links uploaded assets to a comment and returns them on GET', async () => {
		const upload = await uploadAsset('doc.pdf', 'application/pdf', new Uint8Array([1, 2, 3, 4]));
		const assetId = (await upload.json()).data.id;

		const createRes = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: 'See attached' },
				attachment_ids: [assetId],
			}),
		});
		expect(createRes.status).toBe(201);
		const created = (await createRes.json()).data;
		expect(created.attachments).toBeDefined();
		expect(created.attachments).toHaveLength(1);
		expect(created.attachments[0].id).toBe(assetId);
		expect(created.attachments[0].original_filename).toBe(`uploads/${taskIdentifier}/doc.pdf`);
		expect(created.attachments[0].url).toMatch(/^\/api\/assets\/[0-9a-f-]+\?exp=\d+&sig=/);

		const listRes = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
			headers: authHeader(token),
		});
		const list = (await listRes.json()).data;
		const fromList = list.find((c: { id: string }) => c.id === created.id);
		expect(fromList.attachments).toHaveLength(1);
		expect(fromList.attachments[0].id).toBe(assetId);
	});

	it('rejects attaching an asset from another project', async () => {
		const upload = await uploadAsset(
			'other.png',
			'image/png',
			buildPng(),
			otherTaskId,
			otherProjectSlug,
		);
		const otherAssetId = (await upload.json()).data.id;

		const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: 'cross-project' },
				attachment_ids: [otherAssetId],
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_REQUEST');
	});

	it('cascades comment_attachments rows when the comment is deleted', async () => {
		const upload = await uploadAsset('todelete.txt', 'text/plain', new Uint8Array([42]));
		const assetId = (await upload.json()).data.id;

		const createRes = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: 'to delete' },
				attachment_ids: [assetId],
			}),
		});
		const commentId = (await createRes.json()).data.id;

		await db.query('DELETE FROM task_comments WHERE id = $1', [commentId]);
		const remaining = await db.query<{ id: string }>(
			'SELECT id FROM comment_attachments WHERE comment_id = $1',
			[commentId],
		);
		expect(remaining.rows).toHaveLength(0);
	});
});
