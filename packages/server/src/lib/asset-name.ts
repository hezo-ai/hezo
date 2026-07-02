import { randomBytes } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
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
export async function uniqueAssetName(
	db: PGlite,
	projectId: string,
	desired: string,
): Promise<string> {
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
}

export interface InsertedAsset {
	id: string;
	content_type: string;
	byte_size: number;
	original_filename: string;
}

/**
 * Insert an asset row under a project-unique filename. Computes a free name, then
 * retries with a fresh random suffix if a concurrent upload wins the race on the
 * UNIQUE(project_id, original_filename) constraint. The on-disk blob is keyed by
 * `assetId`, so a name retry never needs to rewrite the file.
 */
export async function insertAssetWithUniqueName(
	db: PGlite,
	input: InsertAssetInput,
): Promise<InsertedAsset> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < 6; attempt++) {
		const name = await uniqueAssetName(db, input.projectId, input.desiredName);
		try {
			const r = await db.query<InsertedAsset>(
				`INSERT INTO assets (id, team_id, project_id, content_type, byte_size, sha256, original_filename, uploaded_by_member_id)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
				 RETURNING id, content_type, byte_size, original_filename`,
				[
					input.assetId,
					input.teamId,
					input.projectId,
					input.contentType,
					input.byteSize,
					input.sha256,
					name,
					input.uploadedByMemberId,
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
 * Insert an asset under an exact filename, or overwrite the row if one already
 * exists for that `(project_id, original_filename)`. Used by agent-authored
 * assets (e.g. an iterated HTML mockup) so the reference stays stable at
 * `assets/<filename>` instead of accreting random suffixes on each re-save. The
 * caller writes the new blob keyed by `assetId`; on overwrite the previous
 * `assetId`'s blob is orphaned and should be cleaned up by the caller.
 */
export async function upsertProjectAsset(
	db: PGlite,
	input: InsertAssetInput,
): Promise<InsertedAsset & { replacedAssetId: string | null }> {
	const existing = await db.query<{ id: string }>(
		'SELECT id FROM assets WHERE project_id = $1 AND original_filename = $2 LIMIT 1',
		[input.projectId, input.desiredName],
	);
	const prior = existing.rows[0]?.id ?? null;
	if (prior) {
		const r = await db.query<InsertedAsset>(
			`UPDATE assets
			 SET id = $1, content_type = $2, byte_size = $3, sha256 = $4,
			     uploaded_by_member_id = $5, created_at = now()
			 WHERE project_id = $6 AND original_filename = $7
			 RETURNING id, content_type, byte_size, original_filename`,
			[
				input.assetId,
				input.contentType,
				input.byteSize,
				input.sha256,
				input.uploadedByMemberId,
				input.projectId,
				input.desiredName,
			],
		);
		return { ...r.rows[0], replacedAssetId: prior };
	}
	const r = await db.query<InsertedAsset>(
		`INSERT INTO assets (id, team_id, project_id, content_type, byte_size, sha256, original_filename, uploaded_by_member_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 RETURNING id, content_type, byte_size, original_filename`,
		[
			input.assetId,
			input.teamId,
			input.projectId,
			input.contentType,
			input.byteSize,
			input.sha256,
			input.desiredName,
			input.uploadedByMemberId,
		],
	);
	return { ...r.rows[0], replacedAssetId: null };
}
