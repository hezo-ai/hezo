import {
	DEFAULT_LOCALE_SETTINGS,
	formatDateIn,
	formatDateTimeIn,
	type Language,
	type LocaleSettings,
} from '@hezo/shared';
import {
	differenceInDays,
	differenceInHours,
	differenceInMinutes,
	differenceInSeconds,
	formatDistanceToNowStrict,
	type Locale,
} from 'date-fns';
import { de, enUS, es, fr, it, ja, ko, nl, pl, ptBR, sv, zhCN } from 'date-fns/locale';

/**
 * Shared date/time formatting for the web app. Timestamps are rendered as a
 * relative "X ago" phrase for the recent past (up to a week) and fall back to an
 * absolute date once they're older, while the full local date+time is always
 * available for a tooltip via {@link formatDateTime}.
 *
 * These are pure functions (no React) so they can be unit-tested directly; the
 * `<RelativeTime>` component pairs a relative label with the absolute-date
 * tooltip.
 *
 * The active locale lives in module state rather than in every signature. That
 * is sound here rather than a shortcut: the locale is a *global instance*
 * setting, so there is exactly one value in play at a time, and `I18nProvider`
 * is its only writer. Keeping the exported signatures unchanged also means the
 * ~14 files that call these needed no edit. Tests set it explicitly.
 */

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** date-fns ships one locale object per language; relative phrases need it. */
const DATE_FNS_LOCALES: Record<Language, Locale> = {
	en: enUS,
	de,
	fr,
	es,
	it,
	'pt-BR': ptBR,
	nl,
	pl,
	sv,
	'zh-Hans': zhCN,
	ja,
	ko,
};

let activeLocale: LocaleSettings = DEFAULT_LOCALE_SETTINGS;

/** Set by `I18nProvider` whenever the instance locale changes. */
export function setActiveLocale(locale: LocaleSettings): void {
	activeLocale = locale;
}

/** The locale these formatters are currently rendering in. */
export function getActiveLocale(): LocaleSettings {
	return activeLocale;
}

/** Parse an ISO string to a Date, or `null` when empty/unparsable. */
function parseDate(iso: string | null | undefined): Date | null {
	if (!iso) return null;
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? null : d;
}

/** Full local date + time — used for every timestamp tooltip. `''` when unparsable. */
export function formatDateTime(iso: string | null | undefined): string {
	const d = parseDate(iso);
	return d ? formatDateTimeIn(d, activeLocale) : '';
}

/** Local date only (no time) — the fallback label once a timestamp is older than a week. `''` when unparsable. */
export function formatDate(iso: string | null | undefined): string {
	const d = parseDate(iso);
	return d ? formatDateIn(d, activeLocale) : '';
}

/**
 * Options shared by both relative formatters.
 *
 * `alwaysRelative` keeps the phrase relative however old the timestamp is
 * (`"2 months ago"`, `"1 year ago"`), for a slot whose whole point is the age -
 * a metadata field labelled with what the timestamp means, sitting next to its
 * absolute-date tooltip. Everywhere else the week cutoff stands, so a timestamp
 * that is no longer in living memory reads as a date.
 */
export interface RelativeTimeOptions {
	alwaysRelative?: boolean;
}

/** Whether a timestamp is old (or far enough in the future) to read as a date. */
function fallsBackToDate(d: Date, { alwaysRelative = false }: RelativeTimeOptions): boolean {
	return !alwaysRelative && Math.abs(Date.now() - d.getTime()) >= SEVEN_DAYS_MS;
}

/**
 * Relative label: `"30 seconds ago"`, `"1 hour ago"`, `"2 days ago"`, up to a
 * week; anything older (or more than a week in the future) falls back to the
 * absolute date unless `alwaysRelative` is set. Near-future timestamps read as
 * `"in 5 minutes"`. `''` when unparsable.
 */
export function formatRelativeTime(
	iso: string | null | undefined,
	options: RelativeTimeOptions = {},
): string {
	const d = parseDate(iso);
	if (!d) return '';
	if (fallsBackToDate(d, options)) return formatDateIn(d, activeLocale);
	return formatDistanceToNowStrict(d, {
		addSuffix: true,
		locale: DATE_FNS_LOCALES[activeLocale.language],
	});
}

/**
 * Compact relative label for space-constrained spots: `"now"`, `"5m"`, `"3h"`,
 * `"2d"`; older than a week falls back to the absolute date unless
 * `alwaysRelative` is set. `''` when unparsable.
 *
 * The unit suffixes stay untranslated on purpose - they have to fit a fixed,
 * very narrow slot, and a localized abbreviation would overflow it.
 */
export function formatRelativeTimeCompact(
	iso: string | null | undefined,
	options: RelativeTimeOptions = {},
): string {
	const d = parseDate(iso);
	if (!d) return '';
	const now = Date.now();
	if (fallsBackToDate(d, options)) return formatDateIn(d, activeLocale);
	if (differenceInSeconds(now, d) < 60) return 'now';
	const minutes = differenceInMinutes(now, d);
	if (minutes < 60) return `${minutes}m`;
	const hours = differenceInHours(now, d);
	if (hours < 24) return `${hours}h`;
	return `${differenceInDays(now, d)}d`;
}
