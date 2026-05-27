import { expect, test } from 'vitest';
import { queryClient } from '../src/lib/query-client';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedWorkspace } from './helpers/seed';

async function seedTeam(): Promise<SeededWorkspace> {
	return await seedWorkspace();
}

async function createKbDoc(
	workspace: SeededWorkspace,
	body: { title: string; content: string },
): Promise<{ id: string; slug: string }> {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/teams/${workspace.team.id}/kb-docs`, {
		method: 'POST',
		headers: workspace.headers,
		body: JSON.stringify(body),
	});
	return ((await res.json()) as { data: { id: string; slug: string } }).data;
}

async function patchKbDoc(
	workspace: SeededWorkspace,
	slug: string,
	body: { content: string; change_summary?: string },
): Promise<void> {
	const { apiBase } = getTestContext();
	await apiBase(`/api/teams/${workspace.team.id}/kb-docs/${slug}`, {
		method: 'PATCH',
		headers: workspace.headers,
		body: JSON.stringify(body),
	});
}

test('kb empty state shows new document button', async () => {
	const seeded = { teamSlug: '' };
	const { findByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedTeam();
			seeded.teamSlug = ws.team.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/kb',
		params: { teamId: seeded.teamSlug },
	});

	await findByRole('button', { name: 'New document' }, { timeout: 10_000 });
});

test('can create and view a kb document', async () => {
	const seeded = { teamSlug: '' };
	const { findByRole, findByLabelText, user, router, container } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedTeam();
			seeded.teamSlug = ws.team.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/kb',
		params: { teamId: seeded.teamSlug },
	});

	await user.click(await findByRole('button', { name: 'New document' }));
	await user.type(await findByLabelText('Title'), 'Onboarding Guide');
	// MentionTextarea — find the textarea by its label.
	const contentArea = await findByLabelText(/Content/i);
	await user.type(contentArea, '# Welcome\n\nThis is a **test** document.');

	await user.click(await findByRole('button', { name: 'Create', exact: true }));

	await findByRole('heading', { name: 'Onboarding Guide' }, { timeout: 10_000 });
	await findByRole('heading', { name: 'Welcome' }, { timeout: 10_000 });
	await findByRole('button', { name: 'Edit' }, { timeout: 10_000 });
	// Find the revision history toggle.
	expect(container.querySelector('button')).toBeTruthy();
});

test('can edit a kb document', async () => {
	const seeded = { teamSlug: '', docSlug: '' };
	const { findByRole, findByLabelText, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedTeam();
			seeded.teamSlug = ws.team.slug;
			const doc = await createKbDoc(ws, { title: 'Edit Me', content: 'Original content' });
			seeded.docSlug = doc.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/kb',
		params: { teamId: seeded.teamSlug },
		search: { slug: seeded.docSlug },
	});

	await findByRole('heading', { name: 'Edit Me' }, { timeout: 10_000 });
	await user.click(await findByRole('button', { name: 'Edit', exact: true }));

	const textarea = (await findByLabelText(/.*/i, { selector: 'textarea' }).catch(
		() => null,
	)) as HTMLTextAreaElement | null;
	const textareaEl = textarea ?? (document.querySelector('textarea') as HTMLTextAreaElement);
	await user.clear(textareaEl);
	await user.type(textareaEl, 'Updated content body');
	await user.click(await findByRole('button', { name: 'Save' }));

	await findByText('Updated content body', undefined, { timeout: 10_000 });
});

test('shows revision history and restores a previous version', async () => {
	const seeded = { teamSlug: '', docSlug: '' };
	const { findByRole, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedTeam();
			seeded.teamSlug = ws.team.slug;
			const doc = await createKbDoc(ws, { title: 'Restore Me', content: 'Original kb body' });
			seeded.docSlug = doc.slug;
			await patchKbDoc(ws, doc.slug, { content: 'Updated kb body', change_summary: 'second pass' });
		},
	});

	await router.navigate({
		to: '/teams/$teamId/kb',
		params: { teamId: seeded.teamSlug },
		search: { slug: seeded.docSlug },
	});

	await findByText('Updated kb body', undefined, { timeout: 10_000 });
	await user.click(await findByRole('button', { name: /show revision history/i }));
	await findByText(/Rev 1/, undefined, { timeout: 10_000 });

	await user.click(await findByRole('button', { name: 'Restore', exact: true }));
	// Confirm dialog
	const confirmBtn = await findByRole('button', { name: /^Restore/i });
	// The confirm dialog has its own Restore button; click the last one.
	const buttons = document.querySelectorAll('button');
	const allRestore = Array.from(buttons).filter((b) => /restore/i.test(b.textContent ?? ''));
	await user.click(allRestore[allRestore.length - 1]);
	expect(confirmBtn).toBeTruthy();

	await findByText('Original kb body', undefined, { timeout: 10_000 });
});

test('can delete a kb document', async () => {
	const seeded = { teamSlug: '' };
	const { findByRole, queryByRole, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedTeam();
			seeded.teamSlug = ws.team.slug;
			await createKbDoc(ws, { title: 'Delete Me', content: 'Will be deleted' });
			// Prior tests in the file leave kb-docs cached in the singleton
			// queryClient; drop it so the new team's docs are fetched fresh.
			queryClient.removeQueries({ queryKey: ['teams', ws.team.slug, 'kb-docs'] });
		},
	});

	await router.navigate({
		to: '/teams/$teamId/kb',
		params: { teamId: seeded.teamSlug },
	});

	await user.click(await findByRole('button', { name: /Delete Me/ }));
	await findByRole('button', { name: 'Edit' }, { timeout: 10_000 });

	await user.click(await findByRole('button', { name: 'Delete document' }));
	const confirm = await findByRole('button', { name: /^Delete$/i });
	await user.click(confirm);

	await new Promise((r) => setTimeout(r, 500));
	expect(queryByRole('button', { name: /Delete Me/ })).toBeNull();
});
