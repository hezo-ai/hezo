import {
	BackLink,
	Callout,
	ConfirmDialog,
	DialogContent,
	InPlaceForm,
	ThemeProvider,
	ThemeSwitcher,
} from '@hezo/ui';
import * as Dialog from '@radix-ui/react-dialog';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

// **Rendered with no `I18nProvider`, deliberately.** A primitive that resolved
// its own copy could not render outside an app holding a catalog, which is the
// whole reason these could not be shared — `useI18n` throws rather than falling
// back. Every other spec in this tree wraps the provider, so nothing else can
// catch a `t()` creeping back into `@hezo/ui`.
//
// The wrappers in `components/ui/` are where the keys are looked up, and their
// own specs cover the translated path.

test('the shared confirmation renders without a translation context', () => {
	render(
		<ConfirmDialog
			open
			onOpenChange={() => {}}
			title="Delete project?"
			description="This cannot be undone."
			onConfirm={() => {}}
		/>,
	);

	expect(screen.getByRole('button', { name: /Cancel/ })).toBeTruthy();
	expect(screen.getByTestId('confirm-dialog-close').getAttribute('aria-label')).toBe('Close');
});

test('the shared confirmation takes the labels it is given', () => {
	render(
		<ConfirmDialog
			open
			onOpenChange={() => {}}
			title="Delete project?"
			description="This cannot be undone."
			cancelLabel="Annuleren"
			closeLabel="Sluiten"
			onConfirm={() => {}}
		/>,
	);

	expect(screen.getByRole('button', { name: /Annuleren/ })).toBeTruthy();
	expect(screen.getByTestId('confirm-dialog-close').getAttribute('aria-label')).toBe('Sluiten');
});

// It resolves no copy of its own - the title and the prose are the caller's -
// so it has nothing to look up and nothing to break outside an app with a
// catalog. Asserted rather than assumed, because a default label is exactly the
// thing that would creep in later.
test('the shared callout renders without a translation context', () => {
	render(
		<Callout tone="danger" title="That did not work">
			The container stopped before the run began.
		</Callout>,
	);

	expect(screen.getByRole('alert').textContent).toContain('That did not work');
});

test('the shared dialog body renders without a translation context', () => {
	render(
		<Dialog.Root open>
			<DialogContent>
				<Dialog.Title>Settings</Dialog.Title>
				<Dialog.Description>How this instance behaves.</Dialog.Description>
			</DialogContent>
		</Dialog.Root>,
	);

	expect(screen.getByTestId('dialog-close').getAttribute('aria-label')).toBe('Close');
});

// **The overlay reads the theme key, not the raw custom property.** A
// `bg-[var(--overlay)]` resolves to nothing wherever a consumer namespaces its
// own raw tokens, and the backdrop is then transparent with nothing in the
// markup to say so.
test('the overlay is painted through the theme utility', async () => {
	const { dialogOverlayClassName } = await import('@hezo/ui');

	expect(dialogOverlayClassName).toContain('bg-overlay');
	expect(dialogOverlayClassName).not.toContain('var(--');
});

test('the back link renders without a translation context', () => {
	render(<BackLink onClick={() => {}} />);

	expect(screen.getByRole('button', { name: /Back/ })).toBeTruthy();
});

test('the inline edit panel renders without a translation context', () => {
	render(
		<InPlaceForm title="Add connector" onClose={() => {}}>
			<span>fields</span>
		</InPlaceForm>,
	);

	expect(screen.getByTestId('in-place-form-close').getAttribute('aria-label')).toBe('Close');
});

// **The choices carry an icon and a value, never a catalog key.** A key here
// would put the app's translation layer back inside the package.
test('the theme menu renders without a translation context', async () => {
	render(
		<ThemeProvider storageKey="ui-spec-theme">
			<ThemeSwitcher />
		</ThemeProvider>,
	);

	expect(screen.getByRole('button', { name: 'Theme' })).toBeTruthy();
});

test('the theme menu takes the words it is given', () => {
	render(
		<ThemeProvider storageKey="ui-spec-theme">
			<ThemeSwitcher
				label="Thema"
				optionLabels={{ system: 'System', light: 'Hell', dark: 'Dunkel' }}
			/>
		</ThemeProvider>,
	);

	expect(screen.getByRole('button', { name: 'Thema' })).toBeTruthy();
});

test('the theme provider refuses to guess a storage key', () => {
	// A default key here would be a name every consumer silently shares, and an
	// app whose pre-paint script read a different one would flash on every load.
	expect(() =>
		render(
			// @ts-expect-error - the prop is required; this is the untyped caller's path.
			<ThemeProvider>
				<span />
			</ThemeProvider>,
		),
	).toThrow(/storageKey/);
});
