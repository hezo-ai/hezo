// Coverage for routes/projects/$projectId/assets.tsx beyond the existing
// project-assets spec: the per-content-type AssetIcon variants, the HTML-asset
// iframe preview, the drag-and-drop overlay toggle, the client-side upload-error
// chip, and the "attached to N comments" delete-confirm copy. The asset list is
// fetch-mocked where a specific content_type / attachment count is needed (the
// upload validator only admits real media types, and wiring a real comment
// attachment is orthogonal). Real native file-drop with an OS DataTransfer is
// Playwright territory (decision-tree item 3); here the drag *handlers* are
// exercised with synthetic events carrying a Files type. Component tier.

import { fireEvent, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

interface FakeAsset {
	id: string;
	content_type: string;
	byte_size: number;
	original_filename: string;
	comment_attachment_count?: number;
	/** Archived assets carry a stamp; the hard-delete action only shows on these. */
	archived_at?: string | null;
}

function asset(o: FakeAsset) {
	return {
		id: o.id,
		content_type: o.content_type,
		byte_size: o.byte_size,
		original_filename: o.original_filename,
		created_at: new Date().toISOString(),
		archived_at: o.archived_at ?? null,
		url: `/api/assets/${o.id}?exp=9999999999&sig=deadbeef`,
		comment_attachment_count: o.comment_attachment_count ?? 0,
	};
}

/** Render the assets page with a fetch-mocked asset list. */
async function renderAssetsWith(
	assets: ReturnType<typeof asset>[],
	onDelete?: () => void,
	search?: { filter?: 'archived' | 'all' },
) {
	let ws!: SeededWorkspace;
	const ref = { slug: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Asset States Project' });
			ref.slug = project.slug;
			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : (input as Request).url;
				const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
				if (method === 'GET' && new RegExp(`/api/projects/${project.slug}/assets$`).test(url)) {
					return new Response(JSON.stringify({ data: assets }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				if (method === 'DELETE' && /\/api\/projects\/[^/]+\/assets\/[^/]+$/.test(url)) {
					onDelete?.();
					return new Response(JSON.stringify({ data: { ok: true } }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo, init);
			}) as typeof globalThis.fetch;
		},
	});
	await helpers.router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ref.slug },
		search,
	});
	return { ...helpers, ref };
}

/** Delete only exists on archived cards — hard delete is a two-step flow. */
const ARCHIVED_AT = new Date().toISOString();

test('an HTML asset renders a sandboxed iframe preview; non-media types fall back to a file icon', async () => {
	const r = await renderAssetsWith([
		asset({
			id: 'a-html',
			content_type: 'text/html',
			byte_size: 2048,
			original_filename: 'report.html',
		}),
		asset({
			id: 'a-pdf',
			content_type: 'application/pdf',
			byte_size: 4096,
			original_filename: 'spec.pdf',
		}),
		asset({
			id: 'a-audio',
			content_type: 'audio/mpeg',
			byte_size: 8192,
			original_filename: 'voice.mp3',
		}),
		asset({
			id: 'a-video',
			content_type: 'video/mp4',
			byte_size: 1048576,
			original_filename: 'clip.mp4',
		}),
		asset({
			id: 'a-bin',
			content_type: 'application/octet-stream',
			byte_size: 10,
			original_filename: 'data.bin',
		}),
	]);

	// The HTML asset gets a sandboxed iframe pointed at its signed URL.
	const card = await r.findByText('report.html', undefined, { timeout: 20_000 });
	const li = card.closest('li') as HTMLElement;
	const iframe = li.querySelector('iframe') as HTMLIFrameElement;
	expect(iframe).not.toBeNull();
	expect(iframe.getAttribute('sandbox')).toBe('');
	expect(iframe.getAttribute('src')).toContain('/api/assets/a-html');

	// The other rows render (icon branches: pdf, audio, video, generic file).
	await r.findByText('spec.pdf');
	await r.findByText('voice.mp3');
	await r.findByText('clip.mp4');
	await r.findByText('data.bin');
	// Byte-size formatting: 1 MB video, 8.0 KB audio.
	expect(li.ownerDocument.body.textContent).toContain('1.0 MB');
});

test('deleting an asset attached to comments warns how many comments it will be removed from', async () => {
	const r = await renderAssetsWith(
		[
			asset({
				id: 'a-attached',
				content_type: 'image/png',
				byte_size: 512,
				original_filename: 'shared.png',
				comment_attachment_count: 3,
				archived_at: ARCHIVED_AT,
			}),
		],
		undefined,
		{ filter: 'archived' },
	);

	await r.findByText('shared.png', undefined, { timeout: 20_000 });
	await r.user.click(await r.findByTestId('asset-delete'));
	// ConfirmDialog (portal on document.body) shows the attachment-aware copy.
	await r.findByText(/attached to 3 comments and will be removed from them/);
});

test('a singular attachment count uses singular comment / it wording', async () => {
	const r = await renderAssetsWith(
		[
			asset({
				id: 'a-one',
				content_type: 'image/png',
				byte_size: 256,
				original_filename: 'one.png',
				comment_attachment_count: 1,
				archived_at: ARCHIVED_AT,
			}),
		],
		undefined,
		{ filter: 'archived' },
	);

	await r.findByText('one.png', undefined, { timeout: 20_000 });
	await r.user.click(await r.findByTestId('asset-delete'));
	await r.findByText(/attached to 1 comment and will be removed from it/);
});

test('confirming delete posts to the delete endpoint', async () => {
	let deleted = false;
	const r = await renderAssetsWith(
		[
			asset({
				id: 'a-del',
				content_type: 'image/png',
				byte_size: 128,
				original_filename: 'gone.png',
				archived_at: ARCHIVED_AT,
			}),
		],
		() => {
			deleted = true;
		},
		{ filter: 'archived' },
	);

	await r.findByText('gone.png', undefined, { timeout: 20_000 });
	await r.user.click(await r.findByTestId('asset-delete'));
	// Plain (no-attachment) confirm copy.
	await r.findByText(/permanently removed/);
	await r.user.click(await r.findByRole('button', { name: 'Delete' }));
	await waitFor(() => expect(deleted).toBe(true), { timeout: 15_000 });
});

test('dragging files over the drop zone shows the "Drop to upload" overlay, which clears on leave', async () => {
	let ws!: SeededWorkspace;
	const ref = { slug: '' };
	const { findByText, findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Drag Zone Project' });
			ref.slug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ref.slug },
	});

	const zone = await findByTestId('asset-drop-zone', undefined, { timeout: 20_000 });

	// happy-dom doesn't synthesize a real OS DataTransfer; pass a minimal stub
	// whose `types` includes 'Files' so the handlers run. The overlay-toggle logic
	// is what's under test (real file payload handling is Playwright's job).
	const dataTransfer = { types: ['Files'], files: [] } as unknown as DataTransfer;

	fireEvent.dragEnter(zone, { dataTransfer });
	await findByText('Drop to upload');
	expect(queryByTestId('asset-drop-overlay')).not.toBeNull();

	// dragOver keeps the overlay; dragLeave (depth back to 0) removes it.
	fireEvent.dragOver(zone, { dataTransfer });
	fireEvent.dragLeave(zone, { dataTransfer });
	await waitFor(() => expect(queryByTestId('asset-drop-overlay')).toBeNull());
});

test('dropping files onto the zone clears the overlay and routes them to the uploader', async () => {
	let ws!: SeededWorkspace;
	const ref = { slug: '' };
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Drop Project' });
			ref.slug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ref.slug },
	});

	const zone = await findByTestId('asset-drop-zone', undefined, { timeout: 20_000 });
	const file = new File([new Uint8Array([1, 2, 3])], 'dropped.png', { type: 'image/png' });
	const dataTransfer = { types: ['Files'], files: [file] } as unknown as DataTransfer;

	fireEvent.dragEnter(zone, { dataTransfer });
	await findByTestId('asset-drop-overlay');
	// Drop resets the overlay and hands the file list to handleFiles (real upload).
	fireEvent.drop(zone, { dataTransfer });
	await waitFor(() => expect(queryByTestId('asset-drop-overlay')).toBeNull());
	// The dropped PNG uploads through the real backend and lands in the library.
	await findByTestId('asset-card', undefined, { timeout: 20_000 });
});

test('uploading a disallowed file type surfaces a transient error chip', async () => {
	let ws!: SeededWorkspace;
	const ref = { slug: '' };
	const { findByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Upload Error Project' });
			ref.slug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets',
		params: { projectId: ref.slug },
	});

	const input = (await findByTestId('asset-file-input', undefined, {
		timeout: 20_000,
	})) as HTMLInputElement;
	// The upload hook rejects unsupported extensions client-side → the error chip
	// renders with the filename + message.
	const bad = new File([new Uint8Array([0])], 'malware.exe', { type: 'application/x-msdownload' });
	await user.upload(input, bad);

	const chip = await findByTestId('asset-upload-error');
	expect(chip.textContent).toContain('malware.exe');
});
