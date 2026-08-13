import { waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { expect } from 'vitest';

/**
 * Open every collapsed event group in the task thread.
 *
 * The Conversation view is the default, so a test asserting on a run or system
 * row has to reach through the group holding it. Tests about the *folding* seed
 * their own expectations; this is for the ones that only ever cared about the
 * row inside.
 *
 * Returns the number of groups it opened, so a caller can assert the thread
 * folded at all rather than silently passing on a thread with no groups.
 */
export async function expandEventGroups(user: UserEvent): Promise<number> {
	const toggles = () =>
		Array.from(document.querySelectorAll<HTMLElement>('[data-testid="event-group-toggle"]')).filter(
			(el) => el.getAttribute('aria-expanded') === 'false',
		);

	let opened = 0;
	// Wait for the thread, then for a chip to mount. Expanding straight after a
	// navigation would race the feed and silently open nothing.
	await waitFor(() => {
		expect(document.querySelector('[data-testid="comments-list"]')).not.toBeNull();
	});
	try {
		await waitFor(() => {
			expect(toggles().length).toBeGreaterThan(0);
		});
	} catch {
		// A thread with nothing foldable is legitimate; the caller checks the count.
	}
	for (let pass = 0; pass < 10; pass++) {
		const pending = toggles();
		if (pending.length === 0) break;
		for (const toggle of pending) {
			await user.click(toggle);
			opened++;
		}
	}
	return opened;
}
