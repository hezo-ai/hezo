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

// First run, no projects and no open intake: the home view shows the welcome
// card that opens the New-project dialog.
test('shows the welcome card on first run before any project or intake exists', async () => {
	const { findByTestId } = await renderApp({ initialPath: '/home', seed: async () => {} });

	await findByTestId('home-welcome-card', undefined, { timeout: 15_000 });
	await findByTestId('home-welcome-create', undefined, { timeout: 15_000 });
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
