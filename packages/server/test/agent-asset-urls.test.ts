import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { AGENT_ASSET_URL_TTL_SECONDS, signAgentAssetUrl } from '../src/lib/asset-urls';
import type { Env } from '../src/lib/types';
import { loadAgentAttachmentsForComments } from '../src/services/agent-runner';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

/**
 * Agents receive assets exclusively as signed download URLs (there is no
 * container mount). This suite pins the URL contract: absolute
 * host.docker.internal origin, the long agent TTL, and — the part that
 * matters — that the public serve route actually accepts the signed path.
 */

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let taskId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'URL Co' });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'URLs', description: 'x' });
	projectId = (await projectRes.json()).data.id;
	const agentRes = await app.request(`/api/projects/${projectId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'URL Bot' }),
	});
	const agentId = (await agentRes.json()).data.id;
	const taskRes = await app.request(`/api/projects/${projectId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'URL Task', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function seedAttachment(): Promise<{ commentId: string; assetId: string }> {
	const comment = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, content_type, content)
		 VALUES ($1, 'text', $2::jsonb) RETURNING id`,
		[taskId, JSON.stringify({ text: 'see attached' })],
	);
	const bytes = Buffer.from('attachment bytes');
	const fd = new FormData();
	const ab = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(ab).set(bytes);
	fd.set('file', new File([ab], 'notes.txt', { type: 'text/plain' }));
	const upload = await app.request(`/api/projects/${projectId}/tasks/${taskId}/assets`, {
		method: 'POST',
		headers: { ...authHeader(token) },
		body: fd,
	});
	const assetId = (await upload.json()).data.id as string;
	await db.query('INSERT INTO comment_attachments (comment_id, asset_id) VALUES ($1, $2)', [
		comment.rows[0].id,
		assetId,
	]);
	return { commentId: comment.rows[0].id, assetId };
}

describe('agent-facing signed asset URLs', () => {
	it('signAgentAssetUrl builds an absolute host.docker.internal URL with the 24h TTL', async () => {
		const url = await signAgentAssetUrl('some-asset-id', masterKeyManager, 3123);
		const parsed = new URL(url);
		expect(parsed.protocol).toBe('http:');
		expect(parsed.host).toBe('host.docker.internal:3123');
		expect(parsed.pathname).toBe('/api/assets/some-asset-id');
		const exp = Number(parsed.searchParams.get('exp'));
		const now = Math.floor(Date.now() / 1000);
		expect(exp).toBeGreaterThan(now + AGENT_ASSET_URL_TTL_SECONDS - 60);
		expect(exp).toBeLessThanOrEqual(now + AGENT_ASSET_URL_TTL_SECONDS);
	});

	it('attachment URLs from loadAgentAttachmentsForComments are accepted by the serve route', async () => {
		const { commentId, assetId } = await seedAttachment();
		const out = await loadAgentAttachmentsForComments(db, [commentId], masterKeyManager, 3100);
		const [attachment] = out.get(commentId) ?? [];
		expect(attachment.id).toBe(assetId);

		const parsed = new URL(attachment.url);
		expect(parsed.host).toBe('host.docker.internal:3100');
		const res = await app.request(`${parsed.pathname}${parsed.search}`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('attachment bytes');
	});
});
