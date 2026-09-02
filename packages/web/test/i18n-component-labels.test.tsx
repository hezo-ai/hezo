// Guards that the catalog keys the components were wired to actually reach the
// screen. `i18n-catalog.test.ts` proves every key is *referenced* somewhere;
// this proves the reference renders the translated value under a non-English
// locale.
//
// The shared primitives get the most attention on purpose. They ship from
// `@hezo/ui`, which resolves no copy of its own - every label is a prop with an
// English default - and the `components/ui/` files imported below are the thin
// wrappers that look the keys up. Both halves of that need a test: the wrapper's
// default resolves through the catalog, and an explicitly-passed prop still wins
// (the exported prop shape did not change). The other half, that the primitives
// render at all without a provider, is `ui-package-standalone.test.tsx`.
//
// Rendered directly rather than through `renderApp`: the locale is a global
// instance setting the server reports, so the app harness has no seam to seed a
// language, and these components need no router or query context.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BackLink } from '../src/components/ui/back-link';
import { ConfirmDialog } from '../src/components/ui/confirm-dialog';
import { ThemeSwitcher } from '../src/components/ui/theme-switcher';
import { I18nProvider } from '../src/lib/i18n';
import { ThemeProvider } from '../src/lib/theme';

/** German, chosen because its values differ from the English for these keys. */
function installGermanBrowser() {
	vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-DE', 'en-US']);
}

/** ThemeSwitcher reaches useTheme, which reads prefers-color-scheme. */
function installMatchMedia() {
	vi.spyOn(window, 'matchMedia').mockReturnValue({
		matches: false,
		media: '(prefers-color-scheme: dark)',
		onchange: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		dispatchEvent: () => true,
	} as unknown as MediaQueryList);
}

function InGerman({ children }: { children: ReactNode }) {
	return <I18nProvider>{children}</I18nProvider>;
}

describe('component labels render from the catalog', () => {
	beforeEach(() => {
		// No stored render hint, so I18nProvider detects from the browser.
		localStorage.clear();
		installGermanBrowser();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
	});

	test('the theme menu labels its trigger and options in the active language', async () => {
		installMatchMedia();
		const user = userEvent.setup({ delay: null });
		render(
			<InGerman>
				<ThemeProvider>
					<ThemeSwitcher />
				</ThemeProvider>
			</InGerman>,
		);

		// theme.label - was a hardcoded "Toggle theme" aria-label.
		const trigger = screen.getByRole('button', { name: 'Design' });
		await user.click(trigger);

		// Radix renders the panel into a portal on document.body.
		// theme.light / theme.dark - was a module-level `label: 'Light'` table.
		expect(await screen.findByText('Hell')).toBeTruthy();
		expect(screen.getByText('Dunkel')).toBeTruthy();
		// theme.system is legitimately "System" in German (allowlisted), so it is
		// no evidence either way - assert it is present, not that it differs.
		expect(screen.getByText('System')).toBeTruthy();
	});

	test('ConfirmDialog defaults its cancel and close labels through the catalog', () => {
		render(
			<InGerman>
				{/* `description` is optional on the props but Radix warns without one. */}
				<ConfirmDialog
					open
					onOpenChange={() => {}}
					title="Löschen?"
					description="Das kann nicht rückgängig gemacht werden."
					onConfirm={() => {}}
				/>
			</InGerman>,
		);

		expect(screen.getByRole('button', { name: /Abbrechen/ })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Schließen' })).toBeTruthy();
	});

	test('an explicit ConfirmDialog cancelLabel still overrides the default', () => {
		render(
			<InGerman>
				<ConfirmDialog
					open
					onOpenChange={() => {}}
					title="Löschen?"
					description="Das kann nicht rückgängig gemacht werden."
					cancelLabel="Nicht jetzt"
					onConfirm={() => {}}
				/>
			</InGerman>,
		);

		expect(screen.getByRole('button', { name: /Nicht jetzt/ })).toBeTruthy();
		expect(screen.queryByRole('button', { name: /Abbrechen/ })).toBeNull();
	});

	test('BackLink defaults to the translated label, and yields to an explicit one', () => {
		const { unmount } = render(
			<InGerman>
				<BackLink onClick={() => {}} />
			</InGerman>,
		);
		expect(screen.getByRole('button', { name: 'Zurück' })).toBeTruthy();
		unmount();

		render(
			<InGerman>
				<BackLink onClick={() => {}} label="Abbrechen" />
			</InGerman>,
		);
		expect(screen.getByRole('button', { name: 'Abbrechen' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Zurück' })).toBeNull();
	});
});
