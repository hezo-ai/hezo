import {
	DATE_FORMATS,
	DateFormat,
	DEFAULT_LOCALE_SETTINGS,
	LANGUAGES,
	type Language,
	type LocaleSettings,
	NUMBER_FORMATS,
	NumberFormat,
} from '../types/common.js';

/**
 * Locale-aware date and money rendering, plus the browser-tag negotiation that
 * pre-answers the onboarding locale screen.
 *
 * Everything here is pure — no React, no DOM, no `navigator` access (the caller
 * passes `navigator.languages` in) — so it unit-tests directly in the shared
 * tier and is equally callable from the server.
 *
 * Per AGENTS.md > Code design, each format is a row in a `Record<Enum, …>`
 * descriptor table rather than a branch: adding a fourth date format is one row
 * plus one catalog key, and an unhandled enum value is a compile error.
 */

// ---------------------------------------------------------------------------
// Descriptor tables
// ---------------------------------------------------------------------------

type DateField = 'day' | 'month' | 'year';

interface DateFormatDescriptor {
	/** The order the fields are emitted in. */
	readonly order: readonly DateField[];
	readonly separator: string;
	/**
	 * Render the month as a localized abbreviation ("Jul", "juil.", "7月")
	 * instead of a number. The abbreviation comes from the *language*, which is
	 * what keeps a German operator on `d-mon-y` reading "29 Jul 2026" rather
	 * than an English month in German field order.
	 */
	readonly monthAsName: boolean;
	/** Zero-pad day and numeric month to two digits. */
	readonly pad: boolean;
}

const DATE_FORMAT_DESCRIPTORS: Record<DateFormat, DateFormatDescriptor> = {
	[DateFormat.Dmy]: {
		order: ['day', 'month', 'year'],
		separator: '/',
		monthAsName: false,
		pad: true,
	},
	[DateFormat.Mdy]: {
		order: ['month', 'day', 'year'],
		separator: '/',
		monthAsName: false,
		pad: true,
	},
	[DateFormat.Ymd]: {
		order: ['year', 'month', 'day'],
		separator: '-',
		monthAsName: false,
		pad: true,
	},
	[DateFormat.DMonY]: {
		order: ['day', 'month', 'year'],
		separator: ' ',
		monthAsName: true,
		pad: false,
	},
};

interface NumberFormatDescriptor {
	/**
	 * A locale whose own `Intl` output already punctuates numbers this way. Safe
	 * to drive money off a representative locale (rather than the language)
	 * because a USD amount carries no language-dependent words — with
	 * `narrowSymbol` the symbol is always "$", so only the separators vary.
	 */
	readonly representativeLocale: string;
}

const NUMBER_FORMAT_DESCRIPTORS: Record<NumberFormat, NumberFormatDescriptor> = {
	[NumberFormat.DotComma]: { representativeLocale: 'en-US' },
	[NumberFormat.CommaDot]: { representativeLocale: 'de-DE' },
	[NumberFormat.SpaceComma]: { representativeLocale: 'fr-FR' },
};

/**
 * The format conventions each language defaults to, used to pre-answer the
 * onboarding screen. A guess, not a rule — the operator can override any axis.
 */
const LANGUAGE_FORMAT_DEFAULTS: Record<
	Language,
	{ date_format: DateFormat; number_format: NumberFormat }
> = {
	en: { date_format: DateFormat.Mdy, number_format: NumberFormat.DotComma },
	de: { date_format: DateFormat.Dmy, number_format: NumberFormat.CommaDot },
	fr: { date_format: DateFormat.Dmy, number_format: NumberFormat.SpaceComma },
	es: { date_format: DateFormat.Dmy, number_format: NumberFormat.CommaDot },
	it: { date_format: DateFormat.Dmy, number_format: NumberFormat.CommaDot },
	'pt-BR': { date_format: DateFormat.Dmy, number_format: NumberFormat.CommaDot },
	nl: { date_format: DateFormat.Dmy, number_format: NumberFormat.CommaDot },
	pl: { date_format: DateFormat.Dmy, number_format: NumberFormat.SpaceComma },
	sv: { date_format: DateFormat.Ymd, number_format: NumberFormat.SpaceComma },
	'zh-Hans': { date_format: DateFormat.Ymd, number_format: NumberFormat.DotComma },
	ja: { date_format: DateFormat.Ymd, number_format: NumberFormat.DotComma },
	ko: { date_format: DateFormat.Ymd, number_format: NumberFormat.DotComma },
};

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Render USD cents. `currencyDisplay: 'narrowSymbol'` pins the symbol to "$" so
 * the chosen format governs punctuation only — without it, `fr-FR` would render
 * "$US" and `sv-SE` "US$", which is a different decision than the one the
 * operator made.
 */
export function formatMoneyUsd(
	cents: number,
	numberFormat: NumberFormat = DEFAULT_LOCALE_SETTINGS.number_format,
	options: { maximumFractionDigits?: number; minimumFractionDigits?: number } = {},
): string {
	const { representativeLocale } = NUMBER_FORMAT_DESCRIPTORS[numberFormat];
	const amount = (Number.isFinite(cents) ? cents : 0) / 100;
	return new Intl.NumberFormat(representativeLocale, {
		style: 'currency',
		currency: 'USD',
		currencyDisplay: 'narrowSymbol',
		minimumFractionDigits: options.minimumFractionDigits ?? 2,
		maximumFractionDigits: options.maximumFractionDigits ?? 2,
	}).format(amount);
}

/** Plain localized number (no currency) — used for token counts and the like. */
export function formatNumber(value: number, numberFormat: NumberFormat): string {
	const { representativeLocale } = NUMBER_FORMAT_DESCRIPTORS[numberFormat];
	return new Intl.NumberFormat(representativeLocale).format(Number.isFinite(value) ? value : 0);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function pad2(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

/**
 * Render a date in the operator's chosen field order, with month names drawn
 * from their language.
 *
 * Built field-by-field rather than by handing a locale to `Intl.DateTimeFormat`
 * because the two axes are independent here: `Intl` couples field order to the
 * locale, so there is no locale that means "German month names in ISO order".
 */
export function formatDateIn(date: Date, settings: LocaleSettings): string {
	if (Number.isNaN(date.getTime())) return '';
	const descriptor = DATE_FORMAT_DESCRIPTORS[settings.date_format];

	const month = descriptor.monthAsName
		? new Intl.DateTimeFormat(settings.language, { month: 'short' }).format(date)
		: descriptor.pad
			? pad2(date.getMonth() + 1)
			: String(date.getMonth() + 1);

	const values: Record<DateField, string> = {
		day: descriptor.pad ? pad2(date.getDate()) : String(date.getDate()),
		month,
		year: String(date.getFullYear()),
	};

	return descriptor.order.map((field) => values[field]).join(descriptor.separator);
}

/** The chosen date followed by a language-localized time. */
export function formatDateTimeIn(date: Date, settings: LocaleSettings): string {
	if (Number.isNaN(date.getTime())) return '';
	const time = new Intl.DateTimeFormat(settings.language, {
		hour: 'numeric',
		minute: '2-digit',
	}).format(date);
	return `${formatDateIn(date, settings)}, ${time}`;
}

// ---------------------------------------------------------------------------
// Browser-tag negotiation
// ---------------------------------------------------------------------------

/**
 * Tags that don't reduce to a supported language by their primary subtag alone.
 * Traditional-script Chinese readers are pointed at Simplified deliberately:
 * it's the closest thing we ship, and closer than English.
 */
const LANGUAGE_TAG_ALIASES: Record<string, Language> = {
	pt: 'pt-BR',
	'pt-pt': 'pt-BR',
	'pt-br': 'pt-BR',
	zh: 'zh-Hans',
	'zh-cn': 'zh-Hans',
	'zh-sg': 'zh-Hans',
	'zh-hans': 'zh-Hans',
	'zh-hant': 'zh-Hans',
	'zh-tw': 'zh-Hans',
	'zh-hk': 'zh-Hans',
	'zh-mo': 'zh-Hans',
};

/** Resolve one BCP-47 tag to a supported language, or `null` if unsupported. */
export function matchLanguageTag(tag: string): Language | null {
	const normalized = tag.trim().toLowerCase().replace(/_/g, '-');
	if (!normalized) return null;

	const alias = LANGUAGE_TAG_ALIASES[normalized];
	if (alias) return alias;

	const primary = normalized.split('-')[0] ?? '';
	const primaryAlias = LANGUAGE_TAG_ALIASES[primary];
	if (primaryAlias) return primaryAlias;

	return LANGUAGES.find((language) => language.toLowerCase() === primary) ?? null;
}

/**
 * Pick the best supported language from an ordered preference list (typically
 * `navigator.languages`), falling back to English.
 */
export function negotiateLanguage(preferred: readonly string[]): Language {
	for (const tag of preferred) {
		const match = matchLanguageTag(tag);
		if (match) return match;
	}
	return DEFAULT_LOCALE_SETTINGS.language;
}

/** Regions where English is written day-first rather than month-first. */
const ENGLISH_DMY_REGIONS = new Set([
	'gb',
	'ie',
	'au',
	'nz',
	'za',
	'in',
	'sg',
	'my',
	'ng',
	'ke',
	'hk',
]);

/**
 * Seed all three axes from the browser's language preferences, so the
 * onboarding screen arrives pre-answered rather than asking cold.
 *
 * English gets a region pass because it is the one language whose date
 * convention genuinely splits: `en-GB` wants day-first, `en-US` month-first.
 */
export function detectLocaleDefaults(preferred: readonly string[]): LocaleSettings {
	const language = negotiateLanguage(preferred);
	const defaults = LANGUAGE_FORMAT_DEFAULTS[language];

	if (language === 'en') {
		const region = preferred
			.map((tag) => tag.trim().toLowerCase().replace(/_/g, '-'))
			.find((tag) => tag.startsWith('en-'))
			?.split('-')[1];
		if (region && ENGLISH_DMY_REGIONS.has(region)) {
			return { language, date_format: DateFormat.Dmy, number_format: defaults.number_format };
		}
	}

	return { language, ...defaults };
}

// ---------------------------------------------------------------------------
// Validation — one rule, called by the client for inline feedback and by the
// server as the real gate, so the two can never disagree (AGENTS.md > Code
// design: validation lives once and runs twice).
// ---------------------------------------------------------------------------

export type LocaleSettingsPatch = Partial<LocaleSettings>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const FIELD_VALIDATORS = {
	language: { allowed: LANGUAGES as readonly string[] },
	date_format: { allowed: DATE_FORMATS as readonly string[] },
	number_format: { allowed: NUMBER_FORMATS as readonly string[] },
} as const;

/**
 * Validate a partial locale update. Absent keys are left alone; a present key
 * must carry a supported value. An update naming no known field is rejected
 * rather than silently succeeding as a no-op.
 */
export function parseLocaleSettingsPatch(input: unknown): ParseResult<LocaleSettingsPatch> {
	if (typeof input !== 'object' || input === null) {
		return { ok: false, error: 'body must be an object' };
	}
	const body = input as Record<string, unknown>;
	const patch: LocaleSettingsPatch = {};

	for (const [field, { allowed }] of Object.entries(FIELD_VALIDATORS)) {
		if (!(field in body)) continue;
		const value = body[field];
		if (typeof value !== 'string' || !allowed.includes(value)) {
			return { ok: false, error: `${field} must be one of: ${allowed.join(', ')}` };
		}
		// Checked against `allowed` above, which is the enum's own value list.
		Object.assign(patch, { [field]: value });
	}

	if (Object.keys(patch).length === 0) {
		return {
			ok: false,
			error: `at least one of ${Object.keys(FIELD_VALIDATORS).join(', ')} is required`,
		};
	}
	return { ok: true, value: patch };
}

/**
 * Coerce a possibly-missing/possibly-stale stored value into a usable settings
 * object. Used wherever locale is read back from persistence, so one bad row
 * degrades to the default instead of breaking every rendered date.
 */
export function coerceLocaleSettings(input: unknown): LocaleSettings {
	const parsed = parseLocaleSettingsPatch(input);
	return parsed.ok
		? { ...DEFAULT_LOCALE_SETTINGS, ...parsed.value }
		: { ...DEFAULT_LOCALE_SETTINGS };
}
