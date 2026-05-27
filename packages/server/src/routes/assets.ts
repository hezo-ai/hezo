import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
	ATTACHMENT_EXTENSIONS,
	ATTACHMENT_MAX_BYTES,
	isAllowedAttachmentExtension,
	isAllowedAttachmentMime,
} from '@hezo/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { signAssetUrl, verifyAssetUrl } from '../lib/asset-urls';
import { resolveActorMemberId, resolveTaskId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { AttachmentTooLargeError, writeAsset } from '../services/asset-storage';
import { getAssetPath } from '../services/workspace';

const log = logger.child('routes');

export const assetsRoutes = new Hono<Env>();

assetsRoutes.post(
	'/teams/:teamId/tasks/:taskId/assets',
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
			team_slug: string;
			project_id: string;
			project_slug: string;
		}>(
			`SELECT t.slug AS team_slug, p.id AS project_id, p.slug AS project_slug
			 FROM tasks i
			 JOIN teams t ON t.id = i.team_id
			 JOIN projects p ON p.id = i.project_id
			 WHERE i.id = $1 AND i.team_id = $2`,
			[taskId, teamId],
		);
		if (taskLocator.rows.length === 0) {
			return err(c, 'NOT_FOUND', 'Task not found', 404);
		}
		const {
			team_slug: teamSlug,
			project_id: projectId,
			project_slug: projectSlug,
		} = taskLocator.rows[0];

		let form: Awaited<ReturnType<typeof c.req.parseBody>>;
		try {
			form = await c.req.parseBody({ all: false });
		} catch (e) {
			log.error('asset upload parseBody failed:', e);
			return err(c, 'INVALID_REQUEST', 'Invalid multipart body', 400);
		}
		const file = form.file;
		if (!(file instanceof Blob) || !('name' in file) || typeof file.name !== 'string') {
			return err(c, 'INVALID_REQUEST', 'Missing file field', 400);
		}
		const filename = (file as File).name;

		if (!isAllowedAttachmentExtension(filename)) {
			return err(c, 'INVALID_ATTACHMENT', 'Unsupported file extension', 400);
		}
		const contentType = file.type || 'application/octet-stream';
		if (!isAllowedAttachmentMime(contentType)) {
			return err(c, 'INVALID_ATTACHMENT', `Unsupported content type: ${contentType}`, 400);
		}
		if (file.size > ATTACHMENT_MAX_BYTES) {
			return err(c, 'TOO_LARGE', 'Attachment exceeds 10 MB', 400);
		}

		const assetId = randomUUID();
		const dataDir = c.get('dataDir');
		let byteSize: number;
		let sha256: string;
		try {
			const result = await writeAsset(dataDir, teamSlug, projectSlug, assetId, file);
			byteSize = result.byteSize;
			sha256 = result.sha256;
		} catch (e) {
			if (e instanceof AttachmentTooLargeError) {
				return err(c, 'TOO_LARGE', 'Attachment exceeds 10 MB', 400);
			}
			log.error('Failed to write asset to disk:', e);
			return err(c, 'INTERNAL_ERROR', 'Failed to store attachment', 500);
		}

		const uploadedBy = await resolveActorMemberId(db, c.get('auth'), teamId);
		const inserted = await db.query<{
			id: string;
			content_type: string;
			byte_size: number;
			original_filename: string;
		}>(
			`INSERT INTO assets (id, team_id, project_id, content_type, byte_size, sha256, original_filename, uploaded_by_member_id)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			 RETURNING id, content_type, byte_size, original_filename`,
			[assetId, teamId, projectId, contentType, byteSize, sha256, filename, uploadedBy],
		);

		const url = await signAssetUrl(assetId, c.get('masterKeyManager'));
		return ok(c, { ...inserted.rows[0], url }, 201);
	},
);

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
		team_slug: string;
		project_slug: string;
	}>(
		`SELECT a.content_type, a.original_filename, a.byte_size,
		        t.slug AS team_slug, p.slug AS project_slug
		 FROM assets a
		 JOIN teams t ON t.id = a.team_id
		 JOIN projects p ON p.id = a.project_id
		 WHERE a.id = $1`,
		[assetId],
	);
	if (row.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Asset not found', 404);
	}
	const { content_type, original_filename, team_slug, project_slug } = row.rows[0];

	const diskPath = getAssetPath(c.get('dataDir'), team_slug, project_slug, assetId);
	let buf: Buffer;
	try {
		buf = await readFile(diskPath);
	} catch (e) {
		log.error(`Failed to read asset ${assetId} from disk:`, e);
		return err(c, 'NOT_FOUND', 'Asset file missing', 404);
	}

	const filenameSafe = original_filename.replace(/"/g, '');
	const ab = new ArrayBuffer(buf.byteLength);
	new Uint8Array(ab).set(buf);
	return c.body(new Uint8Array(ab), 200, {
		'Content-Type': content_type,
		'Content-Length': String(buf.byteLength),
		'Content-Disposition': `inline; filename="${filenameSafe}"`,
		'Cache-Control': 'private, max-age=3600',
	});
});

// Re-export the allowed extensions for tests
export { ATTACHMENT_EXTENSIONS };
