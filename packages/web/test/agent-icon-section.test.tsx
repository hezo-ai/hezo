// Coverage for the agent-avatar wiring: the shared IconUploadSection rendered on
// the agent Settings page, driving pick → normalize → preview → save against the
// real PUT/DELETE /api/projects/:slug/agents/:agentId/icon routes. happy-dom
// can't decode/rasterize images, so the browser decode/canvas boundary is stubbed
// (a fake <canvas> encodes a structurally-valid 512×512 PNG the server accepts).

import { fireEvent } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedWorkspace } from './helpers/seed';

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

async function renderAgentSettings() {
	let ws!: SeededWorkspace;
	const utils = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});
	const agent = ws.agents[0];
	await utils.router.navigate({
		to: '/projects/$projectId/agents/$agentId/settings',
		params: { projectId: ws.internalSlug, agentId: agent.slug },
	});
	return { ...utils, ws, agent };
}

test('uploading an agent avatar swaps to Replace/Remove, and Remove returns to initials', async () => {
	stubImagePipeline();
	const { findByTestId, queryByTestId, user } = await renderAgentSettings();

	const input = await findByTestId('agent-icon-input', undefined, { timeout: 15_000 });
	fireEvent.change(input, {
		target: { files: [new File([new Uint8Array([1, 2, 3])], 'avatar.png', { type: 'image/png' })] },
	});

	// Preview state → Save the normalized blob.
	const save = await findByTestId('agent-icon-save');
	expect((await findByTestId('agent-icon-preview')).querySelector('img')?.getAttribute('src')).toBe(
		'blob:preview-url',
	);
	await user.click(save);

	// Upload succeeded: the section now offers Replace + Remove.
	await findByTestId('agent-icon-remove', undefined, { timeout: 15_000 });
	expect(queryByTestId('agent-icon-save')).toBeNull();
	expect((await findByTestId('agent-icon-upload')).textContent).toContain('Replace image');

	// Remove clears the avatar and returns to the initials fallback.
	await user.click(await findByTestId('agent-icon-remove'));
	await findByTestId('agent-icon-upload', undefined, { timeout: 15_000 });
	expect(queryByTestId('agent-icon-remove')).toBeNull();
	expect((await findByTestId('agent-icon-upload')).textContent).toContain('Upload image');
	expect(queryByTestId('agent-icon-preview')?.querySelector('img')).toBeFalsy();
});
