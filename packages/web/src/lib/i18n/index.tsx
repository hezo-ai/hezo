import {
	coerceLocaleSettings,
	DEFAULT_LOCALE_SETTINGS,
	detectLocaleDefaults,
	formatDateIn,
	formatDateTimeIn,
	formatMoneyUsd,
	formatNumber,
	type Language,
	type LocaleSettings,
} from '@hezo/shared';
import {
	createContext,
	Fragment,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react';
import { setActiveLocale } from '../format-date';
import { readStored, writeStored } from '../safe-storage';
import en from './catalog/en.json';
import { CATALOGS } from './catalogs';

/**
 * The app's message catalog and locale context.
 *
 * The locale is a **global instance setting**, not a per-browser preference:
 * the server is the source of truth and `/api/status` carries it. localStorage
 * holds only a *render hint* - the last locale the server reported - so first
 * paint doesn't flash English while that request is in flight. The hint is
 * never authoritative; the server value always wins once it arrives.
 *
 * This mirrors the anti-FOUC trick the theme already uses in `index.html`.
 */

/**
 * Message keys are derived from the English catalog, so a typo in a `t()` call
 * is a compile error rather than a string that silently renders as its own key.
 */
export type MessageKey = keyof typeof en;

const STORAGE_KEY = 'locale';

interface I18nContextValue extends LocaleSettings {
	/** Look up a message, interpolating `{name}` placeholders. */
	t: (key: MessageKey, vars?: Record<string, string | number>) => string;
	/** Pick a plural form by the language's own rules (`key.one`, `key.other`, ...). */
	plural: (key: MessageKey, count: number, vars?: Record<string, string | number>) => string;
	formatDate: (value: Date | string | null | undefined) => string;
	formatDateTime: (value: Date | string | null | undefined) => string;
	formatMoney: (cents: number) => string;
	formatNumber: (value: number) => string;
	/**
	 * Adopt the locale the server reported. Called from inside the query tree,
	 * which is where `/api/status` is already fetched - the provider deliberately
	 * does not issue a second request of its own.
	 */
	applyServerLocale: (locale: LocaleSettings) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/** Read the cached render hint, or detect from the browser on a cold first load. */
function initialLocale(): LocaleSettings {
	if (typeof window === 'undefined') return DEFAULT_LOCALE_SETTINGS;
	const stored = readStored(STORAGE_KEY);
	if (stored) {
		try {
			return coerceLocaleSettings(JSON.parse(stored));
		} catch {
			// Corrupt hint: fall through to detection rather than crashing init.
		}
	}
	return detectLocaleDefaults(navigator.languages ?? [navigator.language]);
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
	if (!vars) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		name in vars ? String(vars[name]) : match,
	);
}

/**
 * Resolve a key through language -> English -> the key itself. A missing
 * translation degrades to readable English rather than to a raw key.
 */
function lookup(language: Language, key: string): string {
	const catalog = CATALOGS[language] as Record<string, string> | undefined;
	return catalog?.[key] ?? (en as Record<string, string>)[key] ?? key;
}

function toDate(value: Date | string | null | undefined): Date | null {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Build the context value for a locale. Shared by the real provider and by
 * {@link LanguagePreview}, so the two can never resolve a key differently.
 */
function buildI18nValue(
	locale: LocaleSettings,
	applyServerLocale: (next: LocaleSettings) => void,
): I18nContextValue {
	const t = (key: MessageKey, vars?: Record<string, string | number>) =>
		interpolate(lookup(locale.language, key), vars);

	return {
		...locale,
		t,
		plural: (key, count, vars) => {
			const category = new Intl.PluralRules(locale.language).select(count);
			const template =
				lookup(locale.language, `${key}.${category}`) !== `${key}.${category}`
					? lookup(locale.language, `${key}.${category}`)
					: lookup(locale.language, `${key}.other`);
			return interpolate(template, { count, ...vars });
		},
		formatDate: (value) => {
			const date = toDate(value);
			return date ? formatDateIn(date, locale) : '';
		},
		formatDateTime: (value) => {
			const date = toDate(value);
			return date ? formatDateTimeIn(date, locale) : '';
		},
		formatMoney: (cents) => formatMoneyUsd(cents, locale.number_format),
		formatNumber: (value) => formatNumber(value, locale.number_format),
		applyServerLocale,
	};
}

export function I18nProvider({ children }: { children: ReactNode }) {
	const [locale, setLocale] = useState<LocaleSettings>(initialLocale);

	const applyServerLocale = useCallback((next: LocaleSettings) => {
		setLocale((current) =>
			current.language === next.language &&
			current.date_format === next.date_format &&
			current.number_format === next.number_format
				? current
				: next,
		);
	}, []);

	useEffect(() => {
		writeStored(STORAGE_KEY, JSON.stringify(locale));
		document.documentElement.lang = locale.language;
		// `format-date` keeps its existing call-site-free signatures and reads the
		// active locale from module state; the provider is its only writer.
		setActiveLocale(locale);
	}, [locale]);

	const value = useMemo<I18nContextValue>(
		() => buildI18nValue(locale, applyServerLocale),
		[locale, applyServerLocale],
	);

	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Render a subtree in a language the operator has picked but not yet saved.
 *
 * The locale editor's `<select>` writes to a local draft, so without this the
 * card that *is* the language picker would keep rendering in the old language
 * until the operator pressed Continue - no confirmation that they picked the
 * language they meant. Wrapping the card re-translates it on the spot.
 *
 * **A preview is not a decision**, so it deliberately changes nothing global:
 * no localStorage render hint, no `document.documentElement.lang`, no
 * `setActiveLocale`, no request. That is what makes it safe to drop with no
 * cleanup - unmounting, cancelling the dialog, or navigating away simply stops
 * rendering it, and the committed locale was never touched.
 *
 * **Language only.** `date_format` and `number_format` stay committed: those
 * two already preview inside their own option rows and apply everywhere else
 * only on save, and nothing here should change that.
 */
export function LanguagePreview({
	language,
	children,
}: {
	language: Language;
	children: ReactNode;
}) {
	const outer = useI18n();
	const value = useMemo<I18nContextValue>(
		() =>
			// Reuse the outer value outright when nothing is being previewed - same
			// identity, so an unchanged draft costs no re-render (the same reason
			// `applyServerLocale` compares by value).
			language === outer.language
				? outer
				: buildI18nValue(
						{
							language,
							date_format: outer.date_format,
							number_format: outer.number_format,
						},
						outer.applyServerLocale,
					),
		[language, outer],
	);

	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
	const context = useContext(I18nContext);
	if (!context) throw new Error('useI18n must be used within an I18nProvider');
	return context;
}

/** Split on `{name}` while keeping the tokens, so parts alternate literal/token. */
const TOKEN_SPLIT = /(\{\w+\})/;
const TOKEN_EXACT = /^\{(\w+)\}$/;

/**
 * `t()` for a sentence that contains React nodes - a link, an `<em>`, a badge.
 *
 * `t()` cannot express those: `interpolate` is a string replace over
 * `Record<string, string | number>`, so a `ReactNode` has nowhere to go. The
 * alternative - splitting a sentence into fragment keys around each node - forces
 * English word order onto every language, which is exactly what a translation is
 * meant to be free to change. Here the whole sentence stays one template and the
 * nodes land wherever that language puts them.
 *
 * Deliberately mirrors `interpolate` in every other respect: the same `{name}`
 * token syntax (so the catalog guard's placeholder-drift check covers these keys
 * unchanged), the same `lookup()` fallback chain, and the same treatment of a
 * token with no matching var - it renders literally rather than vanishing.
 */
export function Trans({ k, vars }: { k: MessageKey; vars?: Record<string, ReactNode> }) {
	const { language } = useI18n();
	return (
		<>
			{lookup(language, k)
				.split(TOKEN_SPLIT)
				.map((part, i) => {
					const name = TOKEN_EXACT.exec(part)?.[1];
					const resolved = name && vars && name in vars ? vars[name] : part;
					// biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and stable per render
					return <Fragment key={i}>{resolved}</Fragment>;
				})}
		</>
	);
}

/**
 * Adopt the locale from an already-fetched `/api/status` payload. Lives here so
 * the shell only has to pass the value through, and so the provider never
 * issues a second `/api/status` request of its own.
 *
 * **Gated on `configured`.** Until the operator has actually chosen a locale,
 * `/api/status` reports the *default* (en / mdy / dot-comma) - a placeholder,
 * not a decision. Adopting it would overwrite the browser detection that
 * pre-answers the onboarding language step, so a German browser would land on
 * an English form. Only a real, stored choice outranks detection.
 *
 * Safe to call on every render: `status.locale` is a fresh object per fetch,
 * but `applyServerLocale` compares by value and keeps the previous state when
 * nothing changed, so a background refetch does not re-render the tree.
 */
export function useSyncInstanceLocale(
	locale: LocaleSettings | undefined,
	configured: boolean | undefined,
): void {
	const { applyServerLocale } = useI18n();
	useEffect(() => {
		if (locale && configured) applyServerLocale(locale);
	}, [locale, configured, applyServerLocale]);
}
