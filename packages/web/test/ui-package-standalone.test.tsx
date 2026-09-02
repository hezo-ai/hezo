import { ConfirmDialog, DialogContent } from '@hezo/ui';
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
		<ConfirmDialog open onOpenChange={() => {}} title="Delete project?" onConfirm={() => {}} />,
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
			cancelLabel="Annuleren"
			closeLabel="Sluiten"
			onConfirm={() => {}}
		/>,
	);

	expect(screen.getByRole('button', { name: /Annuleren/ })).toBeTruthy();
	expect(screen.getByTestId('confirm-dialog-close').getAttribute('aria-label')).toBe('Sluiten');
});

test('the shared dialog body renders without a translation context', () => {
	render(
		<Dialog.Root open>
			<DialogContent>
				<Dialog.Title>Settings</Dialog.Title>
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
