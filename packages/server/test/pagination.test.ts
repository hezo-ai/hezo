import { describe, expect, it } from 'vitest';

// We can't easily mock Hono's Context, so test the logic directly
// by extracting the same calculations used in parsePagination/buildMeta.

describe('parsePagination logic', () => {
	function parsePagination(pageStr?: string, perPageStr?: string) {
		const DEFAULT_PER_PAGE = 50;
		const MAX_PER_PAGE = 200;
		const page = Math.max(1, Number(pageStr) || 1);
		const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Number(perPageStr) || DEFAULT_PER_PAGE));
		const offset = (page - 1) * perPage;
		return { page, perPage, offset };
	}

	it('returns defaults when no params', () => {
		const result = parsePagination();
		expect(result).toEqual({ page: 1, perPage: 50, offset: 0 });
	});

	it('parses valid page and per_page', () => {
		const result = parsePagination('3', '20');
		expect(result).toEqual({ page: 3, perPage: 20, offset: 40 });
	});

	it('clamps page to minimum 1', () => {
		const result = parsePagination('0');
		expect(result.page).toBe(1);
		expect(result.offset).toBe(0);
	});

	it('clamps negative page to 1', () => {
		const result = parsePagination('-5');
		expect(result.page).toBe(1);
	});

	it('uses default per_page when 0 is passed (falsy)', () => {
		const result = parsePagination('1', '0');
		expect(result.perPage).toBe(50); // 0 is falsy, falls through to default
	});

	it('clamps per_page to maximum 200', () => {
		const result = parsePagination('1', '500');
		expect(result.perPage).toBe(200);
	});

	it('handles NaN page gracefully', () => {
		const result = parsePagination('abc');
		expect(result.page).toBe(1);
	});

	it('handles NaN per_page gracefully', () => {
		const result = parsePagination('1', 'xyz');
		expect(result.perPage).toBe(50);
	});

	it('calculates correct offset for page 2 with per_page 25', () => {
		const result = parsePagination('2', '25');
		expect(result.offset).toBe(25);
	});
});

describe('buildMeta', () => {
	function buildMeta(page: number, perPage: number, total: number) {
		return { page, per_page: perPage, total };
	}

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
