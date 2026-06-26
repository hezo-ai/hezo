import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededProject, seedProject, seedWorkspace } from './helpers/seed';

/** A structurally-valid 512×512 PNG header — enough for the server's dimension check. */
function pngHeader(): Uint8Array {
	const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	const ihdr = new Uint8Array(25);
	const view = new DataView(ihdr.buffer);
	view.setUint32(0, 13);
	ihdr.set([0x49, 0x48, 0x44, 0x52], 4); // "IHDR"
	view.setUint32(8, 512);
	view.setUint32(12, 512);
	return new Uint8Array([...sig, ...ihdr]);
}

/** Upload a project icon through the real API (bypassing the client canvas crop). */
async function seedProjectIcon(project: SeededProject): Promise<void> {
	const { apiBase, token } = getTestContext();
	const fd = new FormData();
	fd.set('file', new Blob([pngHeader() as BlobPart], { type: 'image/png' }), 'icon.png');
	const res = await apiBase(`/api/projects/${project.slug}/icon`, {
		method: 'PUT',
		headers: { Authorization: `Bearer ${token}` },
		body: fd,
	});
	if (res.status !== 200) throw new Error(`seedProjectIcon failed: ${res.status}`);
}

test('the rail renders the icon image when a project has one', async () => {
	let slug = '';
	const { findByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Pictured' });
			await seedProjectIcon(project);
			slug = project.slug;
		},
	});

	const avatar = await findByTestId(`project-rail-avatar-${slug}`, undefined, { timeout: 15_000 });
	await expect.poll(() => avatar.querySelector('img'), { timeout: 15_000 }).toBeTruthy();
	const img = avatar.querySelector('img');
	expect(img?.getAttribute('src')).toContain(`/icon?exp=`);
	// An image avatar drops the initials border, so it doesn't show a stray grey
	// ring between the image and the active/live ring.
	expect(img?.parentElement?.className).not.toContain('border-border');
});

test('settings shows Upload image with no icon, and Replace/Remove once set', async () => {
	let withIcon: SeededProject;
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const ws = await seedWorkspace();
			withIcon = await seedProject(ws, { name: 'Branded' });
			await seedProjectIcon(withIcon);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: withIcon!.slug },
	});

	// An existing icon shows Replace + Remove, never the first-run Upload label.
	await findByTestId('project-icon-remove', undefined, { timeout: 15_000 });
	const upload = await findByTestId('project-icon-upload');
	expect(upload.textContent).toContain('Replace image');
	expect(queryByTestId('project-icon-preview')?.querySelector('img')).toBeTruthy();
});

test('settings shows the initials fallback and Upload image when no icon is set', async () => {
	let plain: SeededProject;
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const ws = await seedWorkspace();
			plain = await seedProject(ws, { name: 'Plain' });
		},
	});

	await router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: plain!.slug },
	});

	const upload = await findByTestId('project-icon-upload', undefined, { timeout: 15_000 });
	expect(upload.textContent).toContain('Upload image');
	expect(queryByTestId('project-icon-remove')).toBeNull();
	// No icon → the preview shows initials, not an <img>.
	expect(queryByTestId('project-icon-preview')?.querySelector('img')).toBeFalsy();
});
