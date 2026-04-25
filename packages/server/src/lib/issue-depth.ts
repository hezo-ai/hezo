import type { PGlite } from '@electric-sql/pglite';

export const MAX_SUB_ISSUE_DEPTH = 2;

export const SUB_ISSUE_DEPTH_ERROR = `Sub-issues cannot be nested more than ${MAX_SUB_ISSUE_DEPTH} levels deep`;

export type DepthCheck = { ok: true } | { ok: false; message: string };

export async function assertChildDepthAllowed(
	db: PGlite,
	companyId: string,
	parentIssueId: string,
): Promise<DepthCheck> {
	const r = await db.query<{ id: string; grand_parent_id: string | null }>(
		`SELECT p.id, gp.parent_issue_id AS grand_parent_id
		 FROM issues p
		 LEFT JOIN issues gp ON gp.id = p.parent_issue_id
		 WHERE p.id = $1 AND p.company_id = $2`,
		[parentIssueId, companyId],
	);
	if (r.rows.length === 0) {
		return { ok: false, message: 'Parent issue not found' };
	}
	if (r.rows[0].grand_parent_id !== null) {
		return { ok: false, message: SUB_ISSUE_DEPTH_ERROR };
	}
	return { ok: true };
}
