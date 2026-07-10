import { isTextReviewableAssetMime } from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { resolveActorMemberId, resolveProjectId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import {
	clearReviewComments,
	createReviewComment,
	deleteReviewComment,
	listReviewComments,
	StaleAssetError,
	updateReviewComment,
} from '../services/review-comments';

/**
 * Review comments on a project asset, addressed by asset id (unlike the doc
 * routes' `:filename` — asset paths contain `/`, and the id doubles as a stale
 * token since any overwrite swaps it; see `upsertProjectAsset`). Text assets
 * (markdown, plain text) anchor with quote/occurrence exactly like documents;
 * every other type takes un-anchored whole-asset comments. Version-scoped:
 * any overwrite wipes them (enforced in lib/asset-name.ts).
 */
export const assetReviewRoutes = new Hono<Env>();

const BASE = '/projects/:projectId/assets/:assetId/review-comments';

interface AssetContext {
	projectId: string;
	assetId: string;
	contentType: string;
	archived: boolean;
}

async function resolveAsset(c: Context<Env>): Promise<AssetContext | Response> {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId') ?? '');
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);
	const found = await db.query<{ id: string; content_type: string; archived_at: string | null }>(
		`SELECT id, content_type, archived_at FROM assets
		 WHERE id = $1 AND project_id = $2 AND team_id = $3`,
		[c.req.param('assetId') ?? '', projectId, teamId],
	);
	const asset = found.rows[0];
	if (!asset) return err(c, 'NOT_FOUND', 'Asset not found', 404);
	return {
		projectId,
		assetId: asset.id,
		contentType: asset.content_type,
		archived: asset.archived_at !== null,
	};
}

/** Archived assets stay readable but their review is frozen. */
function rejectArchived(c: Context<Env>, resolved: AssetContext): Response | null {
	if (!resolved.archived) return null;
	return err(c, 'FORBIDDEN', 'Asset is archived — restore it to change its review', 403);
}

assetReviewRoutes.get(BASE, async (c) => {
	const resolved = await resolveAsset(c);
	if (resolved instanceof Response) return resolved;
	const comments = await listReviewComments(c.get('db'), {
		kind: 'asset',
		assetId: resolved.assetId,
	});
	return ok(c, comments);
});

assetReviewRoutes.post(BASE, async (c) => {
	const resolved = await resolveAsset(c);
	if (resolved instanceof Response) return resolved;
	const archived = rejectArchived(c, resolved);
	if (archived) return archived;
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const body = await c.req.json<{
		quote?: string;
		occurrence?: number;
		comment?: string;
		asset_sha256?: string;
	}>();
	if (!body.comment || typeof body.comment !== 'string' || body.comment.trim() === '') {
		return err(c, 'INVALID_REQUEST', 'comment is required', 400);
	}
	const textAnchored = isTextReviewableAssetMime(resolved.contentType);
	if (textAnchored) {
		if (!body.quote || typeof body.quote !== 'string') {
			return err(c, 'INVALID_REQUEST', 'quote is required for text assets', 400);
		}
	} else if (body.quote !== undefined || body.occurrence !== undefined) {
		return err(
			c,
			'INVALID_REQUEST',
			'This asset type takes whole-asset comments only — omit quote/occurrence',
			400,
		);
	}
	const occurrence = body.occurrence ?? 0;
	if (typeof occurrence !== 'number' || !Number.isInteger(occurrence) || occurrence < 0) {
		return err(c, 'INVALID_REQUEST', 'occurrence must be a non-negative integer', 400);
	}

	const authorMemberId = await resolveActorMemberId(db, c.get('auth'), teamId);
	try {
		const row = await createReviewComment(db, c.get('wsManager'), {
			teamId,
			projectId: resolved.projectId,
			target: { kind: 'asset', assetId: resolved.assetId },
			quote: textAnchored ? (body.quote as string) : null,
			occurrence,
			comment: body.comment,
			authorMemberId,
			expectedSha256: body.asset_sha256,
		});
		if (!row) return err(c, 'NOT_FOUND', 'Asset not found', 404);
		return c.json({ data: row }, 201);
	} catch (e) {
		if (e instanceof StaleAssetError) {
			return err(c, 'CONFLICT', 'Asset has changed since it was loaded — reload it', 409);
		}
		throw e;
	}
});

assetReviewRoutes.patch(`${BASE}/:commentId`, async (c) => {
	const resolved = await resolveAsset(c);
	if (resolved instanceof Response) return resolved;
	const archived = rejectArchived(c, resolved);
	if (archived) return archived;

	const body = await c.req.json<{ comment?: string }>();
	if (!body.comment || typeof body.comment !== 'string' || body.comment.trim() === '') {
		return err(c, 'INVALID_REQUEST', 'comment is required', 400);
	}

	const row = await updateReviewComment(c.get('db'), c.get('wsManager'), {
		teamId: c.get('teamId') as string,
		projectId: resolved.projectId,
		target: { kind: 'asset', assetId: resolved.assetId },
		commentId: c.req.param('commentId'),
		comment: body.comment,
	});
	if (!row) return err(c, 'NOT_FOUND', 'Review comment not found', 404);
	return ok(c, row);
});

assetReviewRoutes.delete(`${BASE}/:commentId`, async (c) => {
	const resolved = await resolveAsset(c);
	if (resolved instanceof Response) return resolved;
	const archived = rejectArchived(c, resolved);
	if (archived) return archived;

	const removed = await deleteReviewComment(c.get('db'), c.get('wsManager'), {
		teamId: c.get('teamId') as string,
		projectId: resolved.projectId,
		target: { kind: 'asset', assetId: resolved.assetId },
		commentId: c.req.param('commentId'),
	});
	if (!removed) return err(c, 'NOT_FOUND', 'Review comment not found', 404);
	return c.json({ data: null }, 200);
});

assetReviewRoutes.delete(BASE, async (c) => {
	const resolved = await resolveAsset(c);
	if (resolved instanceof Response) return resolved;
	const archived = rejectArchived(c, resolved);
	if (archived) return archived;

	await clearReviewComments(c.get('db'), c.get('wsManager'), {
		teamId: c.get('teamId') as string,
		projectId: resolved.projectId,
		target: { kind: 'asset', assetId: resolved.assetId },
	});
	return c.json({ data: null }, 200);
});
