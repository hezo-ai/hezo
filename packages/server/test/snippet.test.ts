import { HIGHLIGHT_SENTINEL } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { buildHighlightedSnippet } from '../src/lib/snippet';

const S = HIGHLIGHT_SENTINEL;

/** The user-visible text: matched markers and ellipses stripped. */
function visible(snippet: string): string {
	return snippet.split(S).join('').replace(/…/g, '');
}

/** Count of highlighted spans (each wrapped in a pair of sentinels). */
function highlightCount(snippet: string): number {
	const sentinels = snippet.split(S).length - 1;
	return sentinels / 2;
}

describe('buildHighlightedSnippet', () => {
	it('centers a window on a mid-text match and highlights the term', () => {
		const text = `${'Lorem ipsum dolor sit amet '.repeat(5)}configure the webhook retry ${'consectetur adipiscing elit '.repeat(5)}`;
		const { snippet, matched } = buildHighlightedSnippet(text, 'webhook');

		expect(matched).toBe(true);
		expect(snippet).toContain(`${S}webhook${S}`);
		expect(snippet.startsWith('…')).toBe(true); // context trimmed on the left
		expect(snippet.endsWith('…')).toBe(true); // ...and the right
		expect(visible(snippet).length).toBeLessThanOrEqual(200);
	});

	it('falls back to the lead text with no markers when nothing matches', () => {
		const { snippet, matched } = buildHighlightedSnippet('the quick brown fox', 'zzz');
		expect(matched).toBe(false);
		expect(snippet).toBe('the quick brown fox');
		expect(snippet).not.toContain(S);
	});

	it('truncates the lead-text fallback with an ellipsis', () => {
		const text = 'word '.repeat(100); // 500 chars, no match
		const { snippet, matched } = buildHighlightedSnippet(text, 'zzz');
		expect(matched).toBe(false);
		expect(snippet).not.toContain(S);
		expect(snippet.endsWith('…')).toBe(true);
		expect(visible(snippet).length).toBeLessThanOrEqual(200);
	});

	it('highlights every present term in a multi-word query', () => {
		const { snippet, matched } = buildHighlightedSnippet(
			'please retry the webhook now',
			'retry webhook',
		);
		expect(matched).toBe(true);
		expect(snippet).toContain(`${S}retry${S}`);
		expect(snippet).toContain(`${S}webhook${S}`);
	});

	it('skips query terms that are absent', () => {
		const { snippet, matched } = buildHighlightedSnippet('please retry now', 'retry missingword');
		expect(matched).toBe(true);
		expect(snippet).toContain(`${S}retry${S}`);
		expect(snippet).not.toContain('missingword');
	});

	it('omits the leading ellipsis when the match is at the start', () => {
		const text = `webhook ${'alpha beta gamma '.repeat(20)}`;
		const { snippet } = buildHighlightedSnippet(text, 'webhook');
		expect(snippet.startsWith('…')).toBe(false);
		expect(snippet.startsWith(`${S}webhook${S}`)).toBe(true);
		expect(snippet.endsWith('…')).toBe(true);
	});

	it('omits the trailing ellipsis when the match is at the end', () => {
		const text = `${'alpha beta gamma '.repeat(20)}finalword`;
		const { snippet } = buildHighlightedSnippet(text, 'finalword');
		expect(snippet.startsWith('…')).toBe(true);
		expect(snippet.endsWith('…')).toBe(false);
		expect(snippet.endsWith(`${S}finalword${S}`)).toBe(true);
	});

	it('matches case-insensitively but preserves the source casing', () => {
		const { snippet } = buildHighlightedSnippet('Open the Login Page now', 'login');
		expect(snippet).toContain(`${S}Login${S}`);
	});

	it('matches morphological variants via stemming (marking → marked)', () => {
		const { snippet, matched } = buildHighlightedSnippet('we marked it done', 'marking');
		expect(matched).toBe(true);
		expect(snippet).toContain(`${S}mark${S}`);
	});

	it('matches a longer word from a shorter query term (mark → marking)', () => {
		const { snippet, matched } = buildHighlightedSnippet('marking tasks complete', 'mark');
		expect(matched).toBe(true);
		expect(snippet).toContain(`${S}mark${S}`);
	});

	it('strips markdown syntax so highlights land on words, not markup', () => {
		const text = '## Deploy guide\n\nSee [the deploy doc](/x) for `deploy` steps';
		const { snippet } = buildHighlightedSnippet(text, 'deploy');
		expect(snippet).toContain(`${S}Deploy${S}`);
		expect(snippet).not.toContain('#');
		expect(snippet).not.toContain('`');
		expect(snippet).not.toContain('](');
	});

	it('caps the number of highlighted occurrences', () => {
		const { snippet } = buildHighlightedSnippet('spam '.repeat(80), 'spam');
		expect(highlightCount(snippet)).toBeLessThanOrEqual(8);
	});

	it('requires a word boundary for very short (≤2 char) terms', () => {
		// "to" should not light up "today"/"stop"; it should match the standalone word.
		const { snippet, matched } = buildHighlightedSnippet('today we stop to rest', 'to');
		expect(matched).toBe(true);
		expect(snippet).toContain(`${S}to${S}`);
		expect(snippet).not.toContain(`${S}to${S}day`);
	});

	it('returns empty for null/blank input', () => {
		expect(buildHighlightedSnippet(null, 'x')).toEqual({ snippet: '', matched: false });
		expect(buildHighlightedSnippet('   ', 'x')).toEqual({ snippet: '', matched: false });
	});

	it('never emits a stray sentinel from sentinel-bearing source (defensive)', () => {
		const { snippet } = buildHighlightedSnippet(`a${S}b nothing here`, 'zzz');
		expect(snippet).not.toContain(S);
	});
});
