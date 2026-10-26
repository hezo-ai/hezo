import { buttonClassName } from '@hezo/ui';
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { expect, type MockInstance } from 'vitest';

interface AsksFirstOptions {
	user: UserEvent;
	/** The delete control. Called twice, so it must find the element afresh. */
	trigger: () => Promise<HTMLElement> | HTMLElement;
	/** A spy on the request the delete sends. */
	send: MockInstance;
	/** Text the dialog must show, naming what it deletes. */
	names: string | RegExp;
}

/**
 * Drives a delete control that must ask first: the click opens a confirmation
 * naming the thing and sends nothing, Cancel closes it and sends nothing, and
 * only the danger-styled Confirm sends the request.
 *
 * Resolves once the request has been sent, leaving the caller to assert what
 * the delete did.
 */
export async function expectDeleteAsksFirst({
	user,
	trigger,
	send,
	names,
}: AsksFirstOptions): Promise<void> {
	await user.click(await trigger());
	const dialog = await screen.findByRole('alertdialog');
	within(dialog).getByText(names);
	expect(send).not.toHaveBeenCalled();

	await user.click(within(dialog).getByRole('button', { name: /Cancel/ }));
	await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
	expect(send).not.toHaveBeenCalled();

	await user.click(await trigger());
	const confirm = await screen.findByTestId('confirm-dialog-confirm');
	expect(confirm.className).toBe(buttonClassName({ variant: 'destructive', size: 'sm' }));
	await user.click(confirm);
	await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
}
