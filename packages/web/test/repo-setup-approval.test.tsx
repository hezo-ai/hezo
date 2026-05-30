import { screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedTask, seedWorkspace } from './helpers/seed';

interface SeededBlocked {
	ws: SeededWorkspace;
	projectId: string;
	projectSlug: string;
	approvalId: string;
	tasks: Array<{ id: string; identifier: string }>;
}

async function seedBlockedProject(): Promise<SeededBlocked> {
	const { apiBase } = getTestContext();
	const ws = await seedWorkspace();
	const project = await seedProject(ws, {
		name: 'Blocked Project',
		description: 'Project waiting on repo',
	});

	const agentA = ws.agents[0];
	const agentB = ws.agents[1] ?? ws.agents[0];

	const taskA = await seedTask(ws, project, {
		title: 'Migrate to vNext',
		assignee_id: agentA.id,
	});
	const taskB = await seedTask(ws, project, {
		title: 'Add CI workflow',
		assignee_id: agentB.id,
	});
	const tasks = [
		{ id: taskA.id, identifier: taskA.identifier },
		{ id: taskB.id, identifier: taskB.identifier },
	];

	const approvalRes = await apiBase(`/api/teams/${ws.team.id}/approvals`, {
		method: 'POST',
		headers: ws.headers,
		body: JSON.stringify({
			type: 'designated_repo_request',
			payload: {
				platform: 'github',
				reason: 'designated_repo',
				project_id: project.id,
				task_id: taskA.id,
			},
		}),
	});
	const approval = ((await approvalRes.json()) as { data: { id: string } }).data;

	for (const task of tasks) {
		await apiBase(`/api/teams/${ws.team.id}/tasks/${task.id}/comments`, {
			method: 'POST',
			headers: ws.headers,
			body: JSON.stringify({
				content_type: 'action',
				content: { kind: 'setup_repo', approval_id: approval.id },
			}),
		});
	}

	return {
		ws,
		projectId: project.id,
		projectSlug: project.slug,
		approvalId: approval.id,
		tasks,
	};
}

test('inbox card opens popup listing every blocked ticket', async () => {
	let seed!: SeededBlocked;

	const { findAllByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			seed = await seedBlockedProject();
		},
	});

	await router.navigate({
		to: '/teams/$teamId/inbox',
		params: { teamId: seed.ws.team.slug },
	});

	const cards = await findAllByTestId('approval-card', undefined, { timeout: 15_000 });
	expect(cards.length).toBeGreaterThan(0);
	expect(cards.length).toBe(1);

	await user.click(cards[0]);

	// Modal is rendered in a Radix portal — query from document body.
	await screen.findByTestId('repo-setup-approval-modal', undefined, { timeout: 10_000 });
	for (const task of seed.tasks) {
		await screen.findByTestId(`blocked-ticket-${task.identifier}`);
	}
});

test('clicking a ticket row navigates to the comment with a brief highlight', async () => {
	let seed!: SeededBlocked;

	const { findAllByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			seed = await seedBlockedProject();
		},
	});

	await router.navigate({
		to: '/teams/$teamId/inbox',
		params: { teamId: seed.ws.team.slug },
	});

	await findAllByTestId('approval-card', undefined, { timeout: 15_000 });
	// React-Query may flush a second render after the cache hydrates; settle first.
	await new Promise((r) => setTimeout(r, 300));
	const cards = await findAllByTestId('approval-card');
	expect(cards.length).toBeGreaterThan(0);
	await user.click(cards[0]);
	// Wait for portal modal to mount, then for blocked-tickets query to resolve.
	await screen.findByTestId('repo-setup-approval-modal', undefined, { timeout: 10_000 });
	const firstTicket = await screen.findByTestId(
		`blocked-ticket-${seed.tasks[0].identifier}`,
		undefined,
		{ timeout: 10_000 },
	);
	await user.click(firstTicket);

	const expectedPrefix = `/teams/${seed.ws.team.slug}/projects/${seed.projectSlug}/tasks/${seed.tasks[0].identifier.toLowerCase()}`;
	await new Promise((r) => setTimeout(r, 500));
	expect(router.state.location.pathname).toBe(expectedPrefix);
});

test('CTA navigates to the project settings page', async () => {
	let seed!: SeededBlocked;

	const { findAllByTestId, findByRole, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			seed = await seedBlockedProject();
		},
	});

	await router.navigate({
		to: '/teams/$teamId/inbox',
		params: { teamId: seed.ws.team.slug },
	});

	await findAllByTestId('approval-card', undefined, { timeout: 15_000 });
	// Let react-query's render commit settle before interacting.
	await new Promise((r) => setTimeout(r, 300));
	const cards = await findAllByTestId('approval-card');
	expect(cards.length).toBeGreaterThan(0);
	await user.click(cards[0]);

	await screen.findByTestId('repo-setup-approval-modal', undefined, { timeout: 10_000 });
	await user.click(await screen.findByTestId('repo-setup-approval-cta'));

	const expected = `/teams/${seed.ws.team.slug}/projects/${seed.projectSlug}/settings`;
	await new Promise((r) => setTimeout(r, 500));
	expect(router.state.location.pathname).toBe(expected);
	await findByRole('heading', { name: 'GitHub' }, { timeout: 15_000 });
});
