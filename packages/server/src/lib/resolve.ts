import type { PGlite } from '@electric-sql/pglite';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveCompanyId(db: PGlite, raw: string): Promise<string | null> {
	if (UUID_RE.test(raw)) return raw;
	const result = await db.query<{ id: string }>('SELECT id FROM companies WHERE slug = $1', [raw]);
	return result.rows[0]?.id ?? null;
}

export async function resolveProjectId(
	db: PGlite,
	companyId: string,
	raw: string,
): Promise<string | null> {
	if (UUID_RE.test(raw)) return raw;
	const result = await db.query<{ id: string }>(
		'SELECT id FROM projects WHERE company_id = $1 AND slug = $2',
		[companyId, raw],
	);
	return result.rows[0]?.id ?? null;
}

export async function resolveIssueId(
	db: PGlite,
	companyId: string,
	raw: string,
): Promise<string | null> {
	if (UUID_RE.test(raw)) return raw;
	const result = await db.query<{ id: string }>(
		'SELECT id FROM issues WHERE company_id = $1 AND LOWER(identifier) = LOWER($2)',
		[companyId, raw],
	);
	return result.rows[0]?.id ?? null;
}

export interface ProjectLocator {
	id: string;
	slug: string;
	companyId: string;
	companySlug: string;
}

export async function getProjectLocator(
	db: PGlite,
	projectId: string,
): Promise<ProjectLocator | null> {
	const result = await db.query<{
		id: string;
		slug: string;
		company_id: string;
		company_slug: string;
	}>(
		`SELECT p.id, p.slug, p.company_id, c.slug AS company_slug
		 FROM projects p JOIN companies c ON c.id = p.company_id
		 WHERE p.id = $1`,
		[projectId],
	);
	const row = result.rows[0];
	if (!row) return null;
	return {
		id: row.id,
		slug: row.slug,
		companyId: row.company_id,
		companySlug: row.company_slug,
	};
}
