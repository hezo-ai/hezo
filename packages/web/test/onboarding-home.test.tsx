import {
	resetRuntimeConfig,
	runtimeConfig,
	setRuntimeConfig,
} from '@hezo/server/src/config/runtime';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

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

// A hosted instance's signup brief is offered on the landing as a one-tap first
// message: a greeting that names it, and a chip ahead of the usual starters
// that sends the brief, under a lead line, as the admin's own message.
test('offers the signup brief as a one-tap first message', async () => {
	const brief = 'A newsletter for our climbing gym. Weekly route updates and events.';
	setRuntimeConfig({ ...runtimeConfig(), seed: { project: { description: brief } } });
	try {
		const { findByTestId, findByText, user } = await renderApp({
			initialPath: '/home',
			seed: async () => {},
		});

		await findByText(/When you signed up, you wrote a short brief/, undefined, {
			timeout: 15_000,
		});
		await user.click(await findByTestId('ceo-landing-seed-brief'));

		const expected = `Here is the brief I wrote when I signed up:\n\n${brief}`;
		await waitFor(
			async () => {
				const rows = await getTestContext().db.query(
					`SELECT id FROM chat_messages WHERE role = 'user' AND content = $1`,
					[expected],
				);
				expect((rows as { rows: unknown[] }).rows.length).toBe(1);
			},
			{ timeout: 15_000 },
		);
	} finally {
		resetRuntimeConfig();
	}
});
