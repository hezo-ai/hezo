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
