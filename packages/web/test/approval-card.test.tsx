import { waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	type SeededProject,
	type SeededWorkspace,
	seedProject,
	seedTask,
	seedWorkspace,
} from './helpers/seed';

// Component tier (happy-dom). ApprovalCard is rendered through the real inbox
// (`/projects/$projectId/inbox` for showTeam=false, `/home/inbox` for
// showTeam=true). We seed approval rows directly so we can control `status`,
// `resolution_note`, and the typed `payload` that drives each ApprovalMessage
// branch — the approvals GET route enriches them with payload_* JOINs.
//
// inbox-approvals.test.tsx already covers the strategy/hire happy paths and
// approve/deny; this file targets the message-branch and resolved/read-only
// states that those don't reach.

/** Insert an approval row directly (lets us set status + resolution_note). */
async function insertApproval(
	ws: SeededWorkspace,
	input: {
		type: string;
		payload: Record<string, unknown>;
		status?: 'pending' | 'approved' | 'denied';
		resolutionNote?: string | null;
		requestedByMemberId?: string | null;
	},
): Promise<{ id: string }> {
	const { db } = getTestContext();
	const res = await db.query<{ id: string }>(
		`INSERT INTO approvals (team_id, type, status, payload, resolution_note, requested_by_member_id)
		 VALUES ($1, $2::approval_type, $3::approval_status, $4::jsonb, $5, $6)
		 RETURNING id`,
		[
			ws.team.id,
			input.type,
			input.status ?? 'pending',
			JSON.stringify(input.payload),
			input.resolutionNote ?? null,
			input.requestedByMemberId ?? null,
		],
	);
	return res.rows[0];
}

interface Ctx {
	ws: SeededWorkspace;
	project: SeededProject;
	projectSlug: string;
	projectId: string;
}

/** Seed a workspace + named project, run `build`, then open the team inbox. */
async function renderTeamInbox(build: (ctx: Ctx) => Promise<void>) {
	const ref: { projectSlug: string } = { projectSlug: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Approval Project' });
			ref.projectSlug = project.slug;
			await build({ ws, project, projectSlug: project.slug, projectId: project.id });
		},
	});
	await helpers.router.navigate({
		to: '/projects/$projectId/inbox',
		params: { projectId: ref.projectSlug },
	});
	return { ...helpers, ref };
}

test('a skill-proposal approval renders its message and reason', async () => {
	const { findByText } = await renderTeamInbox(async ({ ws }) => {
		await insertApproval(ws, {
			type: 'skill_proposal',
			payload: { skill_name: 'Deploy Helper', reason: 'Speeds up rollouts' },
		});
	});

	await findByText(/Proposing new skill/, undefined, { timeout: 15_000 });
	await findByText(/Deploy Helper/);
	await findByText('Speeds up rollouts');
});

test('a plan-review approval renders its message and reason', async () => {
	const { findByText } = await renderTeamInbox(async ({ ws }) => {
		await insertApproval(ws, {
			type: 'plan_review',
			payload: { reason: 'Plan ready for sign-off' },
		});
	});

	await findByText('Requesting plan review', undefined, { timeout: 15_000 });
	await findByText('Plan ready for sign-off');
});

test('a deploy-production approval names the target environment', async () => {
	const { findByText } = await renderTeamInbox(async ({ ws }) => {
		await insertApproval(ws, {
			type: 'deploy_production',
			payload: { target: 'prod-eu', reason: 'Release 1.4' },
		});
	});

	await findByText('Requesting deploy to', undefined, { timeout: 15_000 });
	await findByText('prod-eu');
	await findByText('Release 1.4');
});

test('a resolved (approved) approval is read-only history: status badge, resolution note, no buttons', async () => {
	const { findByText, queryByRole } = await renderTeamInbox(async ({ ws }) => {
		await insertApproval(ws, {
			type: 'strategy',
			payload: { plan: 'Old launch plan' },
			status: 'approved',
			resolutionNote: 'Looks good, proceed.',
		});
	});

	await findByText('Old launch plan', undefined, { timeout: 15_000 });
	// Resolved approvals show the status badge + resolution note.
	await findByText('approved');
	await findByText(/Looks good, proceed\./);
	// No action buttons on a resolved card.
	expect(queryByRole('button', { name: 'Approve' })).toBeNull();
	expect(queryByRole('button', { name: 'Deny' })).toBeNull();
});

test('a denied approval shows a red denied badge', async () => {
	const { findByText } = await renderTeamInbox(async ({ ws }) => {
		await insertApproval(ws, {
			type: 'strategy',
			payload: { plan: 'Rejected plan' },
			status: 'denied',
			resolutionNote: 'Not now.',
		});
	});

	await findByText('Rejected plan', undefined, { timeout: 15_000 });
	await findByText('denied');
	await findByText(/Not now\./);
});

test('a pending hire approval with a task link renders an Edit & review action and the task link', async () => {
	const { findByTestId, findAllByTestId } = await renderTeamInbox(
		async ({ ws, project, projectId }) => {
			const task = await seedTask(ws, project, { title: 'Hire context task' });
			await insertApproval(ws, {
				type: 'hire',
				payload: {
					title: 'New Researcher',
					project_id: projectId,
					task_id: task.id,
				},
			});
		},
	);

	// The hire card is unread → shows the "Edit & review" link.
	const edit = await findByTestId('approval-edit', undefined, { timeout: 15_000 });
	expect(edit.textContent).toContain('Edit & review');

	// The hire message links to the originating task.
	const cards = await findAllByTestId('approval-card');
	const hireCard = cards.find((c) => /Proposing to hire/.test(c.textContent ?? ''));
	expect(hireCard).toBeTruthy();
	const taskLink = within(hireCard as HTMLElement)
		.getAllByRole('link')
		.find((a) => /\/tasks\//.test(a.getAttribute('href') ?? ''));
	expect(taskLink).toBeTruthy();
	expect(taskLink?.getAttribute('href')).toMatch(/\/tasks\//);
});

test('a designated-repo request with reason repo_add links to project settings', async () => {
	const { findAllByTestId } = await renderTeamInbox(async ({ ws, projectId }) => {
		await insertApproval(ws, {
			type: 'designated_repo_request',
			payload: {
				platform: 'GitHub',
				reason: 'repo_add',
				project_id: projectId,
			},
		});
	});

	const cards = await findAllByTestId('approval-card', undefined, { timeout: 15_000 });
	const repoCard = cards.find((c) => /Requesting GitHub OAuth/.test(c.textContent ?? ''));
	expect(repoCard).toBeTruthy();
	// The whole card is a Link to the project settings page for repo_add.
	expect((repoCard as HTMLElement).getAttribute('href')).toContain('/settings');
	expect(repoCard?.textContent).toContain('add a repo to');
});

test('a designated-repo request with no reason links to the team general settings', async () => {
	const { findAllByTestId } = await renderTeamInbox(async ({ ws }) => {
		await insertApproval(ws, {
			type: 'designated_repo_request',
			payload: { platform: 'GitHub' },
		});
	});

	const cards = await findAllByTestId('approval-card', undefined, { timeout: 15_000 });
	const repoCard = cards.find((c) => /Requesting GitHub OAuth to access/.test(c.textContent ?? ''));
	expect(repoCard).toBeTruthy();
	expect((repoCard as HTMLElement).getAttribute('href')).toContain('/team-settings/general');
});

test('an approval type with no dedicated message branch falls back to the de-underscored type label', async () => {
	const { findAllByText } = await renderTeamInbox(async ({ ws }) => {
		await insertApproval(ws, {
			type: 'project_creation',
			payload: {},
		});
	});

	// project_creation has no dedicated ApprovalMessage branch → default label
	// (`type.replace(/_/g,' ')`). seedWorkspace also seeds a resolved
	// project_creation approval, so there may be more than one such card; the
	// default-branch rendering is proven by at least one being present.
	const labels = await findAllByText('project creation', undefined, { timeout: 15_000 });
	expect(labels.length).toBeGreaterThanOrEqual(1);
});

test('the global inbox shows the team name on each card (showTeam)', async () => {
	const seededTeamName: { name: string } = { name: '' };
	const { findAllByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Global Approval Project' });
			void project;
			// Read the team's display name to assert it surfaces on the card.
			const { db } = getTestContext();
			const r = await db.query<{ name: string }>(`SELECT name FROM teams WHERE id = $1`, [
				ws.team.id,
			]);
			seededTeamName.name = r.rows[0].name;
			await insertApproval(ws, {
				type: 'strategy',
				payload: { plan: 'Global-scope plan' },
			});
		},
	});

	await router.navigate({ to: '/home/inbox' });

	const cards = await findAllByTestId('approval-card', undefined, { timeout: 15_000 });
	const planCard = cards.find((c) => /Global-scope plan/.test(c.textContent ?? ''));
	expect(planCard).toBeTruthy();
	await waitFor(() => expect(planCard?.textContent).toContain(seededTeamName.name));
});
