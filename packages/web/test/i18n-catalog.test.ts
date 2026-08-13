// Drift guard for the message catalogs. The English file is the source of
// truth; every other language is *hand-authored* against it, so the failure
// mode this catches is a key added to en.json and then copy-pasted unchanged
// into the others - which silently renders English inside an otherwise
// translated screen, and which `value !== key` would happily pass.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LANGUAGES } from '@hezo/shared';
import { describe, expect, test } from 'vitest';
import en from '../src/lib/i18n/catalog/en.json';
import { CATALOGS } from '../src/lib/i18n/catalogs';

const EN_KEYS = Object.keys(en).sort();

// cwd is the package dir under both documented invocations (`scripts/test.ts`
// runs vitest with `cwd: packages/web`, and a single file runs as
// `cd packages/web && bunx vitest run ...`). Deliberately not derived from
// `import.meta.url`: vite rewrites that to a `/@fs/...` URL that
// `fileURLToPath` rejects - the same hazard `vitest.config.ts` documents for
// the migrations dir.
const SRC_DIR = resolve(process.cwd(), 'src');
const CATALOG_DIR = resolve(SRC_DIR, 'lib/i18n/catalog');

/** `plural()` composes `key.one` / `key.other` from a stem at runtime. */
const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

/** Every dotted string literal in the app source, catalogs excluded. */
function collectKeyLiterals(): Set<string> {
	const literals = new Set<string>();
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (full !== CATALOG_DIR) walk(full);
				continue;
			}
			if (!/\.tsx?$/.test(entry.name)) continue;
			const text = readFileSync(full, 'utf8');
			for (const match of text.matchAll(/['"`]([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+)['"`]/g)) {
				literals.add(match[1]);
			}
		}
	};
	walk(SRC_DIR);
	return literals;
}

/** A catalog key counts as referenced directly, or as a `plural()` stem. */
function isReferenced(key: string, literals: Set<string>): boolean {
	if (literals.has(key)) return true;
	const lastDot = key.lastIndexOf('.');
	if (lastDot === -1) return false;
	return PLURAL_CATEGORIES.has(key.slice(lastDot + 1)) && literals.has(key.slice(0, lastDot));
}

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
		'nav.documents': ['fr'],
		'nav.home': ['it'],
		'theme.system': ['de', 'sv'],
		'settings.chatbox': ['de'],
		// "Chat" is the ordinary loanword in all five, article and all - der Chat,
		// el chat, la chat, de chat, o chat. French (Discussion), Polish (Czat) and
		// Swedish (Chatt) all differ, as `settings.chatbox` already records for de.
		'settings.chat': ['de', 'es', 'it', 'nl', 'pt-BR'],
		// Both catalogs already write "agent" for the singular throughout
		// (`agents.hire.action`), so the plural heading is the same word too.
		'settings.groups.agents': ['fr', 'nl'],
		// Spanish writes "General" identically - this entry moved here from
		// settings.general when that page became Instance.
		'settings.groups.general': ['es'],
		// French for both is the same word; every other language differs
		// (Wartung, Manutenzione, Instans, Instancja, ...).
		'settings.groups.maintenance': ['fr'],
		'settings.instance': ['fr'],
		'taskView.conversation': ['fr'],
		// Dutch really does write "containers" - the loanword, plural and all.
		// Every other language differs (Container, Conteneurs, Contêineres, ...).
		'settings.concurrency': ['nl'],
		'containers.tab.list': ['nl'],
		// The singular is the same loanword in these four; French and the rest
		// differ (Conteneur, Contêiner, Kontener, ...).
		'containers.column.container': ['de', 'it', 'nl', 'sv'],
		'containers.column.project': ['nl'],
		// Same word in Dutch, as `containers.column.project` above already records.
		'marketplace.projectLabel': ['nl'],
		// Spanish pluralises "rol" to "roles", spelt exactly like the English.
		// The singular differs ("1 rol"), and every other language does too
		// (Rollen, rôles, ruoli, papéis, ...).
		'marketplace.roleCountOther': ['es'],
		'containers.badge.assistant': ['fr'],
		'setup.step.password': ['it'],
		// German writes "Name" for a person's name, identically. Dutch (Naam),
		// Swedish (Namn) and the rest all differ.
		'agents.identity.nameLabel': ['de'],
		// "Audio" and "Video" are the same loanword in these languages, colon and
		// all - German, Spanish, Italian and Dutch all write Audio; German, Italian,
		// Dutch and Swedish all write Video. Anything else in the attachment
		// category list does differ (Bilder, Imágenes, Archiwa, Ljud, ...).
		'attachments.category.audio': ['de', 'es', 'it', 'nl'],
		'attachments.category.video': ['de', 'it', 'nl', 'sv'],
		// Dutch writes the same loanword, capital and all (German/Polish/Swedish
		// spell it Projekt, so only nl coincides).
		'chat.convert.projectLabel': ['nl'],
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

	test('every key is referenced somewhere in the app source', () => {
		// The mirror of the checks above, and the only one that catches a
		// *hardcoded literal*: a key authored in all twelve catalogs but referenced
		// nowhere almost always means the component still renders the English word
		// inline, so the catalog reads as coverage it does not have. That is how
		// theme.system sat translated in twelve languages while theme-switcher.tsx
		// rendered `label: 'System'`.
		//
		// Scanning for dotted string *literals* rather than `t(...)` call shapes is
		// deliberate. Keys reach the catalog three ways - a direct `t('x')`, a
		// `labelKey: MessageKey` table read as `t(item.labelKey)`
		// (settings-sidebar.tsx), and a `plural('x')` stem - and
		// `MessageKey = keyof typeof en` already type-checks any literal that lands
		// in a key position. Matching call shapes would need a new pattern per
		// indirection; matching literals does not.
		//
		// There is deliberately no allowlist. An exemption here would be a standing
		// claim that a translated string is meant to reach no screen.
		const literals = collectKeyLiterals();
		const orphans = EN_KEYS.filter((key) => !isReferenced(key, literals));
		expect(
			orphans,
			`authored in all ${LANGUAGES.length} catalogs but referenced nowhere - wire each through t(), or delete it from every catalog`,
		).toEqual([]);
	});

	test('no value carries characters from the wrong script', () => {
		// Authoring twelve languages by hand makes it easy to slip a hangul
		// syllable into the Japanese column while working down a row - a typo no
		// reader of either language would miss, and one no other check here can
		// see. Japanese kanji and the zh-Hans ideographs are CJK, outside both
		// ranges, so this never fires on them.
		for (const language of LANGUAGES) {
			for (const [key, value] of Object.entries(CATALOGS[language] ?? {})) {
				if (language !== 'ko') {
					expect(value, `${language}.${key} contains hangul - stray Korean?`).not.toMatch(/[가-힯]/);
				}
				if (language !== 'ja') {
					expect(value, `${language}.${key} contains kana - stray Japanese?`).not.toMatch(/[぀-ヿ]/);
				}
			}
		}
	});
});
