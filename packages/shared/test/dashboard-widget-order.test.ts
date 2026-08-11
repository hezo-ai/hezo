import { describe, expect, it } from 'vitest';
import {
	DASHBOARD_WIDGET_IDS,
	DEFAULT_WIDGET_ORDER,
	sanitizeWidgetOrder,
} from '../src/types/project-dashboard';

describe('DEFAULT_WIDGET_ORDER', () => {
	it('covers every widget id exactly once', () => {
		expect([...DEFAULT_WIDGET_ORDER].sort()).toEqual([...DASHBOARD_WIDGET_IDS].sort());
	});

	it('leads with the work in flight', () => {
		expect(DEFAULT_WIDGET_ORDER).toEqual(['in_progress', 'team_snapshot', 'goals', 'spend']);
	});
});

describe('sanitizeWidgetOrder', () => {
	it('falls back to the default order when nothing is stored', () => {
		expect(sanitizeWidgetOrder(null)).toEqual(DEFAULT_WIDGET_ORDER);
		expect(sanitizeWidgetOrder(undefined)).toEqual(DEFAULT_WIDGET_ORDER);
	});

	it('returns a full stored order untouched', () => {
		// A saved order is a deliberate choice: reordering the default must never
		// re-sort a project whose owner already arranged it.
		const stored = ['spend', 'goals', 'team_snapshot', 'in_progress'];
		expect(sanitizeWidgetOrder(stored)).toEqual(stored);
	});

	it('appends the ids a partial order omits, keeping the stored prefix', () => {
		expect(sanitizeWidgetOrder(['spend'])).toEqual([
			'spend',
			'in_progress',
			'team_snapshot',
			'goals',
		]);
	});

	it('drops unknown ids and duplicates', () => {
		expect(sanitizeWidgetOrder(['goals', 'goals', 'nope', 'spend'])).toEqual([
			'goals',
			'spend',
			'in_progress',
			'team_snapshot',
		]);
	});

	it('ignores non-array and non-string input rather than throwing', () => {
		expect(sanitizeWidgetOrder('spend')).toEqual(DEFAULT_WIDGET_ORDER);
		expect(sanitizeWidgetOrder({ order: ['spend'] })).toEqual(DEFAULT_WIDGET_ORDER);
		expect(sanitizeWidgetOrder([1, null, 'spend'])).toEqual([
			'spend',
			'in_progress',
			'team_snapshot',
			'goals',
		]);
	});
});
