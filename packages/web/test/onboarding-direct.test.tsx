import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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

test('direct onboarding creates the first project in its own new team', async () => {
	const projectName = 'My First App';
	let seededSlug = '';
	let newTeamSlug = '';
	const { findAllByText, container, ctx } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const { apiBase, token } = getTestContext();
			const headers = {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			};
			const team = await createBlankTeam(`Onboard Direct ${Date.now()}`);
			seededSlug = team.slug;
			sessionStorage.setItem('hezo:activeTeamSlug', seededSlug);
			const blankId = await fetchBlankTemplateId();
			const directRes = await apiBase(`/api/projects/internal-${seededSlug}/onboarding/direct`, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					template_id: blankId,
					project_name: projectName,
					project_description: 'A test project from the direct flow.',
				}),
			});
			expect(directRes.status).toBe(201);
			const body = (await directRes.json()) as { data: { team_slug: string } };
			newTeamSlug = body.data.team_slug;
			// The project gets its own team, distinct from the (HQ/seeded) team.
			expect(newTeamSlug).not.toBe(seededSlug);
		},
	});

	// The cross-team home project list surfaces the new project.
	const matches = await findAllByText(projectName, undefined, { timeout: 20_000 });
	expect(matches.length).toBeGreaterThan(0);
	expect(container.querySelector('[data-testid="home-projects-list"]')).toBeTruthy();

	// The project landed in the NEW team, not the seeded/HQ team. The global
	// projects index carries team_slug, so membership is read from there.
	const allProjects = (await (
		await ctx.apiBase('/api/projects', {
			headers: { Authorization: `Bearer ${ctx.token}` },
		})
	).json()) as { data: Array<{ name: string; team_slug: string }> };
	const created = allProjects.data.find((p) => p.name === projectName);
	expect(created).toBeTruthy();
	expect(created!.team_slug).toBe(newTeamSlug);
	expect(created!.team_slug).not.toBe(seededSlug);
}, 30_000);

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

	const choiceDirect = await findByTestId('choice-direct', undefined, { timeout: 15_000 });
	await user.click(within(choiceDirect).getByRole('button', { name: 'Browse templates' }));

	await findByTestId('direct-flow-pick', undefined, { timeout: 15_000 });
	const blankCard = await findByTestId('template-card-Blank');
	await user.click(blankCard);

	await findByTestId('direct-flow-confirm', undefined, { timeout: 15_000 });

	const nameInput = (await findByLabelText('Project name')) as HTMLInputElement;
	fireEvent.change(nameInput, { target: { value: projectName } });

	const submitBtn = await findByRole('button', { name: /Add these agents and create project/ });
	await user.click(submitBtn);

	// The first project gets its own team named after it, so both the team slug
	// and the project slug derive from the project name.
	const expected = /^\/projects\/direct-ui-[0-9]+\/tasks\/[a-z0-9-]+$/;
	await waitFor(
		() => {
			expect(router.state.location.pathname).toMatch(expected);
		},
		{ timeout: 30_000 },
	);
	expect(container).toBeTruthy();
}, 40_000);

test('onboarding "Chat with the Captain" opens the create-project-with-team dialog', async () => {
	const { findByTestId, user } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const team = await createBlankTeam(`Onboard Chat ${Date.now()}`);
			sessionStorage.setItem('hezo:activeTeamSlug', team.slug);
		},
	});

	const choiceChat = await findByTestId('choice-chat', undefined, { timeout: 15_000 });
	await user.click(within(choiceChat).getByRole('button', { name: 'Start chat' }));

	// The Captain-scoped path reuses the project-with-team dialog (its own team +
	// Captain intake), so HQ stays CEO-only. Dialog renders into a portal.
	await screen.findByTestId('create-project-submit');
	expect(screen.getByText('Team type')).toBeTruthy();
});

test('the first-time choice screen no longer exposes a "general help" escape hatch', async () => {
	const { findByTestId, container } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const team = await createBlankTeam(`Onboard Choice ${Date.now()}`);
			sessionStorage.setItem('hezo:activeTeamSlug', team.slug);
		},
	});

	await findByTestId('onboarding-choice', undefined, { timeout: 15_000 });

	expect(container.querySelector('[data-testid="choice-general"]')).toBeNull();
	expect(container.querySelector('[data-testid="choice-chat"]')).toBeTruthy();
	expect(container.querySelector('[data-testid="choice-direct"]')).toBeTruthy();
});
