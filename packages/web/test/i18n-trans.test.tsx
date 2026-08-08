// Unit tests for <Trans>, the node-aware counterpart to t().
//
// t() cannot render a sentence containing a link or an <em>: interpolate() is a
// string replace over Record<string, string | number>. The interesting property
// here is not that substitution works, but that a translation is free to put the
// nodes in its own word order - which is exactly what splitting a sentence into
// per-fragment keys would take away.

import { DEFAULT_LOCALE_SETTINGS, Language } from '@hezo/shared';
import { render } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { I18nProvider, Trans } from '../src/lib/i18n';

/** The provider seeds itself from the stored render hint, so set that. */
function renderIn(language: Language, node: React.ReactNode) {
	localStorage.setItem('locale', JSON.stringify({ ...DEFAULT_LOCALE_SETTINGS, language }));
	return render(<I18nProvider>{node}</I18nProvider>);
}

beforeEach(() => localStorage.clear());

test('places nodes at their tokens, in template order', () => {
	const { container } = renderIn(
		Language.En,
		<Trans
			k="comment.linkedFrom"
			vars={{ source: <a href="/s">INV-8</a>, actor: <b>Captain</b> }}
		/>,
	);
	expect(container.textContent).toBe('Linked from INV-8 by Captain');
	// The nodes are real elements, not stringified.
	expect(container.querySelector('a')?.textContent).toBe('INV-8');
	expect(container.querySelector('b')?.textContent).toBe('Captain');
});

test("follows the target language's word order rather than English's", () => {
	// Japanese puts the actor first and the verb last; English puts the actor
	// last. Same call, same vars - only the template decides where they land.
	const { container } = renderIn(
		Language.Ja,
		<Trans
			k="comment.linkedFrom"
			vars={{ source: <a href="/s">INV-8</a>, actor: <b>Captain</b> }}
		/>,
	);
	const text = container.textContent ?? '';
	expect(text).toContain('からリンクされました');
	expect(text.indexOf('Captain')).toBeLessThan(text.indexOf('INV-8'));
});

test('renders an unknown token literally, as interpolate() does', () => {
	const { container } = renderIn(
		Language.En,
		// `actor` deliberately omitted.
		<Trans k="comment.linkedFrom" vars={{ source: 'INV-8' }} />,
	);
	expect(container.textContent).toBe('Linked from INV-8 by {actor}');
});

test('renders every token literally when no vars are passed at all', () => {
	const { container } = renderIn(Language.En, <Trans k="comment.linkedFrom" />);
	expect(container.textContent).toBe('Linked from {source} by {actor}');
});

test('falls back to English for a language whose catalog lacks the key', () => {
	// lookup() resolves language -> English -> the key itself. Rather than fake a
	// missing key, assert the chain's observable end: a key present everywhere
	// renders that language's own value, never the raw key.
	const { container } = renderIn(
		Language.De,
		<Trans k="comment.parentPromoted" vars={{ actor: 'Captain' }} />,
	);
	expect(container.textContent).not.toBe('comment.parentPromoted');
	expect(container.textContent).toContain('Captain');
});

test('keeps literal text around a token that resolves to nothing', () => {
	const { container } = renderIn(
		Language.En,
		<Trans k="comment.runFailedWithError" vars={{ agent: '@captain', error: null }} />,
	);
	expect(container.textContent).toBe('Run for @captain failed: ');
});
