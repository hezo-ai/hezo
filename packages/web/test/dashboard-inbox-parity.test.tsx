// Both dashboards head their action-item list with a link to an inbox, so
// neither may list a row that inbox cannot show. Each spec seeds the same three
// shapes - a pending approval, an unread @admin mention, and a credential
// request nobody has answered - and asserts the dashboard and its inbox land on
// the same two rows, with the credential request in neither. Component tier: no
// layout, viewport or WebSocket behaviour involved.

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

async function seedApproval(ws: SeededWorkspace, project: SeededProject): Promise<void> {
	const { db } = getTestContext();
	const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
	await db.query(
		`INSERT INTO approvals (team_id, type, status, payload, requested_by_member_id)
		 VALUES ($1, $2::approval_type, 'pending'::approval_status, $3::jsonb, $4)`,
		[ws.team.id, ApprovalType.PlanReview, JSON.stringify({ project_id: project.id }), captain.id],
	);
}

async function seedAdminMention(ws: SeededWorkspace, task: SeededTask): Promise<void> {
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
	const comment = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb) RETURNING id`,
		[task.id, author.id, JSON.stringify({ text: '@admin please confirm the rollout window.' })],
	);
	await db.query(
		`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id) VALUES ($1, $2, $3, $4)`,
		[ws.team.id, task.id, comment.rows[0].id, userId],
	);
}

/** A `request_credential` the admin never answered — it lives in its task thread. */
async function seedCredentialRequest(ws: SeededWorkspace, task: SeededTask): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'credential_request'::comment_content_type, $3::jsonb)`,
		[
			task.id,
			ws.agents[0].id,
			JSON.stringify({ name: CREDENTIAL_NAME, kind: 'api_key', instructions: 'Need a key.' }),
		],
	);
}

async function seedAllThree(): Promise<{ slug: string }> {
	const ws = await seedWorkspace();
	const project = await seedProject(ws, { name: 'Parity Project' });
	const task = await seedTask(ws, project, { title: 'Parity work' });
	await seedApproval(ws, project);
	await seedAdminMention(ws, task);
	await seedCredentialRequest(ws, task);
	return { slug: project.slug };
}

test('the project dashboard lists exactly the action items its inbox shows', async () => {
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
	// The approval and the mention — not the credential request, which the inbox
	// this widget links to cannot render.
	await waitFor(() => expect(section.textContent).toContain('Action items · 2'));
	expect(section.querySelectorAll('[data-testid="project-dashboard-needs-you-row"]')).toHaveLength(
		2,
	);
	expect(section.textContent).toContain('drafted a plan to review');
	expect(section.textContent).toContain('please confirm the rollout window');
	expect(section.textContent).not.toContain(CREDENTIAL_NAME);

	await router.navigate({
		to: '/projects/$projectId/inbox',
		params: { projectId: ref.slug },
	});

	await findByTestId('approval-card', undefined, { timeout: 20_000 });
	await waitFor(() => {
		expect(document.body.querySelectorAll('[data-testid="approval-card"]')).toHaveLength(1);
		expect(document.body.querySelectorAll('[data-testid="mention-card"]')).toHaveLength(1);
	});
	expect(document.body.textContent).not.toContain(CREDENTIAL_NAME);
});

test('the global dashboard lists exactly the action items the global inbox shows', async () => {
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			await seedAllThree();
		},
	});

	await router.navigate({ to: '/home' });

	const section = await findByTestId('home-needs-you', undefined, { timeout: 20_000 });
	await waitFor(() => expect(section.textContent).toContain('Needs you · 2'));
	expect(section.querySelectorAll('[data-testid="home-needs-you-row"]')).toHaveLength(2);
	expect(section.textContent).not.toContain(CREDENTIAL_NAME);

	await router.navigate({ to: '/home/inbox' });

	await findByTestId('approval-card', undefined, { timeout: 20_000 });
	await waitFor(() => {
		expect(document.body.querySelectorAll('[data-testid="approval-card"]')).toHaveLength(1);
		expect(document.body.querySelectorAll('[data-testid="mention-card"]')).toHaveLength(1);
	});
	expect(document.body.textContent).not.toContain(CREDENTIAL_NAME);
});
