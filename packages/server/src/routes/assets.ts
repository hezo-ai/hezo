import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
	ATTACHMENT_EXTENSIONS,
	ATTACHMENT_MAX_BYTES,
	AuthType,
	assetContentDisposition,
	assetServeCsp,
	extensionOf,
	isAllowedAttachmentExtension,
	isAllowedAttachmentMime,
	normalizeAssetFilename,
} from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { insertAssetWithUniqueName } from '../lib/asset-name';
import { signAssetUrl, verifyAssetUrl } from '../lib/asset-urls';
import { ref } from '../lib/log-ref';
import {
	actorTypeFromAuth,
	apiKeyIdFromAuth,
	resolveActorMemberId,
	resolveProjectId,
	resolveTaskId,
} from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { AttachmentTooLargeError, deleteAsset, writeAsset } from '../services/asset-storage';
import { getAssetPath } from '../services/workspace';

const log = logger.child('routes');

export const assetsRoutes = new Hono<Env>();

/**
 * Validate an uploaded file, write its bytes to disk, and insert an `assets` row
 * under a project-unique filename (auto-suffixed on collision). Shared by the
 * task-comment upload and the project Assets upload. Returns a `201` response
 * with the stored asset + a freshly-signed read URL, or an error response.
 */
export async function storeUploadedAsset(
	c: Context<Env>,
	teamId: string,
	projectId: string,
	file: File,
	taskId?: string | null,
) {
	if (!isAllowedAttachmentExtension(file.name)) {
		return err(c, 'INVALID_ATTACHMENT', 'Unsupported file extension', 400);
	}
	// Trust the browser's MIME only when it's one we allow; otherwise fall back to
	// the canonical type for the (already validated) extension. Browsers often send
	// an empty type or `application/octet-stream` for files they don't recognise —
	// notably `.md` — which would otherwise be rejected despite a valid extension.
	const ext = extensionOf(file.name);
	const extMime = ext
		? ATTACHMENT_EXTENSIONS[ext as keyof typeof ATTACHMENT_EXTENSIONS]
		: undefined;
	const contentType = file.type && isAllowedAttachmentMime(file.type) ? file.type : (extMime ?? '');
	if (!isAllowedAttachmentMime(contentType)) {
		return err(c, 'INVALID_ATTACHMENT', `Unsupported content type: ${file.type}`, 400);
	}
	if (file.size > ATTACHMENT_MAX_BYTES) {
		return err(c, 'TOO_LARGE', 'Attachment exceeds 10 MB', 400);
	}

	const db = c.get('db');
	const assetId = randomUUID();
	let byteSize: number;
	let sha256: string;
	try {
		const result = await writeAsset(c.get('dataDir'), teamId, projectId, assetId, file);
		byteSize = result.byteSize;
		sha256 = result.sha256;
	} catch (e) {
		if (e instanceof AttachmentTooLargeError) {
			return err(c, 'TOO_LARGE', 'Attachment exceeds 10 MB', 400);
		}
		log.error('Failed to write asset to disk:', e);
		return err(c, 'INTERNAL_ERROR', 'Failed to store attachment', 500);
	}

	const auth = c.get('auth');
	const uploadedBy = await resolveActorMemberId(db, auth, teamId);
	const asset = await insertAssetWithUniqueName(db, {
		assetId,
		teamId,
		projectId,
		contentType,
		byteSize,
		sha256,
		desiredName: normalizeAssetFilename(file.name),
		uploadedByMemberId: uploadedBy,
	});

	const isAgent = auth.type === AuthType.Agent;
	c.get('events').emit({
		type: 'asset.created',
		teamId,
		projectId,
		actorType: actorTypeFromAuth(auth),
		actorMemberId: uploadedBy,
		actorApiKeyId: apiKeyIdFromAuth(auth),
		assetId: asset.id,
		filename: asset.original_filename,
		taskId: taskId ?? (isAgent ? auth.taskId : null),
		runId: isAgent ? auth.runId : null,
	});

	const url = await signAssetUrl(assetId, c.get('masterKeyManager'));
	return ok(c, { ...asset, url }, 201);
}

async function readUploadFile(c: Context<Env>): Promise<File | null> {
	let form: Awaited<ReturnType<typeof c.req.parseBody>>;
	try {
		form = await c.req.parseBody({ all: false });
	} catch (e) {
		log.error('asset upload parseBody failed:', e);
		return null;
	}
	const file = form.file;
	if (!(file instanceof Blob) || !('name' in file) || typeof file.name !== 'string') {
		return null;
	}
	return file as File;
}

assetsRoutes.post(
	'/projects/:projectId/tasks/:taskId/assets',
	bodyLimit({
		maxSize: ATTACHMENT_MAX_BYTES,
		onError: (c) => err(c, 'TOO_LARGE', 'Attachment exceeds 10 MB', 400),
	}),
	async (c) => {
		const teamId = c.get('teamId') as string;
		const db = c.get('db');
		const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
		if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);

		const taskLocator = await db.query<{
			project_id: string;
		}>(
			`SELECT i.project_id
			 FROM tasks i
			 WHERE i.id = $1 AND i.team_id = $2`,
			[taskId, teamId],
		);
		if (taskLocator.rows.length === 0) {
			return err(c, 'NOT_FOUND', 'Task not found', 404);
		}
		const { project_id: projectId } = taskLocator.rows[0];

		const file = await readUploadFile(c);
		if (!file) return err(c, 'INVALID_REQUEST', 'Missing file field', 400);

		return storeUploadedAsset(c, teamId, projectId, file, taskId);
	},
);

// --- Project Assets library ---------------------------------------------------
// A project-scoped, view-only file store (mockups, wireframes, PDFs, uploads).
// Anything that isn't a markdown project doc lives here.

assetsRoutes.post(
	'/projects/:projectId/assets',
	bodyLimit({
		maxSize: ATTACHMENT_MAX_BYTES,
		onError: (c) => err(c, 'TOO_LARGE', 'Attachment exceeds 10 MB', 400),
	}),
	async (c) => {
		const teamId = c.get('teamId') as string;
		const db = c.get('db');
		const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
		if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

		const file = await readUploadFile(c);
		if (!file) return err(c, 'INVALID_REQUEST', 'Missing file field', 400);

		return storeUploadedAsset(c, teamId, projectId, file);
	},
);

assetsRoutes.get('/projects/:projectId/assets', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const rows = await db.query<{
		id: string;
		content_type: string;
		byte_size: number;
		original_filename: string;
		created_at: string;
		comment_attachment_count: number;
	}>(
		`SELECT a.id, a.content_type, a.byte_size, a.original_filename, a.created_at,
		        COUNT(ca.comment_id)::int AS comment_attachment_count
		 FROM assets a
		 LEFT JOIN comment_attachments ca ON ca.asset_id = a.id
		 WHERE a.project_id = $1
		 GROUP BY a.id
		 ORDER BY a.created_at DESC`,
		[projectId],
	);

	const masterKeyManager = c.get('masterKeyManager');
	const assets = await Promise.all(
		rows.rows.map(async (r) => ({ ...r, url: await signAssetUrl(r.id, masterKeyManager) })),
	);
	return ok(c, assets);
});

assetsRoutes.delete('/projects/:projectId/assets/:assetId', async (c) => {
	const teamId = c.get('teamId') as string;
	const auth = c.get('auth');
	if (auth.type === AuthType.Agent) {
		return err(c, 'FORBIDDEN', 'Only the admin can delete assets', 403);
	}
	const db = c.get('db');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);
	const assetId = c.req.param('assetId');

	const found = await db.query<{ id: string }>(
		'SELECT id FROM assets WHERE id = $1 AND team_id = $2 AND project_id = $3',
		[assetId, teamId, projectId],
	);
	if (found.rows.length === 0) return err(c, 'NOT_FOUND', 'Asset not found', 404);

	// Removes the row; `comment_attachments` rows cascade. Then drop the blob.
	await db.query('DELETE FROM assets WHERE id = $1', [assetId]);
	await deleteAsset(c.get('dataDir'), teamId, projectId, assetId);

	return c.json({ data: null }, 200);
});

export const publicAssetsRoutes = new Hono<Env>();

publicAssetsRoutes.get('/api/assets/:assetId', async (c) => {
	const assetId = c.req.param('assetId');
	const expRaw = c.req.query('exp');
	const sig = c.req.query('sig');
	if (!expRaw || !sig) {
		return err(c, 'UNAUTHORIZED', 'Missing signature', 401);
	}
	const exp = Number.parseInt(expRaw, 10);
	const masterKeyManager = c.get('masterKeyManager');
	const valid = await verifyAssetUrl(assetId, exp, sig, masterKeyManager);
	if (!valid) {
		return err(c, 'UNAUTHORIZED', 'Invalid or expired signature', 401);
	}

	const row = await c.get('db').query<{
		content_type: string;
		original_filename: string;
		byte_size: number;
		team_id: string;
		project_id: string;
	}>(
		`SELECT content_type, original_filename, byte_size, team_id, project_id
		 FROM assets
		 WHERE id = $1`,
		[assetId],
	);
	if (row.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Asset not found', 404);
	}
	const { content_type, original_filename, team_id, project_id } = row.rows[0];

	const diskPath = getAssetPath(c.get('dataDir'), team_id, project_id, assetId);
	let buf: Buffer;
	try {
		buf = await readFile(diskPath);
	} catch (e) {
		log.error(`Failed to read asset ${ref(original_filename, assetId)} from disk:`, e);
		return err(c, 'NOT_FOUND', 'Asset file missing', 404);
	}

	const filenameSafe = original_filename.replace(/"/g, '');
	const ab = new ArrayBuffer(buf.byteLength);
	new Uint8Array(ab).set(buf);
	const headers: Record<string, string> = {
		'Content-Type': content_type,
		'Content-Length': String(buf.byteLength),
		// SVGs (and other active-content types) download instead of rendering as a
		// top-level document on our origin — see `assetContentDisposition`.
		'Content-Disposition': `${assetContentDisposition(content_type)}; filename="${filenameSafe}"`,
		'Cache-Control': 'private, max-age=3600',
	};
	// HTML mockups render inline but are pinned to an opaque origin so their
	// script can't reach the app's same-origin credentials.
	const csp = assetServeCsp(content_type);
	if (csp) headers['Content-Security-Policy'] = csp;
	return c.body(new Uint8Array(ab), 200, headers);
});

// Re-export the allowed extensions for tests
export { ATTACHMENT_EXTENSIONS };
