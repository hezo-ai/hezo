import { describe, expect, it } from 'vitest';
import {
	type AvatarSpec,
	isAvatarSpec,
	makeAvatarSpec,
	pixelAvatarDataUri,
	pixelAvatarSvg,
	styleForRole,
} from '../src/avatar/pixel-avatar';

const spec = (over: Partial<AvatarSpec> = {}): AvatarSpec => ({
	seed: 'max',
	gender: 'm',
	style: 'engineering',
	...over,
});

describe('styleForRole', () => {
	it('maps engineering-family roles', () => {
		expect(styleForRole('engineer', 'Engineer')).toBe('engineering');
		expect(styleForRole('qa-engineer', 'QA Engineer')).toBe('engineering');
		expect(styleForRole('architect', 'Architect')).toBe('engineering');
	});

	it('prefers the more specific family over the broad engineer match', () => {
		// Both contain "engineer"; the specific matcher must win.
		expect(styleForRole('security-engineer', 'Security Engineer')).toBe('security');
		expect(styleForRole('devops-engineer', 'DevOps Engineer')).toBe('ops');
	});

	it('maps the remaining role families', () => {
		expect(styleForRole('captain', 'Captain')).toBe('captain');
		expect(styleForRole('content-writer', 'Content Writer')).toBe('writer');
		expect(styleForRole('ui-designer', 'UI Designer')).toBe('design');
		expect(styleForRole('equity-analyst', 'Equity Analyst')).toBe('research');
		expect(styleForRole('distribution-manager', 'Distribution Manager')).toBe('marketing');
		expect(styleForRole('support-specialist', 'Support Specialist')).toBe('support');
		expect(styleForRole('product-lead', 'Product Lead')).toBe('lead');
	});

	it('falls back to the default family for an unrecognised role', () => {
		expect(styleForRole('llama-wrangler', 'Llama Wrangler')).toBe('default');
	});
});

describe('makeAvatarSpec', () => {
	it('carries the seed and gender and derives the style from the role', () => {
		expect(
			makeAvatarSpec({ seed: 's', gender: 'f', roleSlug: 'ui-designer', roleTitle: 'UI Designer' }),
		).toEqual({ seed: 's', gender: 'f', style: 'design' });
	});
});

describe('pixelAvatarSvg', () => {
	it('is deterministic for the same spec', () => {
		expect(pixelAvatarSvg(spec())).toBe(pixelAvatarSvg(spec()));
	});

	it('produces different sprites for different seeds', () => {
		expect(pixelAvatarSvg(spec({ seed: 'a' }))).not.toBe(pixelAvatarSvg(spec({ seed: 'b' })));
	});

	it('produces different sprites for different genders', () => {
		expect(pixelAvatarSvg(spec({ gender: 'f' }))).not.toBe(pixelAvatarSvg(spec({ gender: 'm' })));
	});

	it('produces different sprites for different role styles', () => {
		expect(pixelAvatarSvg(spec({ style: 'captain' }))).not.toBe(
			pixelAvatarSvg(spec({ style: 'support' })),
		);
	});

	it('resolves a neutral gender to a stable concrete face', () => {
		const first = pixelAvatarSvg(spec({ gender: 'n' }));
		expect(pixelAvatarSvg(spec({ gender: 'n' }))).toBe(first);
	});

	it('renders a crisp-edged 24x24 svg with no external references', () => {
		const svg = pixelAvatarSvg(spec());
		expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"')).toBe(
			true,
		);
		expect(svg).toContain('shape-rendering="crispEdges"');
		expect(svg.endsWith('</svg>')).toBe(true);
		// Self-contained: rects only. No external image, font or stylesheet
		// reference, which a strict CSP would block anyway.
		expect(svg).not.toContain('<image');
		expect(svg).not.toContain('href');
		expect(svg.replace(/<svg[^>]*>|<\/svg>|<rect [^>]*\/>/g, '')).toBe('');
	});

	it('draws an outline so the bust reads at small sizes', () => {
		expect(pixelAvatarSvg(spec())).toContain('#12151c');
	});

	it('merges horizontal runs rather than emitting one rect per pixel', () => {
		const svg = pixelAvatarSvg(spec());
		const rects = svg.match(/<rect /g)?.length ?? 0;
		expect(rects).toBeGreaterThan(0);
		expect(rects).toBeLessThan(24 * 24);
	});

	it('gives the captain style its gold-trimmed hat', () => {
		// The captain hat + epaulettes are the one fully deterministic accessory.
		expect(pixelAvatarSvg(spec({ style: 'captain' }))).toContain('#e8b93c');
	});
});

describe('pixelAvatarDataUri', () => {
	it('returns a self-contained svg data uri', () => {
		const uri = pixelAvatarDataUri(spec());
		expect(uri.startsWith('data:image/svg+xml,')).toBe(true);
		expect(decodeURIComponent(uri.slice('data:image/svg+xml,'.length))).toBe(
			pixelAvatarSvg(spec()),
		);
	});

	it('is stable across repeat calls (memoized)', () => {
		expect(pixelAvatarDataUri(spec({ seed: 'memo' }))).toBe(
			pixelAvatarDataUri(spec({ seed: 'memo' })),
		);
	});
});

describe('isAvatarSpec', () => {
	it('accepts a well-formed spec', () => {
		expect(isAvatarSpec({ seed: 's', gender: 'f', style: 'design' })).toBe(true);
	});

	it('rejects malformed values from the db or an untrusted bundle', () => {
		expect(isAvatarSpec(null)).toBe(false);
		expect(isAvatarSpec('nope')).toBe(false);
		expect(isAvatarSpec({ seed: 's', style: 'design' })).toBe(false);
		expect(isAvatarSpec({ seed: 's', gender: 'x', style: 'design' })).toBe(false);
		expect(isAvatarSpec({ seed: 1, gender: 'f', style: 'design' })).toBe(false);
	});
});
