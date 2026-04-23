import type { PGlite } from '@electric-sql/pglite';

export interface AllocatedIdentifier {
	number: number;
	identifier: string;
}

export async function allocateIssueIdentifier(
	db: PGlite,
	projectId: string,
): Promise<AllocatedIdentifier> {
	const result = await db.query<{ issue_prefix: string; number: number }>(
		`SELECT p.issue_prefix, next_project_issue_number(p.id) AS number
		 FROM projects p WHERE p.id = $1`,
		[projectId],
	);
	const row = result.rows[0];
	if (!row) throw new Error(`allocateIssueIdentifier: project ${projectId} not found`);
	return { number: row.number, identifier: `${row.issue_prefix}-${row.number}` };
}
