import { test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedWorkspace } from './helpers/seed';

async function createApproval(
	workspace: SeededWorkspace,
	body: { type: string; payload: Record<string, unknown> },
) {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/projects/${workspace.internalSlug}/approvals`, {
		method: 'POST',
		headers: workspace.headers,
		body: JSON.stringify(body),
	});
	return ((await res.json()) as { data: { id: string } }).data;
}

test('inbox shows empty state when no approvals', async () => {
	const seeded = { projectSlug: '' };
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.projectSlug = ws.internalSlug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/inbox',
		params: { projectId: seeded.projectSlug },
	});

	await findByText('All clear', undefined, { timeout: 10_000 });
	await findByText(/No approvals or mentions/);
});

test('inbox shows pending approval with type badge', async () => {
	const seeded = { projectSlug: '' };
	const { findByText, findByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.projectSlug = ws.internalSlug;
			await createApproval(ws, {
				type: 'strategy',
				payload: { plan: 'Launch new product line' },
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/inbox',
		params: { projectId: seeded.projectSlug },
	});

	await findByRole('heading', { name: 'Inbox' }, { timeout: 10_000 });
	await findByText('Proposing strategy');
	await findByText('Launch new product line');

	await findByRole('button', { name: 'Approve' });
	await findByRole('button', { name: 'Deny' });
});

test('can approve a pending approval', async () => {
	const seeded = { projectSlug: '' };
	const { findByText, findByRole, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.projectSlug = ws.internalSlug;
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
		to: '/projects/$projectId/inbox',
		params: { projectId: seeded.projectSlug },
	});

	await findByText('Proposing to hire', undefined, { timeout: 10_000 });
	await user.click(await findByRole('button', { name: 'Approve' }));
	// Resolved approvals stay in the inbox as read history with a status badge.
	await findByText('approved', undefined, { timeout: 15_000 });
	await findByText('Proposing to hire');
});

test('can deny a pending approval', async () => {
	const seeded = { projectSlug: '' };
	const { findByText, findByRole, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.projectSlug = ws.internalSlug;
			await createApproval(ws, {
				type: 'hire',
				payload: {
					title: 'New Agent',
					slug: `new-agent-${Date.now()}`,
					system_prompt: 'You help.',
				},
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/inbox',
		params: { projectId: seeded.projectSlug },
	});

	await findByText('Proposing to hire', undefined, { timeout: 10_000 });
	await user.click(await findByRole('button', { name: 'Deny' }));
	// Resolved approvals stay in the inbox as read history with a status badge.
	await findByText('denied', undefined, { timeout: 15_000 });
	await findByText('Proposing to hire');
});

test('header has the global Inbox link', async () => {
	const { findByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			await seedWorkspace();
		},
	});

	await findByTestId('app-header-inbox', undefined, { timeout: 10_000 });
});
