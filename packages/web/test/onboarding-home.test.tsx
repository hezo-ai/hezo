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
