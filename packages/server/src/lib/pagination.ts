import type { Context } from 'hono';

const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 200;

export function parsePagination(c: Context) {
	const page = Math.max(1, Number(c.req.query('page')) || 1);
	const perPage = Math.min(
		MAX_PER_PAGE,
		Math.max(1, Number(c.req.query('per_page')) || DEFAULT_PER_PAGE),
	);
	const offset = (page - 1) * perPage;
	return { page, perPage, offset };
}

export function buildMeta(page: number, perPage: number, total: number) {
	return { page, per_page: perPage, total };
}
