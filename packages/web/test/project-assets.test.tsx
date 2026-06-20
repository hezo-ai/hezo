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

test('an assets/<name> reference in a task comment opens the preview panel instead of a new tab', async () => {
	let ctx!: { projectSlug: string; taskId: string };
	const { container, findByTestId, user, router } = await renderApp({
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

	// In a task comment the asset mention is a button (opens the panel) with no
	// trailing new-tab suffix link.
	const link = await findByTestId('asset-mention-link', undefined, { timeout: 15_000 });
	expect(link.tagName).toBe('BUTTON');
	expect(link.textContent).toContain('assets/login.png');
	expect(container.querySelector('[data-testid="asset-mention-preview-link"]')).toBeNull();

	// The panel opens and exposes the signed-URL open-in-new-tab affordance.
	await user.click(link);
	const openTab = (await findByTestId('preview-open-tab')) as HTMLAnchorElement;
	expect(openTab.getAttribute('href')).toMatch(/^\/api\/assets\/[0-9a-f-]+\?exp=\d+&sig=/);
	expect(openTab.getAttribute('target')).toBe('_blank');
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
