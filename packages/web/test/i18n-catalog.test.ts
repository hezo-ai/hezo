// Drift guard for the message catalogs. The English file is the source of
// truth; every other language is *hand-authored* against it, so the failure
// mode this catches is a key added to en.json and then copy-pasted unchanged
// into the others - which silently renders English inside an otherwise
// translated screen, and which `value !== key` would happily pass.
import { LANGUAGES } from '@hezo/shared';
import { describe, expect, test } from 'vitest';
import en from '../src/lib/i18n/catalog/en.json';
import { CATALOGS } from '../src/lib/i18n/catalogs';

const EN_KEYS = Object.keys(en).sort();

describe('message catalogs', () => {
	test('ships a catalog for every supported language', () => {
		for (const language of LANGUAGES) {
			expect(CATALOGS[language], `no catalog for ${language}`).toBeTruthy();
		}
		expect(Object.keys(CATALOGS)).toHaveLength(LANGUAGES.length);
	});

	test('every catalog has exactly the English key set', () => {
		for (const language of LANGUAGES) {
			const catalog = CATALOGS[language];
			expect(Object.keys(catalog ?? {}).sort(), `key drift in ${language}`).toEqual(EN_KEYS);
		}
	});

	test('no message is empty or left as its own key', () => {
		for (const language of LANGUAGES) {
			for (const [key, value] of Object.entries(CATALOGS[language] ?? {})) {
				expect(value.trim(), `${language}.${key} is empty`).not.toBe('');
				expect(value, `${language}.${key} was not translated`).not.toBe(key);
			}
		}
	});

	test('no message contains an em or en dash', () => {
		// AGENTS.md bans both in user-facing strings; a translator (human or
		// machine) will reintroduce them unless something checks.
		for (const language of LANGUAGES) {
			for (const [key, value] of Object.entries(CATALOGS[language] ?? {})) {
				expect(value, `${language}.${key} contains an em/en dash`).not.toMatch(/[—–]/);
			}
		}
	});

	test('no message says "ticket" - the work item is a task', () => {
		for (const language of LANGUAGES) {
			for (const [key, value] of Object.entries(CATALOGS[language] ?? {})) {
				expect(value.toLowerCase(), `${language}.${key} says "ticket"`).not.toContain('ticket');
			}
		}
	});

	test('the product name is never translated away', () => {
		// "Hezo" is a proper noun; a machine pass will happily localize it.
		for (const language of LANGUAGES) {
			const catalog = CATALOGS[language] ?? {};
			expect(catalog['setup.welcome'], `${language} lost the product name`).toContain('Hezo');
		}
	});

	/**
	 * Keys whose translation legitimately equals the English, per language.
	 *
	 * Every entry is a deliberate claim that the two really are the same word -
	 * "Budget" genuinely is German, French, Italian, Dutch and Swedish for
	 * budget; "Password" is the ordinary Italian term. Adding an entry to shut
	 * the test up is the failure this exists to prevent, so keep it short and
	 * keep the reason obvious.
	 */
	const IDENTICAL_TO_ENGLISH_OK: Record<string, readonly string[]> = {
		'nav.budget': ['de', 'fr', 'it', 'nl', 'sv'],
		'nav.agents': ['fr', 'nl'],
		'nav.documents': ['fr'],
		'nav.home': ['it'],
		'theme.system': ['de', 'sv'],
		'settings.general': ['es'],
		'settings.chatbox': ['de'],
		'setup.step.password': ['it'],
	};

	test('no message was left identical to the English source', () => {
		// The catalogs are hand-authored, so the realistic mistake is copying
		// en.json across and translating only some of it. `value !== key` does not
		// catch that; this does. It is how settings.skills was found sitting
		// untranslated in all eleven languages.
		for (const language of LANGUAGES) {
			if (language === 'en') continue;
			for (const key of EN_KEYS) {
				const source = (en as Record<string, string>)[key];
				const translated = (CATALOGS[language] ?? {})[key];
				if (translated !== source) continue;
				expect(
					IDENTICAL_TO_ENGLISH_OK[key] ?? [],
					`${language}.${key} is still the English string ("${source}") - translate it, or add it to IDENTICAL_TO_ENGLISH_OK with a reason`,
				).toContain(language);
			}
		}
	});

	test('the identical-to-English allowlist has no stale entries', () => {
		// An allowlist entry that no longer applies is a claim nobody checked.
		for (const [key, languages] of Object.entries(IDENTICAL_TO_ENGLISH_OK)) {
			expect(EN_KEYS, `allowlist names unknown key ${key}`).toContain(key);
			for (const language of languages) {
				const source = (en as Record<string, string>)[key];
				const translated = (CATALOGS[language as (typeof LANGUAGES)[number]] ?? {})[key];
				expect(
					translated,
					`${language}.${key} no longer matches English - drop it from IDENTICAL_TO_ENGLISH_OK`,
				).toBe(source);
			}
		}
	});

	test('placeholder tokens survive translation', () => {
		// A translated `{count}` that became `{compte}` would render literally.
		const tokensOf = (value: string) => (value.match(/\{(\w+)\}/g) ?? []).sort();
		for (const language of LANGUAGES) {
			for (const key of EN_KEYS) {
				const source = (en as Record<string, string>)[key];
				const translated = (CATALOGS[language] ?? {})[key];
				expect(tokensOf(translated ?? ''), `${language}.${key} placeholder drift`).toEqual(
					tokensOf(source),
				);
			}
		}
	});
});
