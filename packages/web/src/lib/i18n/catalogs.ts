import type { Language } from '@hezo/shared';
import de from './catalog/de.json';
import en from './catalog/en.json';
import es from './catalog/es.json';
import fr from './catalog/fr.json';
import it from './catalog/it.json';
import ja from './catalog/ja.json';
import ko from './catalog/ko.json';
import nl from './catalog/nl.json';
import pl from './catalog/pl.json';
import pt_BR from './catalog/pt-BR.json';
import sv from './catalog/sv.json';
import zh_Hans from './catalog/zh-Hans.json';

/**
 * The message catalogs, one per supported language.
 *
 * These are **hand-authored source files**, not generated - there is no
 * translation API and no build step behind them. `en.json` is the source of
 * truth; the others are written against it and reviewed like any other code.
 *
 * Static imports (rather than a dynamic `import()` keyed by language) so Vite
 * bundles every catalog and switching language needs no network round-trip.
 *
 * A language absent from this map renders English: `lookup()` in `./index.tsx`
 * falls back through language -> English -> the key itself, so a missing
 * catalog degrades to readable English rather than to raw keys.
 *
 * Because they are authored rather than generated, the failure mode is
 * *omission* - a key added to `en.json` and copy-pasted unchanged into the
 * others. `test/i18n-catalog.test.ts` is what catches that; see the
 * translation conventions in AGENTS.md before editing any of these.
 */
export const CATALOGS: Partial<Record<Language, Record<string, string>>> = {
	en,
	de,
	fr,
	es,
	it,
	'pt-BR': pt_BR,
	nl,
	pl,
	sv,
	'zh-Hans': zh_Hans,
	ja,
	ko,
};
