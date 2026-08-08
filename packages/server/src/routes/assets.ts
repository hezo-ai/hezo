import { randomUUID } from 'node:crypto';
import {
	AssetSortOrder,
	ATTACHMENT_EXTENSIONS,
	ATTACHMENT_MAX_BYTES,
	AuthType,
	assetBasename,
	assetContentDisposition,
	assetServeCsp,
	isAllowedAttachmentExtension,
	isAssetSortOrder,
	normalizeAssetFilename,
	normalizeAssetFolder,
	normalizeAssetPath,
	resolveAttachmentContentType,
	taskUploadsFolder,
	wsRoom,
} from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AssetNotFoundError, AttachmentTooLargeError } from '../assets/store';
import {
	archivedAssetHolderId,
	insertAssetWithUniqueName,
	upsertProjectAsset,
} from '../lib/asset-name';
import { assetSortOrderBy } from '../lib/asset-sort';
import { signAssetUrl, verifyAssetUrl } from '../lib/asset-urls';
import { broadcastChange, broadcastCommentFamilyChange } from '../lib/broadcast';
import { asBodyBytes } from '../lib/bytes';
import { readImageDimensions } from '../lib/image-dimensions';
import { ref } from '../lib/log-ref';
import {
	actorTypeFromAuth,
	apiKeyIdFromAuth,
	resolveActorMemberId,
	resolveProjectId,
	resolveTaskId,
} from '../lib/resolve';
import { err, ok } from '../lib/response';
import { isUniqueViolation } from '../lib/sql';
import type { Env } from '../lib/types';
import { logger } from '../logger';

const log = logger.child('routes');

export const assetsRoutes = new Hono<Env>();

/** Refusal text for an overwrite aimed at a path an archived asset still holds. */
const archivedOverwriteMessage = (name: string) =>
	`Asset 'assets/${name}' exists but is archived — unarchive it first to overwrite it, or upload under a different path.`;

/**
 * Validate an uploaded file, write its bytes to disk, and insert an `assets` row.
 * Shared by the task-comment upload, the project Assets upload, and the MCP
 * multipart endpoint. Destination naming:
 *   - `opts.path` — a full destination path (folders + basename, up to 2 levels)
 *     that is preserved verbatim; used by the MCP endpoint so a large binary can
 *     be streamed straight to an exact path.
 *   - otherwise — the historical `folder` (up to 2 levels; '' or undefined =
 *     root) combined with the uploaded file's basename.
 * Collision handling:
 *   - `opts.overwrite` — replace an existing asset at the exact path in place
 *     (stable reference), matching `write_project_asset`; an archived holder is
 *     rejected rather than silently resurrected.
 *   - otherwise — a project-unique name (auto-suffixed on collision).
 * Returns a `201` response with the stored asset + a freshly-signed read URL, or
 * an error response.
 */
export async function storeUploadedAsset(
	c: Context<Env>,
	teamId: string,
	projectId: string,
	file: File,
	taskId?: string | null,
	folder?: string,
	opts?: { path?: string; overwrite?: boolean },
) {
	// Resolve the destination name first — its extension governs the stored
	// content type. An explicit full `path` preserves its folders; otherwise the
	// `folder` field is combined with the uploaded file's basename.
	let desiredName: string;
	if (opts?.path !== undefined) {
		const normalizedPath = normalizeAssetPath(opts.path);
		if (normalizedPath === null) {
			return err(
				c,
				'INVALID_PATH',
				'Invalid path: at most 2 folder levels, each segment starting with a letter or digit',
				400,
			);
		}
		desiredName = normalizedPath;
	} else {
		const normalizedFolder = normalizeAssetFolder(folder ?? '');
		if (normalizedFolder === null) {
			return err(
				c,
				'INVALID_FOLDER',
				'Invalid folder: at most 2 levels, each segment starting with a letter or digit',
				400,
			);
		}
		const base = normalizeAssetFilename(file.name);
		desiredName = normalizedFolder ? `${normalizedFolder}/${base}` : base;
	}

	const destBasename = assetBasename(desiredName);
	if (!isAllowedAttachmentExtension(destBasename)) {
		return err(c, 'INVALID_ATTACHMENT', 'Unsupported file extension', 400);
	}
	// MIME resolution lives in the shared helper: extension-canonical for
	// text/plain-mapped types (scripts), declared-wins / octet-stream-fallback /
	// reject-mismatch for everything else.
	const contentType = resolveAttachmentContentType(destBasename, file.type);
	if (contentType === null) {
		return err(c, 'INVALID_ATTACHMENT', `Unsupported content type: ${file.type}`, 400);
	}
	if (file.size > ATTACHMENT_MAX_BYTES) {
		return err(c, 'TOO_LARGE', 'Attachment exceeds 10 MB', 400);
	}

	// Capture raster-image pixel dimensions so the asset tools / UI can report
	// them without re-parsing the blob (readImageDimensions returns null for
	// non-raster types incl. SVG).
	const dims = contentType.startsWith('image/')
		? readImageDimensions(Buffer.from(await file.arrayBuffer()))
		: null;

	const db = c.get('db');
	const store = c.get('assetStore');

	// An archived asset keeps its path reserved; overwriting it would silently
	// resurrect (and clobber) soft-deleted content. `upsertProjectAsset` refuses
	// it transactionally, but check up front too so 10 MB of bytes (possibly an
	// S3 PUT) aren't spent on a doomed request.
	if (opts?.overwrite && (await archivedAssetHolderId(db, projectId, desiredName))) {
		return err(c, 'ASSET_ARCHIVED', archivedOverwriteMessage(desiredName), 409);
	}

	const assetId = randomUUID();
	let byteSize: number;
	let sha256: string;
	try {
		const result = await store.write(projectId, assetId, file);
		byteSize = result.byteSize;
		sha256 = result.sha256;
	} catch (e) {
		if (e instanceof AttachmentTooLargeError) {
			return err(c, 'TOO_LARGE', 'Attachment exceeds 10 MB', 400);
		}
		log.error('Failed to store asset blob:', e);
		return err(c, 'INTERNAL_ERROR', 'Failed to store attachment', 500);
	}

	const auth = c.get('auth');
	const uploadedBy = await resolveActorMemberId(db, auth, teamId);
	let asset: { id: string; content_type: string; byte_size: number; original_filename: string };
	try {
		if (opts?.overwrite) {
			const result = await upsertProjectAsset(db, {
				assetId,
				teamId,
				projectId,
				contentType,
				byteSize,
				sha256,
				desiredName,
				uploadedByMemberId: uploadedBy,
				width: dims?.width ?? null,
				height: dims?.height ?? null,
			});
			if (result.status === 'archived') {
				// Archived between the pre-flight above and here. The bytes we just
				// stored have no row pointing at them, so drop them.
				await store.delete(projectId, assetId).catch(() => {});
				return err(c, 'ASSET_ARCHIVED', archivedOverwriteMessage(desiredName), 409);
			}
			// The prior blob at this path is now orphaned (the row points at the new
			// assetId); drop it rather than leak it.
			if (result.replacedAssetId) {
				await store.delete(projectId, result.replacedAssetId).catch(() => {});
			}
			if (result.wipedReviewComments) {
				// The overwrite consumed the pending review (wiped inside the upsert's
				// transaction) — tell viewers so their comment panes clear live.
				broadcastCommentFamilyChange(
					c.get('wsManager'),
					teamId,
					projectId,
					'asset_review_comments',
					'DELETE',
					{ asset_id: result.replacedAssetId, cleared: true },
				);
			}
			asset = {
				id: result.asset.id,
				content_type: result.asset.content_type,
				byte_size: result.asset.byte_size,
				original_filename: result.asset.original_filename,
			};
		} else {
			asset = await insertAssetWithUniqueName(db, {
				assetId,
				teamId,
				projectId,
				contentType,
				byteSize,
				sha256,
				desiredName,
				uploadedByMemberId: uploadedBy,
				width: dims?.width ?? null,
				height: dims?.height ?? null,
			});
		}
	} catch (e) {
		// The blob was already stored; without its row it is unreachable, so drop
		// it rather than leave an orphan (matters more when the store is a bucket).
		await store.delete(projectId, assetId).catch(() => {});
		throw e;
	}

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

	broadcastChange(c, wsRoom.team(teamId), 'assets', 'INSERT', {
		id: asset.id,
		team_id: teamId,
		project_id: projectId,
		original_filename: asset.original_filename,
	});

	const url = await signAssetUrl(assetId, c.get('masterKeyManager'));
	return ok(c, { ...asset, url }, 201);
}

export async function readUploadForm(
	c: Context<Env>,
): Promise<{ file: File; folder?: string } | null> {
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
	const folder = typeof form.folder === 'string' ? form.folder : undefined;
	return { file: file as File, folder };
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
			identifier: string;
		}>(
			`SELECT i.project_id, i.identifier
			 FROM tasks i
			 WHERE i.id = $1 AND i.team_id = $2`,
			[taskId, teamId],
		);
		if (taskLocator.rows.length === 0) {
			return err(c, 'NOT_FOUND', 'Task not found', 404);
		}
		const { project_id: projectId, identifier } = taskLocator.rows[0];

		const upload = await readUploadForm(c);
		if (!upload) return err(c, 'INVALID_REQUEST', 'Missing file field', 400);

		// Task-thread attachments are filed under uploads/<task-identifier> so
		// the library groups each task's uploads without manual sorting, and the
		// folder stays stable when the task is renamed.
		return storeUploadedAsset(
			c,
			teamId,
			projectId,
			upload.file,
			taskId,
			taskUploadsFolder(identifier),
		);
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

		const upload = await readUploadForm(c);
		if (!upload) return err(c, 'INVALID_REQUEST', 'Missing file field', 400);

		return storeUploadedAsset(c, teamId, projectId, upload.file, null, upload.folder);
	},
);

assetsRoutes.get('/projects/:projectId/assets', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	// The sort order is a view concern; an unknown/absent value falls back to
	// Newest, preserving the historical `created_at DESC` default.
	const sortParam = c.req.query('sort');
	const sort = isAssetSortOrder(sortParam) ? sortParam : AssetSortOrder.Newest;

	// Archived assets ride along: the web UI filters client-side (Active /
	// Archived / All with counts) and `assets/<path>` references in comments
	// and docs must keep resolving. Agent-facing listings (MCP) are active-only.
	const rows = await db.query<{
		id: string;
		content_type: string;
		byte_size: number;
		sha256: string;
		original_filename: string;
		created_at: string;
		archived_at: string | null;
		comment_attachment_count: number;
	}>(
		`SELECT a.id, a.content_type, a.byte_size, a.sha256, a.original_filename, a.created_at, a.archived_at,
		        COUNT(ca.comment_id)::int AS comment_attachment_count
		 FROM assets a
		 LEFT JOIN comment_attachments ca ON ca.asset_id = a.id
		 WHERE a.project_id = $1
		 GROUP BY a.id
		 ORDER BY ${assetSortOrderBy(sort, 'a.')}`,
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

	const found = await db.query<{ id: string; original_filename: string }>(
		'SELECT id, original_filename FROM assets WHERE id = $1 AND team_id = $2 AND project_id = $3',
		[assetId, teamId, projectId],
	);
	if (found.rows.length === 0) return err(c, 'NOT_FOUND', 'Asset not found', 404);

	// Removes the row; `comment_attachments` rows cascade. Then drop the blob.
	await db.query('DELETE FROM assets WHERE id = $1', [assetId]);
	await c.get('assetStore').delete(projectId, assetId);

	const actorMemberId = await resolveActorMemberId(db, auth, teamId);
	c.get('events').emit({
		type: 'asset.deleted',
		teamId,
		projectId,
		actorType: actorTypeFromAuth(auth),
		actorMemberId,
		actorApiKeyId: apiKeyIdFromAuth(auth),
		assetIds: [assetId],
		filenames: [found.rows[0].original_filename],
		via: 'admin_delete',
	});

	broadcastChange(c, wsRoom.team(teamId), 'assets', 'DELETE', {
		id: assetId,
		team_id: teamId,
		project_id: projectId,
	});

	return c.json({ data: null }, 200);
});

// Mutate an asset's metadata: move it to a library folder ('' = root), or
// archive/restore it. Exactly one of `folder` / `archived` per call. The folder
// is the only mutable part of the path — the basename travels with the asset.
// Human-only: agents use the `move_project_asset` / `archive_project_asset`
// MCP tools, keeping the REST surface the admin UI's.
assetsRoutes.patch('/projects/:projectId/assets/:assetId', async (c) => {
	const teamId = c.get('teamId') as string;
	const auth = c.get('auth');
	if (auth.type === AuthType.Agent) {
		return err(
			c,
			'FORBIDDEN',
			'Agents manage assets with the move_project_asset / archive_project_asset tools',
			403,
		);
	}
	const db = c.get('db');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);
	const assetId = c.req.param('assetId');

	let body: { folder?: unknown; archived?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return err(c, 'INVALID_REQUEST', 'Invalid JSON body', 400);
	}
	const hasFolder = body.folder !== undefined;
	const hasArchived = body.archived !== undefined;
	if (hasFolder === hasArchived) {
		return err(
			c,
			'INVALID_REQUEST',
			'Provide exactly one of: folder (empty string = library root), archived',
			400,
		);
	}

	const found = await db.query<{ original_filename: string; archived_at: string | null }>(
		'SELECT original_filename, archived_at FROM assets WHERE id = $1 AND team_id = $2 AND project_id = $3',
		[assetId, teamId, projectId],
	);
	if (found.rows.length === 0) return err(c, 'NOT_FOUND', 'Asset not found', 404);

	let nextName = found.rows[0].original_filename;
	if (hasArchived) {
		if (typeof body.archived !== 'boolean') {
			return err(c, 'INVALID_REQUEST', 'archived must be a boolean', 400);
		}
		// Idempotent: re-asserting the current state changes nothing (keeps the
		// original archival stamp instead of refreshing it).
		if ((found.rows[0].archived_at !== null) !== body.archived) {
			const actorMemberId = await resolveActorMemberId(db, auth, teamId);
			await db.query(
				`UPDATE assets
				 SET archived_at = CASE WHEN $2 THEN now() ELSE NULL END,
				     archived_by_member_id = CASE WHEN $2 THEN $3::uuid ELSE NULL END
				 WHERE id = $1`,
				[assetId, body.archived, body.archived ? actorMemberId : null],
			);
			c.get('events').emit({
				type: 'asset.archived',
				teamId,
				projectId,
				actorType: actorTypeFromAuth(auth),
				actorMemberId,
				actorApiKeyId: apiKeyIdFromAuth(auth),
				assetId,
				filename: found.rows[0].original_filename,
				archived: body.archived,
			});
		}
	} else {
		// An archived asset is frozen, so it can't be moved or renamed either —
		// matching move_project_asset, which refuses an archived source. The web
		// app hides the Move action on archived cards; this is the real rule.
		if (found.rows[0].archived_at !== null) {
			return err(
				c,
				'ASSET_ARCHIVED',
				`Asset 'assets/${found.rows[0].original_filename}' is archived - restore it first to move or rename it.`,
				409,
			);
		}
		if (typeof body.folder !== 'string') {
			return err(c, 'INVALID_REQUEST', 'folder is required (empty string = library root)', 400);
		}
		const folder = normalizeAssetFolder(body.folder);
		if (folder === null) {
			return err(
				c,
				'INVALID_FOLDER',
				'Invalid folder: at most 2 levels, each segment starting with a letter or digit',
				400,
			);
		}

		const basename = assetBasename(found.rows[0].original_filename);
		nextName = folder ? `${folder}/${basename}` : basename;
		if (nextName !== found.rows[0].original_filename) {
			try {
				await db.query('UPDATE assets SET original_filename = $1 WHERE id = $2', [
					nextName,
					assetId,
				]);
			} catch (e) {
				if (isUniqueViolation(e)) {
					return err(c, 'CONFLICT', `An asset named '${nextName}' already exists`, 409);
				}
				throw e;
			}
		}
	}

	const row = await db.query<{
		id: string;
		content_type: string;
		byte_size: number;
		original_filename: string;
		created_at: string;
		archived_at: string | null;
		comment_attachment_count: number;
	}>(
		`SELECT a.id, a.content_type, a.byte_size, a.original_filename, a.created_at, a.archived_at,
		        COUNT(ca.comment_id)::int AS comment_attachment_count
		 FROM assets a
		 LEFT JOIN comment_attachments ca ON ca.asset_id = a.id
		 WHERE a.id = $1
		 GROUP BY a.id`,
		[assetId],
	);

	broadcastChange(c, wsRoom.team(teamId), 'assets', 'UPDATE', {
		id: assetId,
		team_id: teamId,
		project_id: projectId,
		original_filename: nextName,
	});

	const url = await signAssetUrl(assetId, c.get('masterKeyManager'));
	return ok(c, { ...row.rows[0], url });
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
		project_id: string;
	}>(
		`SELECT content_type, original_filename, byte_size, project_id
		 FROM assets
		 WHERE id = $1`,
		[assetId],
	);
	if (row.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Asset not found', 404);
	}
	const { content_type, original_filename, project_id } = row.rows[0];

	// `?download=1` forces an attachment disposition so the viewer's "Download"
	// button saves any asset (e.g. an inline-rendered image) to disk. The URL
	// signature covers only `assetId|exp`, so the extra query param verifies fine.
	const forceDownload = c.req.query('download') === '1';

	let buf: Buffer;
	try {
		buf = await c.get('assetStore').read(project_id, assetId);
	} catch (e) {
		if (e instanceof AssetNotFoundError) {
			log.error(`Asset blob missing for ${ref(original_filename, assetId)}`);
			return err(c, 'NOT_FOUND', 'Asset file missing', 404);
		}
		// A storage/transport failure (e.g. the object store is unreachable) is
		// not a 404 — the asset exists; we just can't fetch it right now.
		log.error(`Failed to read asset ${ref(original_filename, assetId)}:`, e);
		return err(c, 'INTERNAL_ERROR', 'Failed to read asset', 500);
	}

	// Foldered assets keep the folder in `original_filename`; the download
	// filename is the basename only (a `/` in the header parameter would be
	// misread as a path by download managers).
	const filenameSafe = assetBasename(original_filename).replace(/"/g, '');
	const headers: Record<string, string> = {
		'Content-Type': content_type,
		'Content-Length': String(buf.byteLength),
		// SVGs (and other active-content types) download instead of rendering as a
		// top-level document on our origin — see `assetContentDisposition`.
		'Content-Disposition': `${assetContentDisposition(content_type, forceDownload)}; filename="${filenameSafe}"`,
		'Cache-Control': 'private, max-age=3600',
		// Script-ish text (.js/.ts/.sh/...) is stored as text/plain; nosniff stops
		// a browser from re-interpreting it as executable script or anything else.
		'X-Content-Type-Options': 'nosniff',
	};
	// HTML mockups render inline but are pinned to an opaque origin so their
	// script can't reach the app's same-origin credentials.
	const csp = assetServeCsp(content_type);
	if (csp) headers['Content-Security-Policy'] = csp;
	// Re-view the Buffer rather than copying it into a fresh ArrayBuffer: the copy
	// doubled peak memory per download, on a route serving files up to the 10 MB
	// attachment cap, concurrently. See `asBodyBytes`.
	return c.body(asBodyBytes(buf), 200, headers);
});

// Re-export the allowed extensions for tests
export { ATTACHMENT_EXTENSIONS };
