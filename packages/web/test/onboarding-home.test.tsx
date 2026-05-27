import { fireEvent, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

interface TeamTemplateListResponse {
	data: Array<{ id: string; name: string }>;
}

async function fetchBlankTemplateId(): Promise<string> {
	const { apiBase, token } = getTestContext();
	const res = await apiBase('/api/team-templates', {
		headers: { Authorization: `Bearer ${token}` },
	});
	const body = (await res.json()) as TeamTemplateListResponse;
	const blank = body.data.find((t) => t.name === 'Blank');
	if (!blank) throw new Error('Blank template missing');
	return blank.id;
}

async function createBlankTeam(name: string): Promise<{ id: string; slug: string }> {
	const { apiBase, token } = getTestContext();
	const headers = {
		Authorization: `Bearer ${token}`,
		'Content-Type': 'application/json',
	};
	const blankId = await fetchBlankTemplateId();
	const res = await apiBase('/api/teams', {
		method: 'POST',
		headers,
		body: JSON.stringify({ name, template_id: blankId }),
	});
	const body = (await res.json()) as { data: { id: string; slug: string } };
	return body.data;
}

async function ensureIntake(teamSlug: string): Promise<{ task_identifier: string }> {
	const { apiBase, token } = getTestContext();
	const res = await apiBase(`/api/teams/${teamSlug}/onboarding-intake?ensure=true`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	expect(res.ok).toBe(true);
	const body = (await res.json()) as { data: { task_identifier: string } };
	return body.data;
}

test('shows the welcome card with the intake stage pending until the user opts in', async () => {
	const { findByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const team = await createBlankTeam(`Onboard Home ${Date.now()}`);
			sessionStorage.setItem('hezo:activeTeamSlug', team.slug);
		},
	});

	await findByTestId('home-welcome-card', { timeout: 15_000 });
	await findByTestId('onboarding-progress', { timeout: 15_000 });
	await findByTestId('onboarding-stage-intake', { timeout: 15_000 });
});

test('renders the Captain chat panel once the onboarding-intake ticket exists', async () => {
	const { findByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const team = await createBlankTeam(`Onboard Chat ${Date.now()}`);
			sessionStorage.setItem('hezo:activeTeamSlug', team.slug);
			await ensureIntake(team.slug);
		},
	});

	await findByTestId('home-captain-intake', { timeout: 20_000 });
	await findByTestId('home-captain-intake-skip', { timeout: 20_000 });
});

test('Skip-questions button posts a system comment and hides itself for the session', async () => {
	let teamSlug = '';
	let taskIdentifier = '';
	const { findByTestId, container, ctx, queryByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const team = await createBlankTeam(`Onboard Skip ${Date.now()}`);
			teamSlug = team.slug;
			sessionStorage.setItem('hezo:activeTeamSlug', teamSlug);
			const intake = await ensureIntake(teamSlug);
			taskIdentifier = intake.task_identifier;
		},
	});

	const skipButton = await findByTestId('home-captain-intake-skip', { timeout: 20_000 });
	fireEvent.click(skipButton);

	await waitFor(
		async () => {
			const commentsRes = await ctx.apiBase(
				`/api/teams/${teamSlug}/tasks/${taskIdentifier.toLowerCase()}/comments`,
				{ headers: { Authorization: `Bearer ${ctx.token}` } },
			);
			const body = (await commentsRes.json()) as {
				data: Array<{ content_type: string; content: { text?: string } }>;
			};
			const hasSkip = body.data.some(
				(c) => c.content_type === 'system' && (c.content.text ?? '').toLowerCase().includes('skip'),
			);
			expect(hasSkip).toBe(true);
		},
		{ timeout: 15_000 },
	);

	await waitFor(
		() => {
			expect(queryByTestId('home-captain-intake-skip')).toBeNull();
		},
		{ timeout: 15_000 },
	);
	// Ensure the panel itself is still mounted.
	expect(container.querySelector('[data-testid="home-captain-intake"]')).toBeTruthy();
});
