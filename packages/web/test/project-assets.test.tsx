import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedAsset, seedComment, seedProject, seedTask, seedWorkspace } from './helpers/seed';

test('the assets library lists uploads with an open-in-new-tab link to a signed url', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Asset Lib' });
			await seedAsset(ws, project, { filename: 'mockup.png' });
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
	});

	await findByText('mockup.png');
	const openLink = await findByTestId('asset-open-link');
	expect(openLink.getAttribute('href')).toMatch(/^\/api\/assets\/[0-9a-f-]+\?exp=\d+&sig=/);
	expect(openLink.getAttribute('target')).toBe('_blank');
});

test('an asset can be deleted from the library', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, findByTestId, getByRole, queryByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Deletable' });
			await seedAsset(ws, project, { filename: 'remove-me.png' });
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
	});

	await findByText('remove-me.png');
	await user.click(await findByTestId('asset-delete'));
	// ConfirmDialog renders into a portal on document.body.
	await user.click(getByRole('button', { name: 'Delete' }));

	await waitFor(() => expect(queryByText('remove-me.png')).toBeNull());
});

test('an assets/<name> reference in a task comment opens in a new tab, not the preview panel', async () => {
	let ctx!: { projectSlug: string; taskId: string };
	const { container, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Mention Assets' });
			await seedAsset(ws, project, { filename: 'login.png' });
			const task = await seedTask(ws, project, { title: 'Build the login screen' });
			await seedComment(ws, task, 'Match the layout to assets/login.png before you start.');
			ctx = { projectSlug: project.slug, taskId: task.id };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: ctx.projectSlug, taskId: ctx.taskId },
	});

	// The asset mention is an anchor that opens the signed URL in a new tab, with a
	// trailing external-link icon — never the in-page preview panel.
	const link = (await findByTestId('asset-mention-link', undefined, {
		timeout: 15_000,
	})) as HTMLAnchorElement;
	expect(link.tagName).toBe('A');
	expect(link.textContent).toContain('assets/login.png');
	expect(link.getAttribute('target')).toBe('_blank');
	expect(link.getAttribute('href')).toMatch(/^\/api\/assets\/[0-9a-f-]+\?exp=\d+&sig=/);

	// The trailing external-link icon points at the same signed URL.
	const icon = (await findByTestId('asset-mention-preview-link')) as HTMLAnchorElement;
	expect(icon.getAttribute('href')).toBe(link.getAttribute('href'));

	// Assets no longer route through the in-page preview panel.
	expect(container.querySelector('[data-testid="preview-panel"]')).toBeNull();
});

test('uploading a file through the picker adds it to the library', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Upload Lib' });
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
	});

	await findByText('No assets yet');
	const input = await findByTestId('asset-file-input');
	const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], 'diagram.png', {
		type: 'image/png',
	});
	await user.upload(input as HTMLInputElement, file);

	await findByText('diagram.png');
});
