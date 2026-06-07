import { CommentContentType, PROJECT_INTAKE_SKIP_SIGNAL_TEXT } from '@hezo/shared';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

interface IntakeResult {
	intake_task_id: string;
	intake_task_identifier: string;
	approval_id: string;
	project_slug: string;
	team_id: string;
	team_slug: string;
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
	await findByTestId('home-project-intake-skip', undefined, { timeout: 20_000 });
});

// Skip-questions posts a system signal comment on the HQ intake thread and
// hides the skip button for the session; the panel itself stays mounted.
test('skip-questions posts a system comment and hides the skip button', async () => {
	let intake!: IntakeResult;
	const { findByTestId, container, ctx, queryByTestId, user } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			intake = await startIntake(`Home Skip ${Date.now()}`);
		},
	});

	const skipButton = await findByTestId('home-project-intake-skip', undefined, { timeout: 20_000 });
	await user.click(skipButton);

	await waitFor(
		async () => {
			const commentsRes = await ctx.apiBase(
				`/api/projects/${intake.project_slug}/tasks/${intake.intake_task_identifier.toLowerCase()}/comments`,
				{ headers: { Authorization: `Bearer ${ctx.token}` } },
			);
			const body = (await commentsRes.json()) as {
				data: Array<{ content_type: string; content: { text?: string } }>;
			};
			const hasSkip = body.data.some(
				(c) =>
					c.content_type === CommentContentType.System &&
					(c.content.text ?? '') === PROJECT_INTAKE_SKIP_SIGNAL_TEXT,
			);
			expect(hasSkip).toBe(true);
		},
		{ timeout: 15_000 },
	);

	await waitFor(() => expect(queryByTestId('home-project-intake-skip')).toBeNull(), {
		timeout: 15_000,
	});
	// The panel itself is still mounted.
	expect(container.querySelector('[data-testid="home-project-intake"]')).toBeTruthy();
}, 30_000);
