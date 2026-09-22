import { Language } from '@hezo/shared';
import { expect, test } from 'vitest';
import type { SystemContent } from '../src/components/comment-content';
import { CATALOGS } from '../src/lib/i18n/catalogs';
import { inboxRowSnippet } from '../src/lib/inbox-row-kind';
import { type NoticeTextLocale, systemNoticeText } from '../src/lib/system-notice-text';

/** A reader's locale built straight from a catalog, as the provider builds it. */
function localeFor(language: Language): NoticeTextLocale {
	const catalog = CATALOGS[language] as Record<string, string>;
	return {
		language,
		formatNumber: (value) => value.toLocaleString(language),
		t: (key, vars) =>
			(catalog[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? '')),
	};
}

test('a handoff-limit notice reads in the reader language, with the agents joined by its list rules', () => {
	const text = systemNoticeText(
		{ kind: 'handoff_limit', rounds: 8, tokens: 2_500_000, agent_slugs: ['architect', 'engineer'] },
		localeFor(Language.De),
	);
	expect(text).toBe(
		'@architect und @engineer haben diese Aufgabe 8 Mal hintereinander weitergereicht und dabei 2.500.000 Token verbraucht. Kein Agent arbeitet daran weiter, bis der Admin antwortet.',
	);
});

test('a budget-pause notice picks the sentence for whose budget and which window', () => {
	const text = systemNoticeText(
		{
			kind: 'budget_paused',
			scope: 'project',
			period: 'weekly',
			agent_slug: 'engineer',
			limit_tokens: 1_000_000,
			used_tokens: 1_200_000,
		},
		localeFor(Language.En),
	);
	expect(text).toBe(
		"@engineer is paused: the project's weekly budget of 1,000,000 tokens is used up (1,200,000 used). Raise the budget to let it run again before the week ends.",
	);
});

test('a conversion notice reads as its opening sentence, by where its rate came from', () => {
	const text = systemNoticeText(
		{ kind: 'budget_conversion', tokens_per_cent: 10_000, basis: 'fallback' },
		localeFor(Language.En),
	);
	expect(text).toContain('converted at 1,000,000 tokens per dollar');
	expect(text).toContain('no priced runs in the last 30 days');
});

test('any other system comment has no notice text, so the row keeps its own words', () => {
	const locale = localeFor(Language.En);
	expect(systemNoticeText({ kind: 'status_change' } as SystemContent, locale)).toBeNull();
	expect(inboxRowSnippet({ snippet: 'Please weigh in.', notice: null }, locale)).toBe(
		'Please weigh in.',
	);
	expect(
		inboxRowSnippet({ snippet: 'English fallback', notice: { kind: 'title_change' } }, locale),
	).toBe('English fallback');
});
