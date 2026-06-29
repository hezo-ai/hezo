import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

// Component tier (happy-dom). The CEO-assisted intake panel surfaces on the
// home view while no user-facing project exists. We open a real intake via the
// API, navigate home, and exercise the panel: the Send button is disabled until
// the textarea has non-whitespace, typing enables it, and submitting posts a
// comment to the HQ intake thread. The "Open full thread" link target is also
// asserted.

interface IntakeResult {
	intake_task_identifier: string;
	project_slug: string;
}

async function openIntakeHome() {
	const helpers = await renderApp({ initialPath: '/', seed: async () => {} });
	const ctx = getTestContext();
	const headers = { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' };

	const res = await ctx.apiBase('/api/project-intakes', {
		method: 'POST',
		headers,
		body: JSON.stringify({
			name: `Portal ${Math.random().toString(36).slice(2, 7)}`,
			description: 'A self-serve portal.',
		}),
	});
	const intake = ((await res.json()) as { data: IntakeResult }).data;

	await helpers.router.navigate({ to: '/home' });
	const panel = await helpers.findByTestId('home-project-intake', undefined, { timeout: 15_000 });
	return { ...helpers, intake, panel, ctx, headers };
}

test('Send is disabled until the message has content, then enabled', async () => {
	const { panel, getByRole, user } = await openIntakeHome();

	const textarea = panel.querySelector(
		'[data-testid="home-project-intake-input"]',
	) as HTMLTextAreaElement;
	const sendBtn = getByRole('button', { name: /Send/ }) as HTMLButtonElement;

	// Empty → disabled.
	expect(sendBtn.disabled).toBe(true);

	// Whitespace only → still disabled (the guard trims).
	await user.type(textarea, '   ');
	expect(sendBtn.disabled).toBe(true);

	await user.type(textarea, 'Build me a portal');
	await waitFor(() => expect(sendBtn.disabled).toBe(false));
});

test('submitting posts the message to the intake thread and clears the input', async () => {
	const { panel, getByRole, user, intake, ctx, headers } = await openIntakeHome();

	const textarea = panel.querySelector(
		'[data-testid="home-project-intake-input"]',
	) as HTMLTextAreaElement;

	await user.type(textarea, 'Scope: subscription management.');
	await user.click(getByRole('button', { name: /Send/ }));

	// Input clears optimistically after submit.
	await waitFor(() => expect(textarea.value).toBe(''));

	// The comment lands on the HQ intake task. A user-authored comment stores its
	// body either as a raw string or as `{ text }`, depending on the surface.
	await waitFor(
		async () => {
			const res = await ctx.apiBase(
				`/api/projects/${intake.project_slug}/tasks/${intake.intake_task_identifier.toLowerCase()}/comments`,
				{ headers },
			);
			const body = (await res.json()) as {
				data: Array<{ content: string | { text?: string } }>;
			};
			const matches = body.data.some((c) => {
				const text = typeof c.content === 'string' ? c.content : (c.content.text ?? '');
				return text.includes('subscription management');
			});
			expect(matches).toBe(true);
		},
		{ timeout: 15_000 },
	);
});

test('renders the "Open full thread" link to the intake task', async () => {
	const { panel, intake } = await openIntakeHome();
	const link = panel.querySelector('a') as HTMLAnchorElement;
	expect(link.textContent).toContain('Open full thread');
	expect(link.getAttribute('href')).toContain(
		`/projects/${intake.project_slug}/tasks/${intake.intake_task_identifier.toLowerCase()}`,
	);
});
