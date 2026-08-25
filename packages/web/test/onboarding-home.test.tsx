import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

interface IntakeResult {
	intake_task_id: string;
	intake_task_identifier: string;
	project_slug: string;
}

async function startIntake(name: string): Promise<IntakeResult> {
	const { apiBase, token } = getTestContext();
	const res = await apiBase('/api/project-intakes', {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ name, description: 'Describe the thing we are building.' }),
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { data: IntakeResult }).data;
}

// First run, no projects and no open intake: the home view lands on the CEO
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

// Once a CEO-assisted intake is open (and there are still no user-facing
// projects), the home view surfaces the intake conversation panel instead.
test('renders the CEO intake panel once an open intake exists', async () => {
	const { findByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			await startIntake(`Home Intake ${Date.now()}`);
		},
	});

	await findByTestId('home-project-intake-section', undefined, { timeout: 20_000 });
	await findByTestId('home-project-intake', undefined, { timeout: 20_000 });
	// The conversation composer is present so the admin can reply (and approve) in-thread.
	await findByTestId('home-project-intake-input', undefined, { timeout: 20_000 });
});

// The admin's intake reply must wake the CEO. Since plain comments no longer
// wake the assignee, the panel threads the message to the CEO's greeting so the
// reply path (WakeupSource.Reply) does it — carrying parent_comment_id, no
// legacy wake_assignee flag.
test('sending an intake reply threads to the CEO greeting to wake the CEO', async () => {
	const { findByTestId, findByText, getByRole } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			await startIntake(`Home Intake Reply ${Date.now()}`);
		},
	});

	const input = (await findByTestId('home-project-intake-input', undefined, {
		timeout: 20_000,
	})) as HTMLTextAreaElement;
	// Wait for the CEO greeting to render, so its comment is in the client cache
	// and available as the reply target when we send.
	await findByText(/kicking off a new project/, undefined, { timeout: 20_000 });

	const original = globalThis.fetch;
	const posts: Array<Record<string, unknown>> = [];
	globalThis.fetch = Object.assign(async (i: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof i === 'string' ? i : i.toString();
		if (
			init?.method === 'POST' &&
			/\/tasks\/[^/]+\/comments$/.test(url) &&
			typeof init.body === 'string'
		) {
			try {
				posts.push(JSON.parse(init.body) as Record<string, unknown>);
			} catch {}
		}
		return original(i, init);
	}, original);
	try {
		const user = (await import('@testing-library/user-event')).default.setup({ delay: null });
		await user.type(input, 'Here is what I want to build.');
		await user.click(getByRole('button', { name: 'Send' }));
		await waitFor(() => expect(posts.length).toBeGreaterThanOrEqual(1));
	} finally {
		globalThis.fetch = original;
	}

	expect(posts[0].parent_comment_id).toBeTruthy();
	expect('wake_assignee' in posts[0]).toBe(false);
});
