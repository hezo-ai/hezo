import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedAsset, seedProject, seedWorkspace } from './helpers/seed';

test('foldered assets render as folder cards; clicking one drills in with breadcrumbs', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, findByTestId, queryByText, queryByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Foldered' });
			await seedAsset(ws, project, { filename: 'loose.png' });
			await seedAsset(ws, project, { filename: 'hero.png', folder: 'launch' });
			await seedAsset(ws, project, { filename: 'logo.png', folder: 'launch' });
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
	});

	// Root view: the folder card with its count plus the loose asset; foldered
	// assets are not shown at the root.
	const folderCard = await findByTestId('asset-folder-card');
	expect(folderCard.getAttribute('data-folder')).toBe('launch');
	await findByText('2 files');
	await findByText('loose.png');
	expect(queryByText('hero.png')).toBeNull();

	// No breadcrumb at the root.
	expect(queryByTestId('assets-breadcrumb')).toBeNull();

	// Drill in: only the folder's assets, no folder card, breadcrumb visible.
	await user.click(folderCard);
	await findByText('hero.png');
	await findByText('logo.png');
	expect(queryByText('loose.png')).toBeNull();
	const breadcrumb = await findByTestId('assets-breadcrumb');
	expect(breadcrumb.textContent).toContain('Assets');
	expect(breadcrumb.textContent).toContain('launch');
	expect(breadcrumb.querySelector('[aria-current="page"]')?.textContent).toBe('launch');
});

test('breadcrumbs navigate back to the root and across two folder levels', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, findByTestId, getByRole, queryByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Deep' });
			await seedAsset(ws, project, { filename: 'poster.png', folder: 'launch/art' });
			await seedAsset(ws, project, { filename: 'plan.png', folder: 'launch' });
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
		search: { folder: 'launch/art' },
	});

	// Two-level breadcrumb: Assets / launch / art (leaf is current page).
	const breadcrumb = await findByTestId('assets-breadcrumb');
	await findByText('poster.png');
	expect(breadcrumb.querySelector('[aria-current="page"]')?.textContent).toBe('art');

	// The middle crumb goes up one level.
	await user.click(getByRole('button', { name: 'launch' }));
	await findByText('plan.png');
	expect(queryByText('poster.png')).toBeNull();

	// The root crumb leaves the folders entirely (breadcrumb unmounts).
	await user.click(getByRole('button', { name: 'Assets' }));
	await waitFor(() => {
		expect(queryByText('plan.png')).toBeNull();
	});
	const folderCard = await findByTestId('asset-folder-card');
	expect(folderCard.getAttribute('data-folder')).toBe('launch');
});

test('uploading inside a folder lands the file there', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, findByTestId, user, router, container } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Uploady' });
			await seedAsset(ws, project, { filename: 'existing.png', folder: 'drops' });
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
		search: { folder: 'drops' },
	});
	await findByText('existing.png');

	const input = (await findByTestId('asset-file-input')) as HTMLInputElement;
	await user.upload(
		input,
		new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9])], 'fresh.png', {
			type: 'image/png',
		}),
	);

	// The refetched grid shows the new file inside the folder, stored under the
	// folder path (data-filename carries the full path; the label the basename).
	await findByText('fresh.png');
	await waitFor(() => {
		const card = container.querySelector('[data-filename="drops/fresh.png"]');
		expect(card).not.toBeNull();
	});
});

test('a ?file deep-link to a foldered asset opens its folder and highlights it', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, findByTestId, container, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'DeepLink' });
			await seedAsset(ws, project, { filename: 'target.png', folder: 'blog/images' });
			await seedAsset(ws, project, { filename: 'other.png' });
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
		search: { file: 'blog/images/target.png' },
	});

	// The containing folder auto-opens and the asset is highlighted.
	await findByText('target.png');
	await findByTestId('assets-breadcrumb');
	await waitFor(() => {
		const card = container.querySelector('[data-filename="blog/images/target.png"]');
		expect(card?.className).toContain('border-info');
	});
});

test('New folder navigates into a virtual empty folder; invalid names error inline', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, findByTestId, queryByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'NewFolder' });
			await seedAsset(ws, project, { filename: 'seed.png' });
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
	});
	await findByText('seed.png');

	await user.click(await findByTestId('asset-new-folder-button'));
	const input = await findByTestId('asset-new-folder-input');

	// An unusable name (nothing survives normalization) errors inline.
	await user.type(input, '###');
	await user.click(await findByTestId('asset-new-folder-create'));
	await findByTestId('asset-new-folder-error');

	// A valid name navigates into the (virtual) folder with its empty state.
	await user.clear(input);
	await user.type(input, 'Fresh Campaign');
	await user.click(await findByTestId('asset-new-folder-create'));
	await findByText('This folder is empty');
	const breadcrumb = await findByTestId('assets-breadcrumb');
	expect(breadcrumb.querySelector('[aria-current="page"]')?.textContent).toBe('Fresh-Campaign');
	expect(queryByTestId('asset-new-folder-dialog')).toBeNull();
});

test('the New folder button hides at maximum folder depth', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'MaxDepth' });
			await seedAsset(ws, project, { filename: 'deep.png', folder: 'a/b' });
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
		search: { folder: 'a/b' },
	});
	await findByText('deep.png');
	expect(queryByTestId('asset-new-folder-button')).toBeNull();
});

test('the move dialog re-homes an asset into another folder', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, findByTestId, container, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Mover' });
			await seedAsset(ws, project, { filename: 'wanderer.png' });
			await seedAsset(ws, project, { filename: 'resident.png', folder: 'homes' });
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
	});
	await findByText('wanderer.png');

	// Open the move dialog on the root asset (the folder card renders no move
	// button, so the only asset card at root is wanderer.png).
	await user.click(await findByTestId('asset-move'));
	// Dialogs render in a portal on document.body.
	const dialog = await waitFor(() => {
		const el = document.body.querySelector('[data-testid="asset-move-dialog"]');
		expect(el).not.toBeNull();
		return el as HTMLElement;
	});

	// Pick the existing `homes` folder option and confirm.
	const option = dialog.querySelector('[data-testid="asset-move-option"][data-folder="homes"]');
	expect(option).not.toBeNull();
	await user.click(option as HTMLElement);
	await user.click(dialog.querySelector('[data-testid="asset-move-confirm"]') as HTMLElement);

	// After the refetch the asset is gone from the root and lives under homes/.
	await waitFor(() => {
		expect(container.querySelector('[data-filename="wanderer.png"]')).toBeNull();
	});
	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
		search: { folder: 'homes' },
	});
	await waitFor(() => {
		expect(container.querySelector('[data-filename="homes/wanderer.png"]')).not.toBeNull();
	});
});

test('asset cards label with the basename while keeping the full path for tooling', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, queryByText, container, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Labels' });
			await seedAsset(ws, project, { filename: 'chart.png', folder: 'reports/q3' });
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
		search: { folder: 'reports/q3' },
	});

	// Label is the basename; the full path lives on data-filename and title.
	await findByText('chart.png');
	expect(queryByText('reports/q3/chart.png')).toBeNull();
	const card = container.querySelector('[data-filename="reports/q3/chart.png"]');
	expect(card).not.toBeNull();
	expect(card?.querySelector('[title="reports/q3/chart.png"]')).not.toBeNull();
});

test('a script upload through the picker succeeds and stores text/plain', async () => {
	let ctx!: { projectSlug: string };
	const { findByText, findByTestId, user, router, container } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Scripts' });
			await seedAsset(ws, project, { filename: 'seed.png' });
			ctx = { projectSlug: project.slug };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ctx.projectSlug },
	});
	await findByText('seed.png');

	const input = (await findByTestId('asset-file-input')) as HTMLInputElement;
	// Browsers declare text/javascript for .js — the shared resolver coerces it
	// to inert text/plain instead of rejecting it client-side.
	await user.upload(
		input,
		new File([new TextEncoder().encode('console.log(1)')], 'helper.js', {
			type: 'text/javascript',
		}),
	);

	await findByText('helper.js');
	await waitFor(() => {
		expect(container.querySelector('[data-filename="helper.js"]')).not.toBeNull();
	});
});
