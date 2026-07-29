import { describe, expect, it } from 'vitest';
import {
	coerceLocaleSettings,
	DateFormat,
	DEFAULT_LOCALE_SETTINGS,
	detectLocaleDefaults,
	formatDateIn,
	formatDateTimeIn,
	formatMoneyUsd,
	formatNumber,
	LANGUAGE_LABELS,
	LANGUAGES,
	Language,
	type LocaleSettings,
	matchLanguageTag,
	NumberFormat,
	negotiateLanguage,
	parseLocaleSettingsPatch,
} from '../src/index.js';

/** Intl emits non-breaking / narrow-no-break spaces; normalize for assertions. */
function normalizeSpaces(value: string): string {
	return value.replace(/[  ]/g, ' ');
}

function settings(overrides: Partial<LocaleSettings> = {}): LocaleSettings {
	return { ...DEFAULT_LOCALE_SETTINGS, ...overrides };
}

/** Local-time construction, since formatDateIn reads local date fields. */
const JULY_29 = new Date(2026, 6, 29, 14, 5);

describe('formatMoneyUsd', () => {
	it('punctuates by the chosen convention and always uses a bare $', () => {
		expect(normalizeSpaces(formatMoneyUsd(123456, NumberFormat.DotComma))).toBe('$1,234.56');
		expect(normalizeSpaces(formatMoneyUsd(123456, NumberFormat.CommaDot))).toBe('1.234,56 $');
		expect(normalizeSpaces(formatMoneyUsd(123456, NumberFormat.SpaceComma))).toBe('1 234,56 $');
	});

	it('never renders a locale-specific symbol like US$ or $US', () => {
		for (const format of Object.values(NumberFormat)) {
			const rendered = formatMoneyUsd(123456, format);
			expect(rendered).not.toContain('US');
			expect(rendered).toContain('$');
		}
	});

	it('defaults to the default convention when none is given', () => {
		expect(formatMoneyUsd(500)).toBe(formatMoneyUsd(500, DEFAULT_LOCALE_SETTINGS.number_format));
	});

	it('renders sub-dollar and zero amounts to two decimals', () => {
		expect(normalizeSpaces(formatMoneyUsd(7, NumberFormat.DotComma))).toBe('$0.07');
		expect(normalizeSpaces(formatMoneyUsd(0, NumberFormat.DotComma))).toBe('$0.00');
	});

	it('treats a non-finite amount as zero rather than emitting NaN', () => {
		expect(formatMoneyUsd(Number.NaN, NumberFormat.DotComma)).toBe('$0.00');
		expect(formatMoneyUsd(Number.POSITIVE_INFINITY, NumberFormat.DotComma)).toBe('$0.00');
	});
});

describe('formatNumber', () => {
	it('follows the chosen separator convention', () => {
		expect(normalizeSpaces(formatNumber(1234567, NumberFormat.DotComma))).toBe('1,234,567');
		expect(normalizeSpaces(formatNumber(1234567, NumberFormat.CommaDot))).toBe('1.234.567');
		expect(normalizeSpaces(formatNumber(1234567, NumberFormat.SpaceComma))).toBe('1 234 567');
	});
});

describe('formatDateIn', () => {
	it('reorders the fields per the chosen format', () => {
		expect(formatDateIn(JULY_29, settings({ date_format: DateFormat.Dmy }))).toBe('29/07/2026');
		expect(formatDateIn(JULY_29, settings({ date_format: DateFormat.Mdy }))).toBe('07/29/2026');
		expect(formatDateIn(JULY_29, settings({ date_format: DateFormat.Ymd }))).toBe('2026-07-29');
	});

	it('zero-pads single-digit days and months in the numeric formats', () => {
		const march3 = new Date(2026, 2, 3);
		expect(formatDateIn(march3, settings({ date_format: DateFormat.Dmy }))).toBe('03/03/2026');
		expect(formatDateIn(march3, settings({ date_format: DateFormat.Ymd }))).toBe('2026-03-03');
	});

	it('draws the month name from the language, not the date format', () => {
		// The point of building from parts: field order and month language are
		// independent axes, which no single Intl locale can express. March is
		// used because several languages abbreviate July identically to English.
		const march3 = new Date(2026, 2, 3);
		const dMonY = { date_format: DateFormat.DMonY } as const;
		expect(formatDateIn(march3, settings({ language: Language.En, ...dMonY }))).toBe('3 Mar 2026');
		expect(formatDateIn(march3, settings({ language: Language.De, ...dMonY }))).toBe('3 Mär 2026');
		expect(formatDateIn(march3, settings({ language: Language.Fr, ...dMonY }))).toBe('3 mars 2026');
	});

	it('keeps day-first order for a German operator on d-mon-y', () => {
		// The combination no Intl locale offers: German month names in the
		// operator's own chosen field order.
		const rendered = formatDateIn(
			JULY_29,
			settings({ language: Language.De, date_format: DateFormat.DMonY }),
		);
		expect(rendered.indexOf('29')).toBeLessThan(rendered.indexOf('2026'));
	});

	it('applies a non-English month name under an ISO field order too', () => {
		expect(
			formatDateIn(
				new Date(2026, 2, 3),
				settings({ language: Language.De, date_format: DateFormat.Ymd }),
			),
		).toBe('2026-03-03');
	});

	it('renders every language without throwing', () => {
		for (const language of LANGUAGES) {
			for (const date_format of Object.values(DateFormat)) {
				expect(formatDateIn(JULY_29, settings({ language, date_format }))).not.toBe('');
			}
		}
	});

	it('returns an empty string for an unparsable date', () => {
		expect(formatDateIn(new Date('nonsense'), settings())).toBe('');
		expect(formatDateTimeIn(new Date('nonsense'), settings())).toBe('');
	});
});

describe('formatDateTimeIn', () => {
	it('prefixes the formatted date and appends a time', () => {
		const rendered = formatDateTimeIn(JULY_29, settings({ date_format: DateFormat.Ymd }));
		expect(rendered.startsWith('2026-07-29, ')).toBe(true);
		expect(rendered).toMatch(/\d/);
	});
});

describe('matchLanguageTag', () => {
	it('matches an exact supported tag', () => {
		expect(matchLanguageTag('de')).toBe(Language.De);
		expect(matchLanguageTag('ko')).toBe(Language.Ko);
	});

	it('reduces a regional tag to its primary subtag', () => {
		expect(matchLanguageTag('de-AT')).toBe(Language.De);
		expect(matchLanguageTag('en-GB')).toBe(Language.En);
		expect(matchLanguageTag('fr-CA')).toBe(Language.Fr);
	});

	it('is case- and separator-insensitive', () => {
		expect(matchLanguageTag('DE-at')).toBe(Language.De);
		expect(matchLanguageTag('pt_BR')).toBe(Language.PtBr);
	});

	it('folds European Portuguese into the Brazilian catalog', () => {
		expect(matchLanguageTag('pt')).toBe(Language.PtBr);
		expect(matchLanguageTag('pt-PT')).toBe(Language.PtBr);
	});

	it('folds Traditional-script Chinese into Simplified', () => {
		// Deliberate: Simplified is the closest thing shipped, and closer than English.
		expect(matchLanguageTag('zh-TW')).toBe(Language.ZhHans);
		expect(matchLanguageTag('zh-Hant')).toBe(Language.ZhHans);
		expect(matchLanguageTag('zh-HK')).toBe(Language.ZhHans);
		expect(matchLanguageTag('zh-CN')).toBe(Language.ZhHans);
	});

	it('returns null for an unsupported language', () => {
		expect(matchLanguageTag('nb')).toBeNull();
		expect(matchLanguageTag('fi')).toBeNull();
		expect(matchLanguageTag('')).toBeNull();
		expect(matchLanguageTag('   ')).toBeNull();
	});
});

describe('negotiateLanguage', () => {
	it('takes the first supported entry in preference order', () => {
		expect(negotiateLanguage(['de-DE', 'en-US'])).toBe(Language.De);
		expect(negotiateLanguage(['en-US', 'de-DE'])).toBe(Language.En);
	});

	it('skips unsupported entries rather than giving up at the first miss', () => {
		// A Norwegian speaker whose second choice is German should get German,
		// not English.
		expect(negotiateLanguage(['nb-NO', 'de-DE'])).toBe(Language.De);
		expect(negotiateLanguage(['fi', 'sv'])).toBe(Language.Sv);
	});

	it('falls back to English when nothing matches', () => {
		expect(negotiateLanguage(['nb', 'fi', 'is'])).toBe(Language.En);
		expect(negotiateLanguage([])).toBe(Language.En);
	});
});

describe('detectLocaleDefaults', () => {
	it('seeds all three axes from the browser preference', () => {
		expect(detectLocaleDefaults(['de-DE'])).toEqual({
			language: Language.De,
			date_format: DateFormat.Dmy,
			number_format: NumberFormat.CommaDot,
		});
	});

	it('gives Swedish and the CJK languages ISO date order', () => {
		expect(detectLocaleDefaults(['sv-SE']).date_format).toBe(DateFormat.Ymd);
		expect(detectLocaleDefaults(['ja-JP']).date_format).toBe(DateFormat.Ymd);
		expect(detectLocaleDefaults(['zh-CN']).date_format).toBe(DateFormat.Ymd);
		expect(detectLocaleDefaults(['ko-KR']).date_format).toBe(DateFormat.Ymd);
	});

	it('splits English by region, since that is the one language whose date order genuinely varies', () => {
		expect(detectLocaleDefaults(['en-US']).date_format).toBe(DateFormat.Mdy);
		expect(detectLocaleDefaults(['en-GB']).date_format).toBe(DateFormat.Dmy);
		expect(detectLocaleDefaults(['en-AU']).date_format).toBe(DateFormat.Dmy);
		expect(detectLocaleDefaults(['en-IE']).date_format).toBe(DateFormat.Dmy);
	});

	it('leaves bare English month-first', () => {
		expect(detectLocaleDefaults(['en']).date_format).toBe(DateFormat.Mdy);
	});

	it('does not apply the English region rule to other languages', () => {
		// fr-CA is day-first by language default, not by region inspection.
		expect(detectLocaleDefaults(['fr-CA']).date_format).toBe(DateFormat.Dmy);
	});

	it('falls back to the documented defaults for an unknown tag', () => {
		expect(detectLocaleDefaults(['is-IS'])).toEqual(DEFAULT_LOCALE_SETTINGS);
		expect(detectLocaleDefaults([])).toEqual(DEFAULT_LOCALE_SETTINGS);
	});
});

describe('parseLocaleSettingsPatch', () => {
	it('accepts a partial update naming one field', () => {
		expect(parseLocaleSettingsPatch({ language: 'ja' })).toEqual({
			ok: true,
			value: { language: Language.Ja },
		});
	});

	it('accepts all three fields together', () => {
		const result = parseLocaleSettingsPatch({
			language: 'de',
			date_format: 'dmy',
			number_format: 'comma-dot',
		});
		expect(result).toEqual({
			ok: true,
			value: {
				language: Language.De,
				date_format: DateFormat.Dmy,
				number_format: NumberFormat.CommaDot,
			},
		});
	});

	it('rejects an unsupported value and names the allowed set', () => {
		const result = parseLocaleSettingsPatch({ language: 'kl' });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('language');
			expect(result.error).toContain('zh-Hans');
		}
	});

	it('rejects a wrong-typed value', () => {
		expect(parseLocaleSettingsPatch({ date_format: 7 }).ok).toBe(false);
		expect(parseLocaleSettingsPatch({ number_format: null }).ok).toBe(false);
	});

	it('rejects a body naming no known field rather than silently no-opping', () => {
		const result = parseLocaleSettingsPatch({ unrelated: 'x' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('at least one of');
	});

	it('rejects a non-object body', () => {
		expect(parseLocaleSettingsPatch(null).ok).toBe(false);
		expect(parseLocaleSettingsPatch('de').ok).toBe(false);
		expect(parseLocaleSettingsPatch(undefined).ok).toBe(false);
	});
});

describe('coerceLocaleSettings', () => {
	it('fills absent fields from the defaults', () => {
		expect(coerceLocaleSettings({ language: 'fr' })).toEqual({
			...DEFAULT_LOCALE_SETTINGS,
			language: Language.Fr,
		});
	});

	it('degrades a corrupt stored value to the defaults instead of throwing', () => {
		// One bad row must not break every rendered date on the instance.
		expect(coerceLocaleSettings({ language: 'not-a-language' })).toEqual(DEFAULT_LOCALE_SETTINGS);
		expect(coerceLocaleSettings(null)).toEqual(DEFAULT_LOCALE_SETTINGS);
	});
});

describe('catalog invariants', () => {
	it('labels every language with its own endonym', () => {
		for (const language of LANGUAGES) {
			expect(LANGUAGE_LABELS[language]).toBeTruthy();
		}
		// A reader who cannot yet read the UI has to find their own language.
		expect(LANGUAGE_LABELS[Language.De]).toBe('Deutsch');
		expect(LANGUAGE_LABELS[Language.Ja]).toBe('日本語');
		expect(LANGUAGE_LABELS[Language.Ko]).toBe('한국어');
	});

	it('ships exactly the twelve agreed languages', () => {
		expect(LANGUAGES).toHaveLength(12);
		expect(LANGUAGES).toContain(Language.ZhHans);
		expect(LANGUAGES).toContain(Language.Ko);
	});
});
