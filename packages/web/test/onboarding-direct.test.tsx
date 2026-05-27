import { fireEvent, waitFor, within } from '@testing-library/react';
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

test('applies a template and creates a project from the wizard direct path', async () => {
	const projectName = 'My First App';
	let teamSlug = '';
	const { findByText, container, ctx, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const { apiBase, token } = getTestContext();
			const headers = {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			};
			const team = await createBlankTeam(`Onboard Direct ${Date.now()}`);
			teamSlug = team.slug;
			sessionStorage.setItem('hezo:activeTeamSlug', teamSlug);
			const blankId = await fetchBlankTemplateId();
			const directRes = await apiBase(`/api/teams/${teamSlug}/onboarding/direct`, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					template_id: blankId,
					project_name: projectName,
					project_description: 'A test project from the direct flow.',
				}),
			});
			expect(directRes.status).toBe(201);
		},
	});

	await waitFor(
		() => {
			const projectsList = container.querySelector('[data-testid="home-projects-list"]');
			expect(projectsList).toBeTruthy();
		},
		{ timeout: 20_000 },
	);
	await findByText(projectName, undefined, { timeout: 20_000 });

	// Sanity-check the row landed in the API as well.
	const projectsRes = await ctx.apiBase(`/api/teams/${teamSlug}/projects`, {
		headers: { Authorization: `Bearer ${ctx.token}` },
	});
	const projects = (await projectsRes.json()) as { data: Array<{ name: string }> };
	expect(projects.data.some((p) => p.name === projectName)).toBe(true);
	expect(router.state.location.pathname).toBe('/home');
});

test("the wizard navigates straight to Captain's planning task after creation", async () => {
	const projectName = `Direct UI ${Date.now()}`;
	let teamSlug = '';
	const { findByTestId, findByLabelText, findByRole, container, user, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const team = await createBlankTeam(`Onboard Direct UI ${Date.now()}`);
			teamSlug = team.slug;
			sessionStorage.setItem('hezo:activeTeamSlug', teamSlug);
		},
	});

	const choiceDirect = await findByTestId('choice-direct', { timeout: 15_000 });
	await user.click(within(choiceDirect).getByRole('button', { name: 'Browse templates' }));

	await findByTestId('direct-flow-pick', { timeout: 15_000 });
	const blankCard = await findByTestId('template-card-Blank');
	await user.click(blankCard);

	await findByTestId('direct-flow-confirm', { timeout: 15_000 });

	const nameInput = (await findByLabelText('Project name')) as HTMLInputElement;
	fireEvent.change(nameInput, { target: { value: projectName } });

	const submitBtn = await findByRole('button', { name: /Add these agents and create project/ });
	await user.click(submitBtn);

	const expected = new RegExp(`^/teams/${teamSlug}/projects/direct-ui-[0-9]+/tasks/[a-z0-9-]+$`);
	await waitFor(
		() => {
			expect(router.state.location.pathname).toMatch(expected);
		},
		{ timeout: 30_000 },
	);
	expect(container).toBeTruthy();
});

test('the first-time choice screen no longer exposes a "general help" escape hatch', async () => {
	const { findByTestId, container } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const team = await createBlankTeam(`Onboard Choice ${Date.now()}`);
			sessionStorage.setItem('hezo:activeTeamSlug', team.slug);
		},
	});

	await findByTestId('onboarding-choice', { timeout: 15_000 });

	expect(container.querySelector('[data-testid="choice-general"]')).toBeNull();
	expect(container.querySelector('[data-testid="choice-chat"]')).toBeTruthy();
	expect(container.querySelector('[data-testid="choice-direct"]')).toBeTruthy();
});
