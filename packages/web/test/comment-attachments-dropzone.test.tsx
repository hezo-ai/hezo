// Coverage for components/comment-attachments-drop.tsx via the task-detail
// comment composer (which wraps its textarea in the drop zone). happy-dom can't
// produce native OS drag sessions, but the component only reads
// e.dataTransfer.types/.files, so synthetic drag/drop events with constructed
// File objects exercise the full logic: overlay lifecycle (depth-tracked
// enter/leave), client-side rejection chips (extension / size), the real upload
// path against POST /tasks/:taskId/assets, per-content-type chip icons, upload
// failures, and chip removal. Real pixel-perfect DnD affordances stay in
// Playwright (decision-tree item 3).

import { ATTACHMENT_EXTENSIONS, ATTACHMENT_MAX_BYTES } from '@hezo/shared';
import { fireEvent, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { ATTACHMENT_CATEGORIES } from '../src/components/file-attachments';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

async function renderTaskPage() {
	const seeded = { projectSlug: '', taskId: '' };
	const utils = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Attachments' });
			const task = await seedTask(ws, project, { title: 'Attach things' });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});
	await utils.router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});
	const zone = await utils.findByTestId('comment-attachments-drop', undefined, {
		timeout: 20_000,
	});
	return { ...utils, zone };
}

function dt(files: File[], types: string[] = ['Files']) {
	return { dataTransfer: { types, files } };
}

test('the drop overlay tracks nested drag enter/leave depth and only files activate it', async () => {
	const { zone, queryByTestId, findByTestId } = await renderTaskPage();

	// A non-file drag (text selection) never activates the overlay.
	fireEvent.dragEnter(zone, dt([], ['text/plain']));
	expect(queryByTestId('comment-attachment-drop-overlay')).toBeNull();

	// A file drag shows the overlay; dragOver keeps the browser default suppressed.
	fireEvent.dragEnter(zone, dt([]));
	await findByTestId('comment-attachment-drop-overlay');
	fireEvent.dragOver(zone, dt([]));
	fireEvent.dragOver(zone, dt([], ['text/plain']));

	// Entering a child then leaving it keeps the overlay (depth 2 → 1)…
	fireEvent.dragEnter(zone, dt([]));
	fireEvent.dragLeave(zone, dt([]));
	expect(queryByTestId('comment-attachment-drop-overlay')).toBeTruthy();
	// …a non-file leave is ignored…
	fireEvent.dragLeave(zone, dt([], ['text/plain']));
	expect(queryByTestId('comment-attachment-drop-overlay')).toBeTruthy();
	// …and leaving the outer wrapper dismisses it (depth 0).
	fireEvent.dragLeave(zone, dt([]));
	await waitFor(() => expect(queryByTestId('comment-attachment-drop-overlay')).toBeNull());
});

test('dropping allowed files uploads them and renders linked chips; the X removes one', async () => {
	const { zone, container, findByTestId, queryByTestId, user } = await renderTaskPage();

	// The idle hint (with the supported-types tooltip) shows before any chip.
	expect(await findByTestId('comment-attachment-hint')).toBeTruthy();

	const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'screenshot.png', {
		type: 'image/png',
	});
	fireEvent.dragEnter(zone, dt([png]));
	fireEvent.drop(zone, dt([png]));

	// Drop clears the overlay immediately and the uploaded chip appears.
	expect(queryByTestId('comment-attachment-drop-overlay')).toBeNull();
	const chip = await findByTestId('comment-attachment-chip', undefined, { timeout: 15_000 });
	expect(chip.textContent).toContain('screenshot.png');

	// The chip links to the stored asset in a new tab.
	const link = chip.querySelector(
		'[data-testid="comment-attachment-preview"]',
	) as HTMLAnchorElement;
	expect(link.getAttribute('href')).toBeTruthy();
	expect(link.getAttribute('target')).toBe('_blank');

	// The hint row is replaced by the pending row while chips are present.
	expect(queryByTestId('comment-attachment-hint')).toBeNull();

	// Removing the attachment drops the chip and restores the hint.
	await user.click(chip.querySelector('[aria-label="Remove attachment"]') as HTMLElement);
	await waitFor(() =>
		expect(container.querySelectorAll('[data-testid="comment-attachment-chip"]')).toHaveLength(0),
	);
	expect(await findByTestId('comment-attachment-hint')).toBeTruthy();
});

test('the Upload button picks files via the hidden input and uploads them', async () => {
	const { findByTestId, queryByTestId } = await renderTaskPage();

	// The idle hint and the Upload button both show before any chip.
	expect(await findByTestId('comment-attachment-hint')).toBeTruthy();
	await findByTestId('comment-attachment-upload-button');

	// The picker is a native multi-select input pre-filtered to allowed extensions.
	const input = (await findByTestId('comment-attachment-upload-button-input')) as HTMLInputElement;
	expect(input.getAttribute('type')).toBe('file');
	expect(input.multiple).toBe(true);
	expect(input.getAttribute('accept')).toContain('.png');

	const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'picked.png', {
		type: 'image/png',
	});
	// Choosing a file in the OS dialog fires `change` on the hidden input.
	Object.defineProperty(input, 'files', { value: [png], configurable: true });
	fireEvent.change(input);

	const chip = await findByTestId('comment-attachment-chip', undefined, { timeout: 15_000 });
	expect(chip.textContent).toContain('picked.png');

	// The hint is replaced by the chip row, but the Upload button persists so more
	// files can be added — the only way to attach on touch devices.
	expect(queryByTestId('comment-attachment-hint')).toBeNull();
	expect(queryByTestId('comment-attachment-upload-button')).toBeTruthy();
});

test('each content type gets its own chip icon (image/audio/video/document/fallback)', async () => {
	const { zone, container } = await renderTaskPage();

	const files = [
		new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }),
		new File([new Uint8Array([1])], 'b.mp3', { type: 'audio/mpeg' }),
		new File([new Uint8Array([1])], 'c.mp4', { type: 'video/mp4' }),
		new File([new Uint8Array([1])], 'd.pdf', { type: 'application/pdf' }),
		// Chips render through the shared AssetIcon, so markdown gets the document
		// glyph rather than the generic fallback.
		new File([new Uint8Array([1])], 'e.md', { type: 'text/markdown' }),
	];
	fireEvent.drop(zone, dt(files));

	await waitFor(
		() =>
			expect(container.querySelectorAll('[data-testid="comment-attachment-chip"]')).toHaveLength(5),
		{ timeout: 15_000 },
	);
	const text = Array.from(container.querySelectorAll('[data-testid="comment-attachment-chip"]'))
		.map((c) => c.textContent)
		.join(' ');
	for (const name of ['a.png', 'b.mp3', 'c.mp4', 'd.pdf', 'e.md']) {
		expect(text).toContain(name);
	}
});

test('a zip uploads whatever content type the browser declared for it', async () => {
	const { zone, container, findByTestId } = await renderTaskPage();

	// Windows Chrome and Edge declare `application/x-zip-compressed`, which is not
	// itself an allowlisted mime. The client used to re-derive a weaker copy of the
	// server rule and rejected this before it ever left the browser; it now calls
	// the same shared resolver the server does, which lets the extension decide.
	const zip = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'bundle.zip', {
		type: 'application/x-zip-compressed',
	});
	fireEvent.drop(zone, dt([zip]));

	const chip = await findByTestId('comment-attachment-chip', undefined, { timeout: 15_000 });
	expect(chip.textContent).toContain('bundle.zip');
	expect(container.querySelectorAll('[data-testid="comment-attachment-error"]')).toHaveLength(0);
});

test('every allowlisted extension is listed in exactly one tooltip category', () => {
	// The tooltip's type lists are derived from the shared allowlist so they can't
	// drift, but the grouping is hand-written - this is what makes a newly
	// allowlisted extension impossible to leave out of it.
	const categorized = ATTACHMENT_CATEGORIES.flatMap((c) => c.extensions);
	expect(new Set(categorized).size, 'an extension is listed in two categories').toBe(
		categorized.length,
	);
	expect([...categorized].sort()).toEqual(Object.keys(ATTACHMENT_EXTENSIONS).sort());
});

test('client-side rejections (bad extension, oversize) become error chips without uploading', async () => {
	const { zone, container, findAllByTestId } = await renderTaskPage();

	const exe = new File([new Uint8Array([1])], 'virus.exe', {
		type: 'application/x-msdownload',
	});
	const big = new File([new Uint8Array(ATTACHMENT_MAX_BYTES + 1)], 'huge.png', {
		type: 'image/png',
	});
	fireEvent.drop(zone, dt([exe, big]));

	const errors = await findAllByTestId('comment-attachment-error');
	const texts = errors.map((e) => e.textContent ?? '');
	expect(texts.some((t) => t.includes('virus.exe') && t.includes('Unsupported file type'))).toBe(
		true,
	);
	expect(texts.some((t) => t.includes('huge.png') && t.includes('File exceeds 10 MB'))).toBe(true);
	// Nothing was accepted, so no attachment chip rendered.
	expect(container.querySelectorAll('[data-testid="comment-attachment-chip"]')).toHaveLength(0);
});

test('a mixed drop uploads the good file and chips the failed one with the upload error', async () => {
	const { zone, container, findByTestId } = await renderTaskPage();

	const good = new File([new Uint8Array([1])], 'notes-ok.png', { type: 'image/png' });
	// Allowed extension but a disallowed declared MIME — passes the drop zone's
	// extension gate, then the upload mutation rejects it.
	const bad = new File([new Uint8Array([1])], 'notes-bad.png', {
		type: 'application/x-evil',
	});
	fireEvent.drop(zone, dt([good, bad]));

	const chip = await findByTestId('comment-attachment-chip', undefined, { timeout: 15_000 });
	expect(chip.textContent).toContain('notes-ok.png');

	const error = await findByTestId('comment-attachment-error');
	expect(error.textContent).toContain('notes-bad.png');
	expect(error.textContent).toContain('Unsupported content type: application/x-evil');
	expect(container.querySelectorAll('[data-testid="comment-attachment-chip"]')).toHaveLength(1);
});
