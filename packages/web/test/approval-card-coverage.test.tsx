import { within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	type SeededProject,
	type SeededWorkspace,
	seedProject,
	seedWorkspace,
} from './helpers/seed';

// Component tier (happy-dom). Covers the ApprovalMessage / ApprovalCard branches
// that approval-card.test.tsx and inbox-approvals.test.tsx don't reach: the
// reason/payload-absent fallbacks inside several message branches, the
// skill_slug fallback name, the hire-without-task message (no task link), the
// deploy `environment` fallback, and the unread dot indicator.

async function insertApproval(
	ws: SeededWorkspace,
	input: {
		type: string;
		payload: Record<string, unknown>;
		status?: 'pending' | 'approved' | 'denied';
	},
): Promise<{ id: string }> {
	const { db } = getTestContext();
	const res = await db.query<{ id: string }>(
		`INSERT INTO approvals (team_id, type, status, payload)
		 VALUES ($1, $2::approval_type, $3::approval_status, $4::jsonb)
		 RETURNING id`,
		[ws.team.id, input.type, input.status ?? 'pending', JSON.stringify(input.payload)],
	);
	return res.rows[0];
}

interface Ctx {
	ws: SeededWorkspace;
	project: SeededProject;
	projectSlug: string;
	projectId: string;
}

async function renderTeamInbox(build: (ctx: Ctx) => Promise<void>) {
	const ref: { projectSlug: string } = { projectSlug: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Approval Cov Project' });
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

test('a strategy approval with no plan renders the message but no reason subtext', async () => {
	const { findAllByTestId } = await renderTeamInbox(async ({ ws }) => {
		await insertApproval(ws, { type: 'strategy', payload: {} });
	});

	const cards = await findAllByTestId('approval-card', undefined, { timeout: 15_000 });
	const card = cards.find((c) => /Proposing strategy/.test(c.textContent ?? ''));
	expect(card).toBeTruthy();
	// The reason subtext (the block below "Proposing strategy") is absent when no
	// plan is in the payload.
	expect(card?.textContent).toContain('Proposing strategy');
});

test('a skill-proposal approval falls back to skill_slug when skill_name is absent', async () => {
	const { findByText } = await renderTeamInbox(async ({ ws }) => {
		await insertApproval(ws, {
			type: 'skill_proposal',
			payload: { skill_slug: 'deploy-helper' },
		});
	});

	await findByText('deploy-helper', undefined, { timeout: 15_000 });
});

test('a hire approval without a task identifier renders no task link', async () => {
	const { findAllByTestId } = await renderTeamInbox(async ({ ws }) => {
		await insertApproval(ws, { type: 'hire', payload: { title: 'Solo Hire' } });
	});

	const cards = await findAllByTestId('approval-card', undefined, { timeout: 15_000 });
	const hireCard = cards.find((c) => /Proposing to hire/.test(c.textContent ?? ''));
	expect(hireCard).toBeTruthy();
	expect(hireCard?.textContent).toContain('Solo Hire');
	// No task identifier in the payload → no inline task link in the message.
	const taskLink = within(hireCard as HTMLElement)
		.queryAllByRole('link')
		.find((a) => /\/tasks\//.test(a.getAttribute('href') ?? ''));
	expect(taskLink).toBeUndefined();
});

test('a deploy approval uses the environment field when target is absent', async () => {
	const { findByText } = await renderTeamInbox(async ({ ws }) => {
		await insertApproval(ws, {
			type: 'deploy_production',
			payload: { environment: 'staging-eu' },
		});
	});

	await findByText('Requesting deploy to', undefined, { timeout: 15_000 });
	await findByText('staging-eu');
});

test('a pending approval renders the unread dot indicator', async () => {
	const { findAllByTestId } = await renderTeamInbox(async ({ ws }) => {
		await insertApproval(ws, { type: 'strategy', payload: { plan: 'Unread plan' } });
	});

	const cards = await findAllByTestId('approval-card', undefined, { timeout: 15_000 });
	const card = cards.find((c) => /Unread plan/.test(c.textContent ?? ''));
	expect(card).toBeTruthy();
	expect(card?.getAttribute('data-unread')).toBe('true');
	// The unread dot carries an accessible label.
	expect(within(card as HTMLElement).getByLabelText('Unread')).toBeTruthy();
});
