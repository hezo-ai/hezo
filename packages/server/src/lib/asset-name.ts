import { randomBytes } from 'node:crypto';
import type { Db } from '../db/database';
import { isUniqueViolation } from './sql';

function splitExtension(name: string): { base: string; ext: string } {
	// The extension lives in the basename: a dot inside a folder segment
	// (`blog.v2/readme`) must never be treated as one, or a collision suffix
	// would land mid-path and silently rename the folder.
	const slash = name.lastIndexOf('/');
	const dot = name.lastIndexOf('.');
	if (dot <= slash + 1) return { base: name, ext: '' };
	return { base: name.slice(0, dot), ext: name.slice(dot) };
}

function withSuffix(name: string, suffix: string): string {
	const { base, ext } = splitExtension(name);
	return `${base}-${suffix}${ext}`;
}

function randomSuffix(bytes = 3): string {
	return randomBytes(bytes).toString('hex');
}

/**
 * Return `desired` if no asset in the project already uses that filename,
 * otherwise append a short random suffix before the extension until it is free.
 * The DB's UNIQUE(project_id, original_filename) constraint is the real backstop
 * (see `insertAssetWithUniqueName`); this just produces a friendly first guess.
 */
export async function uniqueAssetName(db: Db, projectId: string, desired: string): Promise<string> {
	const taken = async (candidate: string): Promise<boolean> => {
		const r = await db.query(
			'SELECT 1 FROM assets WHERE project_id = $1 AND original_filename = $2 LIMIT 1',
			[projectId, candidate],
		);
		return r.rows.length > 0;
	};
	if (!(await taken(desired))) return desired;
	for (let i = 0; i < 10; i++) {
		const candidate = withSuffix(desired, randomSuffix());
		if (!(await taken(candidate))) return candidate;
	}
	return withSuffix(desired, randomSuffix(8));
}

export interface InsertAssetInput {
	assetId: string;
	teamId: string;
	projectId: string;
	contentType: string;
	byteSize: number;
	sha256: string;
	/** Already passed through `normalizeAssetFilename`. */
	desiredName: string;
	uploadedByMemberId: string | null;
	/** Pixel dimensions for raster images (PNG/JPEG/GIF/WebP); null otherwise. */
	width?: number | null;
	height?: number | null;
	/**
	 * Extracted searchable text (`extractAssetSearchText`): a string for a textual
	 * asset ('' when it yielded nothing indexable), null for a binary one, which
	 * is searchable by filename alone. Required rather than optional on purpose:
	 * only the caller holds the bytes, and one that forgets writes an asset whose
	 * contents nothing can ever find. Making it required turns that into a
	 * compile error instead of a silent gap.
	 */
	searchText: string | null;
}

export interface InsertedAsset {
	id: string;
	content_type: string;
	byte_size: number;
	original_filename: string;
	width: number | null;
	height: number | null;
}

/**
 * Insert an asset row under a project-unique filename. Computes a free name, then
 * retries with a fresh random suffix if a concurrent upload wins the race on the
 * UNIQUE(project_id, original_filename) constraint. The on-disk blob is keyed by
 * `assetId`, so a name retry never needs to rewrite the file.
 */
export async function insertAssetWithUniqueName(
	db: Db,
	input: InsertAssetInput,
): Promise<InsertedAsset> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < 6; attempt++) {
		const name = await uniqueAssetName(db, input.projectId, input.desiredName);
		try {
			const r = await db.query<InsertedAsset>(
				`INSERT INTO assets (id, team_id, project_id, content_type, byte_size, sha256, original_filename, uploaded_by_member_id, width, height, search_text)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
				 RETURNING id, content_type, byte_size, original_filename, width, height`,
				[
					input.assetId,
					input.teamId,
					input.projectId,
					input.contentType,
					input.byteSize,
					input.sha256,
					name,
					input.uploadedByMemberId,
					input.width ?? null,
					input.height ?? null,
					input.searchText,
				],
			);
			return r.rows[0];
		} catch (e) {
			if (isUniqueViolation(e)) {
				lastErr = e;
				continue;
			}
			throw e;
		}
	}
	throw lastErr ?? new Error('Failed to insert asset with a unique name');
}

/**
 * The id of the archived asset holding `filename` in this project, or null when
 * the path is free or held by an active asset. An archived asset keeps its path
 * reserved, so callers use this as a pre-flight before spending bytes on a write
 * that `upsertProjectAsset` would refuse anyway.
 */
export async function archivedAssetHolderId(
	db: Db,
	projectId: string,
	filename: string,
): Promise<string | null> {
	const r = await db.query<{ id: string }>(
		'SELECT id FROM assets WHERE project_id = $1 AND original_filename = $2 AND archived_at IS NOT NULL',
		[projectId, filename],
	);
	return r.rows[0]?.id ?? null;
}

export type UpsertProjectAssetResult =
	| {
			status: 'written';
			asset: InsertedAsset;
			replacedAssetId: string | null;
			wipedReviewComments: boolean;
	  }
	/** The path is held by an archived asset — nothing was written. */
	| { status: 'archived'; assetId: string };

/**
 * Insert an asset under an exact filename, or overwrite the row if one already
 * exists for that `(project_id, original_filename)`. Used by agent-authored
 * assets (e.g. an iterated HTML mockup) so the reference stays stable at
 * `assets/<filename>` instead of accreting random suffixes on each re-save. The
 * caller writes the new blob keyed by `assetId`; on overwrite the previous
 * `assetId`'s blob is orphaned and should be cleaned up by the caller.
 *
 * An **archived** holder is refused (`status: 'archived'`, no writes issued):
 * archival keeps the path reserved, so overwriting would silently clobber
 * soft-deleted content. The rule lives here rather than at each call site so a
 * new caller inherits it, and the lookup runs inside the transaction that does
 * the write so an archive landing mid-request can't slip past it.
 *
 * Overwriting deletes the asset's pending review comments in the same
 * transaction (they are version-scoped, like document review comments — and the
 * id swap below would otherwise trip the `review_comments.asset_id` FK).
 * `wipedReviewComments` tells the caller to broadcast the cleared event.
 */
export async function upsertProjectAsset(
	db: Db,
	input: InsertAssetInput,
): Promise<UpsertProjectAssetResult> {
	return db.transaction(async (tx) => {
		const existing = await tx.query<{ id: string; archived_at: string | null }>(
			`SELECT id, archived_at FROM assets
			 WHERE project_id = $1 AND original_filename = $2 LIMIT 1 FOR UPDATE`,
			[input.projectId, input.desiredName],
		);
		const prior = existing.rows[0] ?? null;
		if (prior?.archived_at != null) {
			return { status: 'archived', assetId: prior.id };
		}
		if (prior) {
			const wiped = await tx.query<{ id: string }>(
				'DELETE FROM review_comments WHERE asset_id = $1 RETURNING id',
				[prior.id],
			);
			const r = await tx.query<InsertedAsset>(
				// `search_text` must move with the bytes: an overwrite that left the
				// prior value in place would index the old content against the new file.
				`UPDATE assets
				 SET id = $1, content_type = $2, byte_size = $3, sha256 = $4,
				     uploaded_by_member_id = $5, width = $6, height = $7, search_text = $8,
				     created_at = now()
				 WHERE project_id = $9 AND original_filename = $10
				 RETURNING id, content_type, byte_size, original_filename, width, height`,
				[
					input.assetId,
					input.contentType,
					input.byteSize,
					input.sha256,
					input.uploadedByMemberId,
					input.width ?? null,
					input.height ?? null,
					input.searchText,
					input.projectId,
					input.desiredName,
				],
			);
			return {
				status: 'written',
				asset: r.rows[0],
				replacedAssetId: prior.id,
				wipedReviewComments: wiped.rows.length > 0,
			};
		}
		// No row to lock, so UNIQUE(project_id, original_filename) is still the
		// backstop against a concurrent insert — callers handle the violation.
		const r = await tx.query<InsertedAsset>(
			`INSERT INTO assets (id, team_id, project_id, content_type, byte_size, sha256, original_filename, uploaded_by_member_id, width, height, search_text)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
			 RETURNING id, content_type, byte_size, original_filename, width, height`,
			[
				input.assetId,
				input.teamId,
				input.projectId,
				input.contentType,
				input.byteSize,
				input.sha256,
				input.desiredName,
				input.uploadedByMemberId,
				input.width ?? null,
				input.height ?? null,
				input.searchText,
			],
		);
		return {
			status: 'written',
			asset: r.rows[0],
			replacedAssetId: null,
			wipedReviewComments: false,
		};
	});
}
