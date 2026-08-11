// Both dashboards head their action-item list with a link to an inbox, so they
// list exactly that inbox's *unread* rows - never one it cannot show, and never
// one the admin has already read. Each spec seeds the same three shapes (a
// pending approval, an unread @admin mention, and an unanswered credential
// request) and checks the dashboard, the inbox, and what reading a row does to
// each. Component tier: no layout, viewport or WebSocket behaviour involved.

import { ApprovalType } from '@hezo/shared';
import { waitFor } from '@testing-library/react';
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

const CREDENTIAL_NAME = 'PARITY_API_KEY';

async function adminUserId(ws: SeededWorkspace): Promise<string> {
	const { db } = getTestContext();
	const row = await db.query<{ user_id: string }>(
		`SELECT mu.user_id FROM member_users mu
		 JOIN members m ON m.id = mu.id
		 WHERE m.team_id = $1 AND mu.role = 'admin' LIMIT 1`,
		[ws.team.id],
	);
	const userId = row.rows[0]?.user_id;
	if (!userId) throw new Error('no admin user on team');
	return userId;
}

async function seedApproval(ws: SeededWorkspace, project: SeededProject): Promise<void> {
	const { db } = getTestContext();
	const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
	await db.query(
		`INSERT INTO approvals (team_id, type, status, payload, requested_by_member_id)
		 VALUES ($1, $2::approval_type, 'pending'::approval_status, $3::jsonb, $4)`,
		[ws.team.id, ApprovalType.PlanReview, JSON.stringify({ project_id: project.id }), captain.id],
	);
}

/** Post a comment and raise the inbox row for it, as the server does. */
async function seedInboxComment(
	ws: SeededWorkspace,
	task: SeededTask,
	contentType: 'text' | 'credential_request',
	content: object,
): Promise<void> {
	const { db } = getTestContext();
	const author = ws.agents.find((a) => a.slug === 'architect') ?? ws.agents[0];
	const comment = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb) RETURNING id`,
		[task.id, author.id, contentType, JSON.stringify(content)],
	);
	await db.query(
		`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id) VALUES ($1, $2, $3, $4)`,
		[ws.team.id, task.id, comment.rows[0].id, await adminUserId(ws)],
	);
}

async function seedAllThree(): Promise<{ slug: string }> {
	const ws = await seedWorkspace();
	const project = await seedProject(ws, { name: 'Parity Project' });
	const task = await seedTask(ws, project, { title: 'Parity work' });
	await seedApproval(ws, project);
	await seedInboxComment(ws, task, 'text', { text: '@admin please confirm the rollout window.' });
	await seedInboxComment(ws, task, 'credential_request', {
		name: CREDENTIAL_NAME,
		kind: 'api_key',
		instructions: 'Paste the key from the provider dashboard.',
	});
	return { slug: project.slug };
}

test('the project dashboard lists exactly the unread rows its inbox shows', async () => {
	const ref = { slug: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ref.slug = (await seedAllThree()).slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/dashboard',
		params: { projectId: ref.slug },
	});

	const section = await findByTestId('project-dashboard-needs-you', undefined, {
		timeout: 20_000,
	});
	await waitFor(() => expect(section.textContent).toContain('Action items · 3'));
	expect(section.querySelectorAll('[data-testid="project-dashboard-needs-you-row"]')).toHaveLength(
		3,
	);
	expect(section.textContent).toContain('drafted a plan to review');
	expect(section.textContent).toContain('please confirm the rollout window');
	// The credential request reads as what it asks for, with its own control.
	expect(section.textContent).toContain(`provide ${CREDENTIAL_NAME}`);
	expect(section.textContent).toContain('Provide');

	await router.navigate({
		to: '/projects/$projectId/inbox',
		params: { projectId: ref.slug },
	});

	await findByTestId('approval-card', undefined, { timeout: 20_000 });
	await waitFor(() => {
		expect(document.body.querySelectorAll('[data-testid="approval-card"]')).toHaveLength(1);
		expect(document.body.querySelectorAll('[data-testid="mention-card"]')).toHaveLength(2);
	});
	expect(document.body.textContent).toContain(`provide ${CREDENTIAL_NAME}`);
	expect(document.body.textContent).toContain('credential');
});

test('reading a credential request in the inbox drops it from the dashboard', async () => {
	const ref = { slug: '' };
	const { findByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ref.slug = (await seedAllThree()).slug;
		},
	});

	// Warm the dashboard's cache first, so the assertion below turns on the read
	// mutation invalidating it rather than on a first fetch happening to be late.
	await router.navigate({
		to: '/projects/$projectId/dashboard',
		params: { projectId: ref.slug },
	});
	const warm = await findByTestId('project-dashboard-needs-you', undefined, { timeout: 20_000 });
	await waitFor(() => expect(warm.textContent).toContain('Action items · 3'));

	await router.navigate({
		to: '/projects/$projectId/inbox',
		params: { projectId: ref.slug },
	});

	await findByTestId('approval-card', undefined, { timeout: 20_000 });
	const credentialCard = await waitFor(() => {
		const card = [...document.body.querySelectorAll('[data-testid="mention-card"]')].find((el) =>
			el.textContent?.includes(CREDENTIAL_NAME),
		);
		if (!card) throw new Error('credential card not rendered yet');
		return card;
	});
	await user.click(credentialCard);

	await router.navigate({
		to: '/projects/$projectId/dashboard',
		params: { projectId: ref.slug },
	});

	const section = await findByTestId('project-dashboard-needs-you', undefined, {
		timeout: 20_000,
	});
	// Read, so off the action items — the approval and the mention remain.
	await waitFor(() => expect(section.textContent).toContain('Action items · 2'));
	expect(section.textContent).not.toContain(CREDENTIAL_NAME);

	// Still in the inbox, under All rather than Unread.
	await router.navigate({
		to: '/projects/$projectId/inbox',
		params: { projectId: ref.slug },
	});
	const all = await waitFor(() => {
		const pill = [...document.body.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'All',
		);
		if (!pill) throw new Error('All filter not rendered yet');
		return pill;
	});
	await user.click(all);
	await waitFor(() => expect(document.body.textContent).toContain(CREDENTIAL_NAME));
});

test('the global dashboard lists exactly the unread rows the global inbox shows', async () => {
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			await seedAllThree();
		},
	});

	await router.navigate({ to: '/home' });

	const section = await findByTestId('home-needs-you', undefined, { timeout: 20_000 });
	await waitFor(() => expect(section.textContent).toContain('Needs you · 3'));
	expect(section.querySelectorAll('[data-testid="home-needs-you-row"]')).toHaveLength(3);
	expect(section.textContent).toContain(`provide ${CREDENTIAL_NAME}`);

	await router.navigate({ to: '/home/inbox' });

	await findByTestId('approval-card', undefined, { timeout: 20_000 });
	await waitFor(() => {
		expect(document.body.querySelectorAll('[data-testid="approval-card"]')).toHaveLength(1);
		expect(document.body.querySelectorAll('[data-testid="mention-card"]')).toHaveLength(2);
	});
	expect(document.body.textContent).toContain(`provide ${CREDENTIAL_NAME}`);
});
