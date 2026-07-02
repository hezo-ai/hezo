import { describe, expect, it } from 'vitest';
import {
	CAPTAIN_AGENT_SLUG,
	CEO_AGENT_SLUG,
	COACH_AGENT_SLUG,
	FIXED_REPORTS_TO_SLUGS,
	hasFixedReportsTo,
} from '../src/constants';

describe('hasFixedReportsTo', () => {
	it('is true for the structurally-fixed roles (captain, ceo, coach)', () => {
		expect(hasFixedReportsTo(CAPTAIN_AGENT_SLUG)).toBe(true);
		expect(hasFixedReportsTo(CEO_AGENT_SLUG)).toBe(true);
		expect(hasFixedReportsTo(COACH_AGENT_SLUG)).toBe(true);
	});

	it('is false for ordinary worker roles', () => {
		for (const slug of ['engineer', 'architect', 'product-lead', 'qa', 'devops', '']) {
			expect(hasFixedReportsTo(slug)).toBe(false);
		}
	});

	it('FIXED_REPORTS_TO_SLUGS lists exactly captain, ceo, coach', () => {
		expect([...FIXED_REPORTS_TO_SLUGS].sort()).toEqual(
			[CAPTAIN_AGENT_SLUG, CEO_AGENT_SLUG, COACH_AGENT_SLUG].sort(),
		);
	});
});
