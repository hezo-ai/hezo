import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, test, vi } from 'vitest';
import { ConfirmDialog } from '../src/components/ui/confirm-dialog';
import { I18nProvider } from '../src/lib/i18n';
import { isMacPlatform } from '../src/lib/shortcuts';

// ConfirmDialog defaults its cancel label through `t()`, so it needs the i18n
// context. The default locale is English, so the assertions below are unchanged.
function withI18n(children: ReactNode) {
	return <I18nProvider>{children}</I18nProvider>;
}

// The ConfirmDialog hand-rolls its AlertDialog buttons (not <Button>), so it
// wires the keycap + auto-fire itself. Verify both keycaps render and that
// ⌘/Ctrl+Enter triggers the confirm action.
test('ConfirmDialog shows keycaps and confirms on mod+Enter', () => {
	const onConfirm = vi.fn();
	render(
		withI18n(
			<ConfirmDialog
				open
				onOpenChange={() => {}}
				title="Delete project?"
				confirmLabel="Delete"
				onConfirm={onConfirm}
			/>,
		),
	);
	const confirm = screen.getByTestId('confirm-dialog-confirm');
	expect(confirm.querySelector('kbd')).not.toBeNull();
	// The Escape keycap sits on the Cancel button (display-only; AlertDialog owns Esc).
	expect(screen.getByRole('button', { name: /Cancel/ }).querySelector('kbd')).not.toBeNull();

	const mac = isMacPlatform();
	fireEvent.keyDown(document, { key: 'Enter', metaKey: mac, ctrlKey: !mac });
	expect(onConfirm).toHaveBeenCalledTimes(1);
});

test('ConfirmDialog does not fire while loading', () => {
	const onConfirm = vi.fn();
	render(
		withI18n(
			<ConfirmDialog open onOpenChange={() => {}} title="Working…" onConfirm={onConfirm} loading />,
		),
	);
	const mac = isMacPlatform();
	fireEvent.keyDown(document, { key: 'Enter', metaKey: mac, ctrlKey: !mac });
	expect(onConfirm).not.toHaveBeenCalled();
});
