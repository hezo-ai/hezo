// Settings -> Languages & formats: the signed-in home of the locale editor.
// Saving writes the global instance setting (not a browser preference), the
// whole UI re-renders in the new language, and every option previews itself
// with real formatted output.
//
// The pre-auth globe button that hosts the same editor is covered by the
// Playwright tier - it only appears before any token is set, which the
// component harness bypasses (decision-tree item 6).
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

/** Intl emits non-breaking / narrow-no-break spaces; normalize for assertions. */
function normalizeSpaces(value: string): string {
	return value.replace(/[\u00a0\u202f\u2009]/g, ' ');
}

async function openLocaleSettings() {
	const rendered = await renderApp({ initialPath: '/settings/locale' });
	await waitFor(() => {
		if (!document.querySelector('[data-testid="locale-settings-page"]')) {
			throw new Error('locale settings page not mounted yet');
		}
	});
	return rendered;
}

/** Read the instance locale straight off the API - the source of truth. */
async function storedLocale() {
	const ctx = getTestContext();
	const res = await ctx.apiBase('/api/instance-settings', {
		headers: { Authorization: `Bearer ${ctx.token}` },
	});
	const body = await res.json();
	return body.data.locale as { language: string; date_format: string; number_format: string };
}

function optionLabels(name: string): string[] {
	return Array.from(document.querySelectorAll(`input[name="${name}"]`)).map((input) =>
		normalizeSpaces(input.closest('label')?.textContent ?? ''),
	);
}

test('the settings page renders the locale editor', async () => {
	const { findByRole } = await openLocaleSettings();
	// By role, because the sidebar nav item carries the same label.
	await findByRole('heading', { name: 'Languages & formats' });
});

test('the header carries no locale button once signed in', async () => {
	// It lives in Settings from here; the globe is only for screens that have
	// no navigation yet.
	await openLocaleSettings();
	expect(document.querySelector('[data-testid="locale-switcher"]')).toBeNull();
});

test('each date format previews itself with a real date', async () => {
	await openLocaleSettings();

	const labels = optionLabels('locale-date-format');
	expect(labels).toHaveLength(4);
	const year = String(new Date().getFullYear());
	for (const label of labels) expect(label).toContain(year);
	// The ISO option leads with the year, so field order is genuinely varying.
	expect(labels.some((l) => l.startsWith(year))).toBe(true);
});

test('each currency format previews the same amount punctuated differently', async () => {
	await openLocaleSettings();

	const labels = optionLabels('locale-number-format');
	expect(labels).toHaveLength(3);
	expect(labels.some((l) => l.includes('$1,234.56'))).toBe(true);
	expect(labels.some((l) => l.includes('1.234,56 $'))).toBe(true);
	expect(labels.some((l) => l.includes('1 234,56 $'))).toBe(true);
});

test('saving persists globally and re-renders the UI in the new language', async () => {
	const { user, findByRole } = await openLocaleSettings();

	await user.selectOptions(document.querySelector('#locale-language') as HTMLSelectElement, 'de');
	await user.click(document.querySelector('[data-testid="locale-save"]') as HTMLElement);

	await waitFor(async () => expect((await storedLocale()).language).toBe('de'));
	// The page heading itself is now German - proof the catalog is wired, not
	// just the setting stored.
	await findByRole('heading', { name: 'Sprachen & Formate' });
	await waitFor(() => expect(document.documentElement.lang).toBe('de'));
});

test('the date format choice reaches the stored instance settings', async () => {
	const { user } = await openLocaleSettings();

	const isoOption = Array.from(
		document.querySelectorAll<HTMLInputElement>('input[name="locale-date-format"]'),
	).find((input) => /^\d{4}-/.test(input.closest('label')?.textContent ?? ''));
	expect(isoOption).toBeTruthy();

	await user.click(isoOption as HTMLInputElement);
	await user.click(document.querySelector('[data-testid="locale-save"]') as HTMLElement);

	await waitFor(async () => expect((await storedLocale()).date_format).toBe('ymd'));
});

test('navigating away without saving leaves the stored locale alone', async () => {
	const { user, router } = await openLocaleSettings();

	await user.selectOptions(document.querySelector('#locale-language') as HTMLSelectElement, 'ko');
	await router.navigate({ to: '/settings' });

	expect((await storedLocale()).language).toBe('en');
});
