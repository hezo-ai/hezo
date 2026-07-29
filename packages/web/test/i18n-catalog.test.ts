// Drift guard for the generated message catalogs. The English file is the
// source of truth; every other language is generated from it, so the failure
// mode this catches is a key added to en.json without regenerating - which
// would silently render English inside an otherwise translated screen.
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
