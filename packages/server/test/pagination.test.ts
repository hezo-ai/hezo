import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
	buildCursorPage,
	buildMeta,
	encodeCursor,
	parseCursorPagination,
	parsePagination,
} from '../src/lib/pagination';

// Both parsers read their inputs off a Hono Context, so drive them through a
// real one rather than re-deriving the arithmetic here - a local copy of the
// logic passes happily while the shipped function drifts away from it.
async function withQuery<T>(
	read: (c: Parameters<typeof parsePagination>[0]) => T,
	query: string,
): Promise<T> {
	const app = new Hono();
	let captured: T | undefined;
	app.get('/', (c) => {
		captured = read(c);
		return c.body(null, 204);
	});
	await app.request(`/${query}`);
	return captured as T;
}

const parse = (query = '') => withQuery(parsePagination, query);
const parseCursor = (query = '') => withQuery(parseCursorPagination, query);

describe('parsePagination', () => {
	it('returns defaults when no params', async () => {
		expect(await parse()).toEqual({ page: 1, perPage: 50, offset: 0 });
	});

	it('parses valid page and per_page', async () => {
		expect(await parse('?page=3&per_page=20')).toEqual({ page: 3, perPage: 20, offset: 40 });
	});

	it('clamps page to minimum 1', async () => {
		const result = await parse('?page=0');
		expect(result.page).toBe(1);
		expect(result.offset).toBe(0);
	});

	it('clamps negative page to 1', async () => {
		expect((await parse('?page=-5')).page).toBe(1);
	});

	it('uses default per_page when 0 is passed (falsy)', async () => {
		expect((await parse('?page=1&per_page=0')).perPage).toBe(50);
	});

	it('clamps per_page to maximum 200', async () => {
		expect((await parse('?page=1&per_page=500')).perPage).toBe(200);
	});

	it('handles NaN page gracefully', async () => {
		expect((await parse('?page=abc')).page).toBe(1);
	});

	it('handles NaN per_page gracefully', async () => {
		expect((await parse('?page=1&per_page=xyz')).perPage).toBe(50);
	});

	it('calculates correct offset for page 2 with per_page 25', async () => {
		expect((await parse('?page=2&per_page=25')).offset).toBe(25);
	});
});

describe('buildMeta', () => {
	it('returns correct metadata', () => {
		expect(buildMeta(1, 50, 100)).toEqual({ page: 1, per_page: 50, total: 100 });
	});

	it('handles zero total', () => {
		expect(buildMeta(1, 50, 0)).toEqual({ page: 1, per_page: 50, total: 0 });
	});

	it('handles large page numbers', () => {
		expect(buildMeta(100, 10, 5)).toEqual({ page: 100, per_page: 10, total: 5 });
	});
});

describe('parseCursorPagination', () => {
	const ID = '11111111-2222-3333-4444-555555555555';
	const AT = '2026-01-02T03:04:05.678Z';

	it('defaults to the first page with no cursor', async () => {
		expect(await parseCursor()).toEqual({ limit: 50, cursor: null, invalidCursor: false });
	});

	it('clamps the limit to the same bounds as offset pagination', async () => {
		expect((await parseCursor('?limit=500')).limit).toBe(200);
		expect((await parseCursor('?limit=0')).limit).toBe(50);
		expect((await parseCursor('?limit=nope')).limit).toBe(50);
	});

	it('round-trips an encoded cursor', async () => {
		const result = await parseCursor(`?cursor=${encodeURIComponent(encodeCursor(AT, ID))}`);
		expect(result.cursor).toEqual({ value: AT, id: ID });
		expect(result.invalidCursor).toBe(false);
	});

	it('splits on the last separator so a value containing one survives', async () => {
		// Not a shape the audit feed emits, but the separator must not be able to
		// silently re-point the seek at a different row if a future feed's sort
		// value carries one.
		const result = await parseCursor(`?cursor=${encodeURIComponent(`a|${AT}|${ID}`)}`);
		expect(result.cursor).toBeNull();
		expect(result.invalidCursor).toBe(true);
	});

	it.each([
		['no separator', 'garbage'],
		['empty value', `|${ID}`],
		['empty id', `${AT}|`],
		['non-uuid id', `${AT}|not-a-uuid`],
		['non-timestamp value', `nope|${ID}`],
	])('flags a malformed cursor (%s) rather than falling back to page 1', async (_label, raw) => {
		// Falling back would replay rows the client already rendered, and both
		// halves land in a typed SQL comparison that would otherwise 500 on a cast.
		const result = await parseCursor(`?cursor=${encodeURIComponent(raw)}`);
		expect(result.cursor).toBeNull();
		expect(result.invalidCursor).toBe(true);
	});
});

describe('buildCursorPage', () => {
	const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));
	const toCursor = (row: { id: string }) => row.id;

	it('trims the over-fetched row and reports more', () => {
		// The caller asks for limit + 1; the extra row is the has_more signal, not data.
		const page = buildCursorPage(rows(4), 3, toCursor);
		expect(page.data.map((r) => r.id)).toEqual(['r0', 'r1', 'r2']);
		expect(page.meta).toEqual({ has_more: true, next_cursor: 'r2' });
	});

	it('reports the end of the feed when the over-fetch came back short', () => {
		const page = buildCursorPage(rows(3), 3, toCursor);
		expect(page.data.length).toBe(3);
		expect(page.meta).toEqual({ has_more: false, next_cursor: null });
	});

	it('handles an empty page', () => {
		expect(buildCursorPage([], 3, toCursor).meta).toEqual({
			has_more: false,
			next_cursor: null,
		});
	});
});
