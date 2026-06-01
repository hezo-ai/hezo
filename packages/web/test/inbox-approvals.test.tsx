import { test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedWorkspace } from './helpers/seed';

async function createApproval(
	workspace: SeededWorkspace,
	body: { type: string; payload: Record<string, unknown> },
) {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/teams/${workspace.team.id}/approvals`, {
		method: 'POST',
		headers: workspace.headers,
		body: JSON.stringify(body),
	});
	return ((await res.json()) as { data: { id: string } }).data;
}

test('inbox shows empty state when no approvals', async () => {
	const seeded = { teamSlug: '' };
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.teamSlug = ws.team.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/inbox',
		params: { teamId: seeded.teamSlug },
	});

	await findByText('All clear', undefined, { timeout: 10_000 });
	await findByText(/No approvals or mentions/);
});

test('inbox shows pending approval with type badge', async () => {
	const seeded = { teamSlug: '' };
	const { findByText, findByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.teamSlug = ws.team.slug;
			await createApproval(ws, {
				type: 'strategy',
				payload: { plan: 'Launch new product line' },
			});
		},
	});

	await router.navigate({
		to: '/teams/$teamId/inbox',
		params: { teamId: seeded.teamSlug },
	});

	await findByRole('heading', { name: 'Inbox' }, { timeout: 10_000 });
	await findByText('Proposing strategy');
	await findByText('Launch new product line');

	await findByRole('button', { name: 'Approve' });
	await findByRole('button', { name: 'Deny' });
});

test('can approve a pending approval', async () => {
	const seeded = { teamSlug: '' };
	const { findByText, findByRole, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.teamSlug = ws.team.slug;
			await createApproval(ws, {
				type: 'hire',
				payload: {
					title: 'New Designer',
					slug: `new-designer-${Date.now()}`,
					system_prompt: 'You are a designer.',
				},
			});
		},
	});

	await router.navigate({
		to: '/teams/$teamId/inbox',
		params: { teamId: seeded.teamSlug },
	});

	await findByText('Proposing to hire', undefined, { timeout: 10_000 });
	await user.click(await findByRole('button', { name: 'Approve' }));
	// Resolved approvals stay in the inbox as read history with a status badge.
	await findByText('approved', undefined, { timeout: 15_000 });
	await findByText('Proposing to hire');
});

test('can deny a pending approval', async () => {
	const seeded = { teamSlug: '' };
	const { findByText, findByRole, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.teamSlug = ws.team.slug;
			await createApproval(ws, {
				type: 'secret_access',
				payload: { secret_name: 'DB_PASSWORD' },
			});
		},
	});

	await router.navigate({
		to: '/teams/$teamId/inbox',
		params: { teamId: seeded.teamSlug },
	});

	await findByText(/Requesting access to secret/, undefined, { timeout: 10_000 });
	await user.click(await findByRole('button', { name: 'Deny' }));
	// Resolved approvals stay in the inbox as read history with a status badge.
	await findByText('denied', undefined, { timeout: 15_000 });
	await findByText(/Requesting access to secret/);
});

test('sidebar has Inbox link', async () => {
	const seeded = { teamSlug: '' };
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.teamSlug = ws.team.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects',
		params: { teamId: seeded.teamSlug },
	});

	await findByText('Inbox', { exact: true }, { timeout: 10_000 });
});
