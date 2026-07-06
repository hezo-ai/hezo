// Coverage for components/project-icon-section.tsx: the pick → normalize →
// preview → save/cancel flow plus remove and the error toasts. happy-dom can't
// decode or rasterize images, so the browser decode/canvas boundary is stubbed
// (createImageBitmap + a fake <canvas>) while the upload itself runs against
// the real PUT/DELETE /api/projects/:slug/icon routes — the fake canvas encodes
// to a structurally-valid 512×512 PNG header so the server accepts it.

import { fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { toast } from '../src/hooks/use-toast';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededProject, seedProject, seedWorkspace } from './helpers/seed';

/** A structurally-valid 512×512 PNG header — enough for the server's checks. */
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

/**
 * Stub the image-normalization browser surface: createImageBitmap decodes any
 * file to a fake bitmap and document.createElement('canvas') returns a canvas
 * whose toBlob emits `encoded` (a valid PNG by default).
 */
function stubImagePipeline(opts: { encoded?: Blob; decodeFails?: boolean } = {}) {
	(window as unknown as WindowWithBitmap).createImageBitmap = vi.fn(async () => {
		if (opts.decodeFails) throw new Error('cannot decode');
		return { width: 800, height: 600, close: vi.fn() };
	}) as unknown as (f: File) => Promise<unknown>;

	const encoded =
		opts.encoded ?? new Blob([pngHeader() as unknown as BlobPart], { type: 'image/png' });
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
	const revoke = vi.fn();
	urlStatics.revokeObjectURL = revoke;

	// The <img> fallback decode path: fail immediately so a rejected
	// createImageBitmap surfaces as "could not read".
	class FailingImage {
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		decoding = '';
		width = 0;
		height = 0;
		set src(_v: string) {
			queueMicrotask(() => this.onerror?.());
		}
	}
	vi.stubGlobal('Image', FailingImage);
	return { revoke };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	delete (window as unknown as WindowWithBitmap).createImageBitmap;
	urlStatics.createObjectURL = originalCreateObjectURL;
	urlStatics.revokeObjectURL = originalRevokeObjectURL;
});

async function renderSettings(withIcon = false) {
	let project!: SeededProject;
	const utils = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			project = await seedProject(ws, { name: 'Icon Flow' });
			if (withIcon) {
				const { apiBase, token } = getTestContext();
				const fd = new FormData();
				fd.set(
					'file',
					new Blob([pngHeader() as unknown as BlobPart], { type: 'image/png' }),
					'icon.png',
				);
				const res = await apiBase(`/api/projects/${project.slug}/icon`, {
					method: 'PUT',
					headers: { Authorization: `Bearer ${token}` },
					body: fd,
				});
				if (res.status !== 200) throw new Error(`icon seed failed: ${res.status}`);
			}
		},
	});
	await utils.router.navigate({
		to: '/projects/$projectId/settings',
		params: { projectId: project.slug },
	});
	return { ...utils, project };
}

function pickFile(input: HTMLElement, file: File) {
	fireEvent.change(input, { target: { files: [file] } });
}

test('picking an image shows the normalized preview; Save uploads it and swaps to Replace/Remove', async () => {
	stubImagePipeline();
	const { findByTestId, queryByTestId, user } = await renderSettings();

	const input = await findByTestId('project-icon-input', undefined, { timeout: 15_000 });
	pickFile(input, new File([new Uint8Array([1, 2, 3])], 'avatar.png', { type: 'image/png' }));

	// Preview state: the avatar shows the normalized blob and Save/Cancel appear.
	const save = (await findByTestId('project-icon-save')) as HTMLButtonElement;
	const preview = await findByTestId('project-icon-preview');
	expect(preview.querySelector('img')?.getAttribute('src')).toBe('blob:preview-url');

	await user.click(save);

	// Upload succeeded: preview cleared, and the section now offers Replace + Remove.
	await findByTestId('project-icon-remove', undefined, { timeout: 15_000 });
	expect(queryByTestId('project-icon-save')).toBeNull();
	const upload = await findByTestId('project-icon-upload');
	expect(upload.textContent).toContain('Replace image');
});

test('Cancel discards the pending preview and releases its object URL', async () => {
	const { revoke } = stubImagePipeline();
	const { findByTestId, findByRole, queryByTestId, user } = await renderSettings();

	const input = await findByTestId('project-icon-input', undefined, { timeout: 15_000 });
	pickFile(input, new File([new Uint8Array([1])], 'avatar.png', { type: 'image/png' }));
	await findByTestId('project-icon-save');

	await user.click(await findByRole('button', { name: 'Cancel' }));

	// Back to the first-run state, with the blob URL revoked.
	await findByTestId('project-icon-upload');
	expect(queryByTestId('project-icon-save')).toBeNull();
	expect(revoke).toHaveBeenCalledWith('blob:preview-url');
});

test('an unsupported file type is rejected with a toast and no preview', async () => {
	stubImagePipeline();
	const errorSpy = vi.spyOn(toast, 'error');
	const { findByTestId, queryByTestId } = await renderSettings();

	const input = await findByTestId('project-icon-input', undefined, { timeout: 15_000 });
	pickFile(input, new File(['plain'], 'notes.txt', { type: 'text/plain' }));

	await waitFor(() =>
		expect(errorSpy).toHaveBeenCalledWith(
			'Unsupported image type. Use PNG, JPEG, WebP, GIF, or SVG.',
		),
	);
	expect(queryByTestId('project-icon-save')).toBeNull();
});

test('an undecodable image is rejected with a toast', async () => {
	stubImagePipeline({ decodeFails: true });
	const errorSpy = vi.spyOn(toast, 'error');
	const { findByTestId, queryByTestId } = await renderSettings();

	const input = await findByTestId('project-icon-input', undefined, { timeout: 15_000 });
	pickFile(input, new File([new Uint8Array([9])], 'broken.png', { type: 'image/png' }));

	await waitFor(() =>
		expect(errorSpy).toHaveBeenCalledWith('Could not read that image. Try a different file.'),
	);
	expect(queryByTestId('project-icon-save')).toBeNull();
});

test('a server-rejected upload keeps the preview and toasts the failure', async () => {
	// The fake canvas encodes garbage bytes — the server's PNG validation rejects
	// the PUT, exercising the handleSave error branch.
	stubImagePipeline({ encoded: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) });
	const errorSpy = vi.spyOn(toast, 'error');
	const { findByTestId, getByTestId, user } = await renderSettings();

	const input = await findByTestId('project-icon-input', undefined, { timeout: 15_000 });
	pickFile(input, new File([new Uint8Array([1])], 'avatar.png', { type: 'image/png' }));

	await user.click(await findByTestId('project-icon-save'));

	await waitFor(() => expect(errorSpy).toHaveBeenCalledWith('Failed to upload icon'));
	// The preview (and its Save affordance) survives so the user can retry/cancel.
	expect(getByTestId('project-icon-save')).toBeTruthy();
});

test('a failed remove keeps the icon and toasts the failure', async () => {
	stubImagePipeline();
	const errorSpy = vi.spyOn(toast, 'error');
	const { findByTestId, getByTestId, user } = await renderSettings(true);

	const remove = await findByTestId('project-icon-remove', undefined, { timeout: 15_000 });

	// Fail the DELETE underneath the section; everything else passes through.
	const passthrough = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
		const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
		if (method === 'DELETE' && url.includes('/icon')) {
			return new Response(JSON.stringify({ error: { code: 'BOOM', message: 'nope' } }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return passthrough(input as RequestInfo, init);
	}) as typeof globalThis.fetch;

	await user.click(remove);

	await waitFor(() => expect(errorSpy).toHaveBeenCalledWith('Failed to remove icon'));
	// The icon is still set, so Remove stays available.
	expect(getByTestId('project-icon-remove')).toBeTruthy();
});

test('Remove deletes the existing icon and returns to the initials fallback', async () => {
	stubImagePipeline();
	const { findByTestId, queryByTestId, user } = await renderSettings(true);

	// Existing icon → Remove is offered.
	const remove = await findByTestId('project-icon-remove', undefined, { timeout: 15_000 });
	await user.click(remove);

	// Icon gone: Remove disappears and the first-run Upload label returns.
	await waitFor(() => expect(queryByTestId('project-icon-remove')).toBeNull());
	const upload = await findByTestId('project-icon-upload');
	expect(upload.textContent).toContain('Upload image');
	// The avatar falls back to initials (no <img>).
	expect(queryByTestId('project-icon-preview')?.querySelector('img')).toBeFalsy();
});
