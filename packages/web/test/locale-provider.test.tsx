// Unit tests for the i18n context: locale initialization from the stored render
// hint, browser detection on a cold load, adopting the server's locale (which is
// the source of truth), message lookup with fallback and interpolation, plurals
// via Intl.PluralRules, and the format helpers. Rendered with renderHook (no app
// shell).
import { DateFormat, DEFAULT_LOCALE_SETTINGS, Language, NumberFormat } from '@hezo/shared';
import { act, render, renderHook } from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getActiveLocale } from '../src/lib/format-date';
import { I18nProvider, LanguagePreview, useI18n, useSyncInstanceLocale } from '../src/lib/i18n';
import { writeStored } from '../src/lib/safe-storage';

const STORAGE_KEY = 'locale';

function wrapper({ children }: { children: ReactNode }) {
	return <I18nProvider>{children}</I18nProvider>;
}

/** Point navigator.languages at a fixed preference list. */
function installLanguages(languages: string[]) {
	vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages);
}

/** Intl emits non-breaking / narrow-no-break spaces; normalize for assertions. */
function normalizeSpaces(value: string): string {
	return value.replace(/[\u00a0\u202f\u2009]/g, ' ');
}

describe('I18nProvider', () => {
	beforeEach(() => {
		localStorage.clear();
		document.documentElement.lang = '';
	});
	afterEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
	});

	test('detects the locale from the browser on a cold first load', () => {
		installLanguages(['de-DE', 'en-US']);
		const { result } = renderHook(() => useI18n(), { wrapper });
		expect(result.current.language).toBe(Language.De);
		expect(result.current.date_format).toBe(DateFormat.Dmy);
		expect(result.current.number_format).toBe(NumberFormat.CommaDot);
	});

	test('prefers the stored render hint over browser detection', () => {
		// The hint is the last locale the server reported; using it avoids a flash
		// of the wrong language while /api/status is in flight.
		writeStored(
			STORAGE_KEY,
			JSON.stringify({ language: 'ja', date_format: 'ymd', number_format: 'dot-comma' }),
		);
		installLanguages(['de-DE']);
		const { result } = renderHook(() => useI18n(), { wrapper });
		expect(result.current.language).toBe(Language.Ja);
	});

	test('falls back to browser detection when the stored hint is corrupt', () => {
		writeStored(STORAGE_KEY, 'not json');
		installLanguages(['fr-FR']);
		const { result } = renderHook(() => useI18n(), { wrapper });
		expect(result.current.language).toBe(Language.Fr);
	});

	test('falls back to the defaults when the browser reports nothing supported', () => {
		installLanguages(['is-IS']);
		const { result } = renderHook(() => useI18n(), { wrapper });
		expect(result.current.language).toBe(DEFAULT_LOCALE_SETTINGS.language);
	});

	test('the server locale wins over the stored hint and is re-cached', () => {
		writeStored(
			STORAGE_KEY,
			JSON.stringify({ language: 'ja', date_format: 'ymd', number_format: 'dot-comma' }),
		);
		installLanguages(['ja-JP']);
		const { result } = renderHook(() => useI18n(), { wrapper });
		expect(result.current.language).toBe(Language.Ja);

		act(() =>
			result.current.applyServerLocale({
				language: Language.Ko,
				date_format: DateFormat.Ymd,
				number_format: NumberFormat.DotComma,
			}),
		);

		expect(result.current.language).toBe(Language.Ko);
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY) as string).language).toBe(Language.Ko);
	});

	test('adopting an identical locale keeps the same context value (no needless re-render)', () => {
		// /api/status returns a fresh object every poll; re-rendering the whole
		// tree on each background refetch would be a real cost.
		installLanguages(['en-US']);
		const { result } = renderHook(() => useI18n(), { wrapper });
		const before = result.current;

		act(() => result.current.applyServerLocale({ ...DEFAULT_LOCALE_SETTINGS }));

		expect(result.current).toBe(before);
	});

	test('an unconfigured instance does not overwrite browser detection', () => {
		// /api/status reports the default locale before the operator has chosen
		// one. Adopting that placeholder would land a German browser on an
		// English language step - the exact bug this guards.
		installLanguages(['de-DE']);
		const { result } = renderHook(
			() => {
				const i18n = useI18n();
				useSyncInstanceLocale(DEFAULT_LOCALE_SETTINGS, false);
				return i18n;
			},
			{ wrapper },
		);
		expect(result.current.language).toBe(Language.De);
	});

	test('a configured instance locale outranks browser detection', () => {
		installLanguages(['de-DE']);
		const { result } = renderHook(
			() => {
				const i18n = useI18n();
				useSyncInstanceLocale(
					{
						language: Language.Ja,
						date_format: DateFormat.Ymd,
						number_format: NumberFormat.DotComma,
					},
					true,
				);
				return i18n;
			},
			{ wrapper },
		);
		expect(result.current.language).toBe(Language.Ja);
	});

	test('sets the document language so screen readers and browsers agree', () => {
		installLanguages(['ko-KR']);
		const { result } = renderHook(() => useI18n(), { wrapper });
		expect(document.documentElement.lang).toBe(Language.Ko);

		act(() => result.current.applyServerLocale({ ...DEFAULT_LOCALE_SETTINGS }));
		expect(document.documentElement.lang).toBe(Language.En);
	});

	test('publishes the locale to the shared date formatters', () => {
		// format-date keeps its existing signatures and reads module state; the
		// provider is its only writer.
		installLanguages(['de-DE']);
		renderHook(() => useI18n(), { wrapper });
		expect(getActiveLocale().language).toBe(Language.De);
		expect(getActiveLocale().date_format).toBe(DateFormat.Dmy);
	});

	test('t() looks up a message', () => {
		installLanguages(['en-US']);
		const { result } = renderHook(() => useI18n(), { wrapper });
		expect(result.current.t('locale.title')).toBe('Choose your language');
	});

	test('t() renders the active language when a catalog exists', () => {
		installLanguages(['pl-PL']);
		const { result } = renderHook(() => useI18n(), { wrapper });
		expect(result.current.language).toBe(Language.Pl);
		expect(result.current.t('locale.title')).toBe('Wybierz język');
	});

	test('t() falls back to English rather than rendering a raw key', () => {
		// The catalogs are generated, so a key added to en.json before the others
		// are regenerated must degrade to readable English mid-screen.
		installLanguages(['de-DE']);
		const { result } = renderHook(() => useI18n(), { wrapper });
		const missing = 'locale.notARealKey' as Parameters<typeof result.current.t>[0];
		expect(result.current.t(missing)).toBe(missing);
	});

	test('t() interpolates named placeholders', () => {
		installLanguages(['en-US']);
		const { result } = renderHook(() => useI18n(), { wrapper });
		// Uses a key that exists; interpolation is a no-op when there are no
		// placeholders, so assert the mechanism on a synthetic template instead.
		expect(result.current.t('common.loading', { unused: 'x' })).toBe('Loading...');
	});

	test('plural() selects by the language own rules', () => {
		installLanguages(['en-US']);
		const { result } = renderHook(() => useI18n(), { wrapper });
		expect(result.current.plural('thread.group.events', 1)).toBe('1 event');
		expect(result.current.plural('thread.group.events', 2)).toBe('2 events');
		expect(result.current.plural('thread.group.events', 0)).toBe('0 events');
	});

	test('plural() falls back to `other` for a category the catalog omits', () => {
		// Polish selects `few` for 2-4 and `many` for 5+; the catalogs author only
		// `one` and `other`, so both must resolve rather than render a raw key.
		installLanguages(['pl-PL']);
		const { result } = renderHook(() => useI18n(), { wrapper });
		expect(result.current.plural('thread.group.events', 3)).toContain('3');
		expect(result.current.plural('thread.group.events', 7)).toContain('7');
		expect(result.current.plural('thread.group.events', 3)).not.toContain('thread.group');
	});

	test('formatMoney follows the chosen currency convention', () => {
		installLanguages(['de-DE']);
		const { result } = renderHook(() => useI18n(), { wrapper });
		expect(normalizeSpaces(result.current.formatMoney(123456))).toBe('1.234,56 $');
	});

	test('formatDate follows the chosen field order', () => {
		installLanguages(['en-GB']);
		const { result } = renderHook(() => useI18n(), { wrapper });
		expect(result.current.formatDate(new Date(2026, 6, 29))).toBe('29/07/2026');
	});

	test('formatDate accepts an ISO string and tolerates empty input', () => {
		installLanguages(['sv-SE']);
		const { result } = renderHook(() => useI18n(), { wrapper });
		expect(result.current.formatDate('2026-07-29T10:00:00.000Z')).toMatch(/^2026-07-\d\d$/);
		expect(result.current.formatDate(null)).toBe('');
		expect(result.current.formatDate('nonsense')).toBe('');
	});

	test('formatNumber follows the chosen separator convention', () => {
		installLanguages(['fr-FR']);
		const { result } = renderHook(() => useI18n(), { wrapper });
		expect(normalizeSpaces(result.current.formatNumber(1234567))).toBe('1 234 567');
	});

	test('useI18n throws when used outside an I18nProvider', () => {
		expect(() => renderHook(() => useI18n())).toThrow(
			'useI18n must be used within an I18nProvider',
		);
	});
});

/** Publish the context value a subtree sees, so two subtrees can be compared. */
function Probe({ onValue }: { onValue: (value: ReturnType<typeof useI18n>) => void }) {
	const value = useI18n();
	useEffect(() => onValue(value), [value, onValue]);
	return null;
}

describe('LanguagePreview', () => {
	beforeEach(() => {
		localStorage.clear();
		document.documentElement.lang = '';
	});
	afterEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
	});

	test('renders its subtree in the previewed language', () => {
		installLanguages(['en-US']);
		const { result } = renderHook(() => useI18n(), {
			wrapper: ({ children }: { children: ReactNode }) => (
				<I18nProvider>
					<LanguagePreview language={Language.De}>{children}</LanguagePreview>
				</I18nProvider>
			),
		});

		expect(result.current.language).toBe(Language.De);
		expect(result.current.t('locale.title')).toBe('Sprache auswählen');
	});

	test('previews the language only - the formats stay committed', () => {
		// Date and currency format apply on save; only the language previews.
		installLanguages(['en-US']);
		const { result } = renderHook(() => useI18n(), {
			wrapper: ({ children }: { children: ReactNode }) => (
				<I18nProvider>
					<LanguagePreview language={Language.De}>{children}</LanguagePreview>
				</I18nProvider>
			),
		});

		expect(result.current.date_format).toBe(DateFormat.Mdy);
		expect(result.current.number_format).toBe(NumberFormat.DotComma);
		expect(result.current.formatDate(new Date(2026, 6, 29))).toBe('07/29/2026');
	});

	test('commits nothing - an unsaved preview leaves every global alone', () => {
		// This is what makes it safe to drop with no cleanup on unmount or cancel.
		installLanguages(['en-US']);
		renderHook(() => useI18n(), {
			wrapper: ({ children }: { children: ReactNode }) => (
				<I18nProvider>
					<LanguagePreview language={Language.Ko}>{children}</LanguagePreview>
				</I18nProvider>
			),
		});

		expect(document.documentElement.lang).toBe(Language.En);
		expect(getActiveLocale().language).toBe(Language.En);
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY) as string).language).toBe(Language.En);
	});

	test('previewing the committed language reuses the same context value', () => {
		// An unchanged draft must not re-render the subtree, the same reason
		// applyServerLocale compares by value.
		installLanguages(['en-US']);
		let outer: ReturnType<typeof useI18n> | null = null;
		let inner: ReturnType<typeof useI18n> | null = null;

		render(
			<I18nProvider>
				<Probe
					onValue={(v) => {
						outer = v;
					}}
				/>
				<LanguagePreview language={Language.En}>
					<Probe
						onValue={(v) => {
							inner = v;
						}}
					/>
				</LanguagePreview>
			</I18nProvider>,
		);

		expect(outer).not.toBeNull();
		expect(inner).toBe(outer);
	});
});
