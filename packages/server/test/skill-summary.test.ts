import { describe, expect, it } from 'vitest';
import { deriveSkillSummary } from '../src/lib/skill-summary';

describe('deriveSkillSummary', () => {
	it('returns the first prose line, skipping blanks and the H1 title', () => {
		const content = '# Deploy Skill\n\nThis deploys the app to production.';
		expect(deriveSkillSummary(content)).toBe('This deploys the app to production.');
	});

	it('strips inline markdown (code, bold, italic, links, list markers)', () => {
		const content = '- Use `kubectl` and **helm** with [docs](https://x) and *care*';
		expect(deriveSkillSummary(content)).toBe('Use kubectl and helm with docs and care');
	});

	it('falls back to the heading text when there is no prose line', () => {
		expect(deriveSkillSummary('## Only A `Heading`')).toBe('Only A Heading');
	});

	it('returns an empty string for empty or whitespace-only content', () => {
		expect(deriveSkillSummary('')).toBe('');
		expect(deriveSkillSummary('\n\n   \n')).toBe('');
	});

	it('truncates very long summaries with an ellipsis', () => {
		const summary = deriveSkillSummary('x'.repeat(500));
		expect(summary.length).toBe(200);
		expect(summary.endsWith('…')).toBe(true);
	});

	it('keeps summaries at or below the limit intact', () => {
		const text = 'short summary';
		expect(deriveSkillSummary(text)).toBe(text);
	});
});
