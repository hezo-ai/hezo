import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

// Proof-of-concept: render the app at /home and confirm the React tree
// hydrates against the in-process Hono server. If this passes, the harness
// is wired up correctly and we can migrate spec by spec.
test('harness boots the app against the in-process server', async () => {
	const { findByTestId } = await renderApp({ initialPath: '/home' });
	// The fresh /home route lands on the full-pane CEO room - its greeting is
	// what mounts first when no project exists yet.
	await findByTestId('home-ceo-landing', undefined, { timeout: 10_000 });
});

test('test context exposes a fetchable backend', async () => {
	await renderApp({ initialPath: '/home' });
	const ctx = getTestContext();
	const res = await ctx.apiBase('/api/status');
	expect(res.ok).toBe(true);
	const body = (await res.json()) as { masterKeyState: string };
	expect(body.masterKeyState).toBe('unlocked');
});
