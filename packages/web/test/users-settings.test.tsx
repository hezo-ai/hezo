// Coverage for the global Settings → Users page: it lists the single admin user
// and exposes the shared IconUploadSection (user-icon-*) wired to the real
// PUT/DELETE /api/users/:userId/icon routes. happy-dom can't decode/rasterize
// images, so the decode/canvas boundary is stubbed with a valid 512×512 PNG.

import { fireEvent } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

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

type WindowWithBitmap = { createImageBitmap?: (f: File) => Promise<unknown> };
type UrlStatics = {
	createObjectURL?: (b: Blob | File) => string;
	revokeObjectURL?: (u: string) => void;
};
const urlStatics = URL as unknown as UrlStatics;
const originalCreateObjectURL = urlStatics.createObjectURL;
const originalRevokeObjectURL = urlStatics.revokeObjectURL;

function stubImagePipeline() {
	(window as unknown as WindowWithBitmap).createImageBitmap = vi.fn(async () => ({
		width: 800,
		height: 600,
		close: vi.fn(),
	})) as unknown as (f: File) => Promise<unknown>;

	const encoded = new Blob([pngHeader() as unknown as BlobPart], { type: 'image/png' });
	const original = document.createElement.bind(document);
	vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
		if (tag !== 'canvas') return original(tag);
		return {
			width: 0,
			height: 0,
			getContext: () => ({ imageSmoothingQuality: '', drawImage: () => {} }),
			toBlob: (cb: (b: Blob | null) => void) => cb(encoded),
		} as unknown as HTMLElement;
	}) as typeof document.createElement);

	urlStatics.createObjectURL = vi.fn(() => 'blob:preview-url');
	urlStatics.revokeObjectURL = vi.fn();
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	delete (window as unknown as WindowWithBitmap).createImageBitmap;
	urlStatics.createObjectURL = originalCreateObjectURL;
	urlStatics.revokeObjectURL = originalRevokeObjectURL;
});

async function renderUsersPage() {
	const utils = await renderApp({
		initialPath: '/',
		seed: async () => {
			await seedWorkspace();
		},
	});
	await utils.router.navigate({ to: '/settings/users' });
	return utils;
}

test('lists the admin user and exposes the avatar control', async () => {
	const { findByRole, findByTestId } = await renderUsersPage();
	await findByRole('heading', { name: 'Users' });
	// The single admin user row renders with its avatar upload affordance.
	await findByTestId('users-list', undefined, { timeout: 15_000 });
	expect((await findByTestId('user-icon-upload')).textContent).toContain('Upload image');
});

test('uploading the admin avatar swaps to Replace/Remove', async () => {
	stubImagePipeline();
	const { findByTestId, queryByTestId, user } = await renderUsersPage();

	const input = await findByTestId('user-icon-input', undefined, { timeout: 15_000 });
	fireEvent.change(input, {
		target: { files: [new File([new Uint8Array([1, 2, 3])], 'avatar.png', { type: 'image/png' })] },
	});

	const save = await findByTestId('user-icon-save');
	expect((await findByTestId('user-icon-preview')).querySelector('img')?.getAttribute('src')).toBe(
		'blob:preview-url',
	);
	await user.click(save);

	await findByTestId('user-icon-remove', undefined, { timeout: 15_000 });
	expect(queryByTestId('user-icon-save')).toBeNull();
	expect((await findByTestId('user-icon-upload')).textContent).toContain('Replace image');
});
