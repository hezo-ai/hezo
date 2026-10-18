import {
	resetRuntimeConfig,
	runtimeConfig,
	setRuntimeConfig,
} from '@hezo/server/src/config/runtime';
import { deliverSeedBrief } from '@hezo/server/src/services/seed';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// First run, no projects: the home view lands on the CEO
// room full-pane - the greeting, the starter chips, and a live composer. The
// dialog path stays one click away beneath it.
test('lands on the full-pane CEO room on first run, greeting and starter chips included', async () => {
	const { findByTestId, findAllByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {},
	});

	await findByTestId('home-ceo-landing', undefined, { timeout: 15_000 });
	await findByTestId('ceo-landing-greeting', undefined, { timeout: 15_000 });
	const chips = await findAllByTestId('ceo-landing-starter');
	expect(chips.map((c) => c.textContent)).toEqual([
		'Create my first project',
		'What can Hezo do?',
		"I want to import a repo I'm working on",
	]);
	// The composer is the same live chat surface the dock renders.
	await findByTestId('chat-input');
	// The form path is still offered, quietly.
	await findByTestId('ceo-landing-create-project');
});

// A hosted instance's signup brief needs no tap: the server sends it as the
// admin's first message once a model is connected, so the landing opens on that
// conversation rather than on the greeting and its starter chips.
test('opens on the signup brief the server already sent to the CEO', async () => {
	const brief = 'A newsletter for our climbing gym. Weekly route updates and events.';
	setRuntimeConfig({ ...runtimeConfig(), seed: { project: { description: brief } } });
	try {
		const { findByTestId, queryByTestId } = await renderApp({
			initialPath: '/home',
			seed: async (ctx) => {
				expect(await deliverSeedBrief(ctx.db, ctx.chatSessionManager)).toBe(true);
			},
		});

		const messages = await findByTestId('chat-messages', undefined, { timeout: 15_000 });
		await waitFor(() => expect(messages.textContent).toContain(brief), { timeout: 15_000 });
		expect(queryByTestId('ceo-landing-greeting')).toBeNull();
	} finally {
		resetRuntimeConfig();
	}
});
