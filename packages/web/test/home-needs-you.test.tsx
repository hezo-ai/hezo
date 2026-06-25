// Coverage for routes/home/index.tsx beyond the active-card dashboard the
// existing home-dashboard spec covers: the "Needs you" section (pending approvals
// of several types + unread admin mentions, the per-type action labels and text,
// the "Show N more" overflow link), the needs-you → Active-card badge, and the
// paused OtherProjectRow state. Approvals + admin mentions are seeded directly in
// the DB (the same way approval-card / inbox-global specs do) and read back
// through the real cross-project aggregation endpoints. Component tier.

import { ApprovalType } from '@hezo/shared';
import { waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	type SeededProject,
	type SeededTask,
	type SeededWorkspace,
	seedProject,
	seedTask,
	seedWorkspace,
} from './helpers/seed';

async function seedApproval(
	ws: SeededWorkspace,
	project: SeededProject,
	type: string,
	requestedByMemberId?: string,
): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`INSERT INTO approvals (team_id, type, status, payload, requested_by_member_id)
		 VALUES ($1, $2::approval_type, 'pending'::approval_status, $3::jsonb, $4)`,
		[ws.team.id, type, JSON.stringify({ project_id: project.id }), requestedByMemberId ?? null],
	);
}

async function seedAdminMention(
	ws: SeededWorkspace,
	task: SeededTask,
	text: string,
): Promise<void> {
	const { db } = getTestContext();
	const author = ws.agents.find((a) => a.slug === 'architect') ?? ws.agents[0];
	const userRow = await db.query<{ user_id: string }>(
		`SELECT mu.user_id FROM member_users mu
		 JOIN members m ON m.id = mu.id
		 WHERE m.team_id = $1 AND mu.role = 'admin' LIMIT 1`,
		[ws.team.id],
	);
	const userId = userRow.rows[0]?.user_id;
	if (!userId) throw new Error('no admin user on team');
	const commentRow = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb) RETURNING id`,
		[task.id, author.id, JSON.stringify({ text })],
	);
	await db.query(
		`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id)
		 VALUES ($1, $2, $3, $4)`,
		[ws.team.id, task.id, commentRow.rows[0].id, userId],
	);
}

test('the Needs-you section lists a pending approval with its type-specific text and action label', async () => {
	const ref = { agentTitle: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Approvals Home' });
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			ref.agentTitle = captain.title;
			await seedApproval(ws, project, ApprovalType.PlanReview, captain.id);
		},
	});

	await router.navigate({ to: '/home' });

	const section = await findByTestId('home-needs-you', undefined, { timeout: 20_000 });
	// PlanReview → "<who> drafted a plan to review" + an "Open plan" action.
	expect(section.textContent).toContain('drafted a plan to review');
	const row = await findByTestId('home-needs-you-row');
	expect(within(row).getByRole('link').textContent).toBe('Open plan');
});

test('a designated-repo-request approval surfaces the GitHub-access text and "Set up" action', async () => {
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Repo Approval Home' });
			// No requested_by_member_id → the "An agent" fallback in approvalText.
			await seedApproval(ws, project, ApprovalType.DesignatedRepoRequest);
		},
	});

	await router.navigate({ to: '/home' });

	const section = await findByTestId('home-needs-you', undefined, { timeout: 20_000 });
	expect(section.textContent).toContain('An agent');
	expect(section.textContent).toContain('needs GitHub access to set up the repo');
	const row = await findByTestId('home-needs-you-row');
	expect(within(row).getByRole('link').textContent).toBe('Set up');
});

test('an unread admin mention renders as a mention row linking to the comment with a Reply action', async () => {
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Mention Home' });
			const task = await seedTask(ws, project, { title: 'Decision Ticket' });
			await seedAdminMention(ws, task, '@admin please confirm the rollout window.');
		},
	});

	await router.navigate({ to: '/home' });

	const section = await findByTestId('home-needs-you', undefined, { timeout: 20_000 });
	expect(section.textContent).toContain('please confirm the rollout window');
	const row = await findByTestId('home-needs-you-row');
	const link = within(row).getByRole('link');
	expect(link.textContent).toBe('Reply');
	expect(link.getAttribute('href')).toContain('#comment-');
});

test('more than five needs-you items collapse behind a "Show N more" link to the inbox', async () => {
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Overflow Home' });
			// Seed 7 pending approvals → 5 shown, "Show 2 more".
			for (let i = 0; i < 7; i++) {
				await seedApproval(ws, project, ApprovalType.Hire);
			}
		},
	});

	await router.navigate({ to: '/home' });

	const section = await findByTestId('home-needs-you', undefined, { timeout: 20_000 });
	// The heading counts all 7.
	expect(section.textContent).toContain('Needs you · 7');
	const more = await findByTestId('home-needs-you-more');
	expect(more.textContent).toContain('Show 2 more');
	expect(more.getAttribute('href')).toBe('/home/inbox');
});

test('a project with pending needs-you items ranks as Active and the card shows the "N need you" badge', async () => {
	const ref = { name: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Needs You Card' });
			ref.name = project.name;
			await seedApproval(ws, project, ApprovalType.Strategy);
			await seedApproval(ws, project, ApprovalType.ProjectCreation);
		},
	});

	await router.navigate({ to: '/home' });

	// Two pending approvals on the project → it lands in Active with a "2 need you".
	const active = await findByTestId('home-active', undefined, { timeout: 20_000 });
	expect(active.textContent).toContain(ref.name);
	const card = await findByTestId('home-active-card');
	expect(card.textContent).toContain('2 need you');
});

test('an idle project with a stopped container renders as a paused Other-projects row', async () => {
	const ref = { name: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Paused Project' });
			ref.name = project.name;
			// Stopped container, no running agents, no needs-you → an "Other" paused row.
			await getTestContext().db.query(
				`UPDATE projects SET container_status = 'stopped' WHERE id = $1`,
				[project.id],
			);
		},
	});

	await router.navigate({ to: '/home' });

	const other = await findByTestId('home-other', undefined, { timeout: 20_000 });
	const row = await waitFor(() => {
		const el = within(other).getByTestId('home-other-row');
		return el;
	});
	expect(row.textContent).toContain(ref.name);
	expect(row.textContent).toContain('paused');
});
