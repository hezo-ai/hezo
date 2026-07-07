import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// The reusable file-attachment kit (useFileAttachments + FileDropZone +
// AttachmentChips + the iconOnly UploadButton) wired into the CEO chatbox.
// Uploading a file hits POST /api/chat/assets in the in-process backend and shows
// a pending chip; the drag-drop overlay + native drag events are covered in
// Playwright (decision-tree item 3).

const pngFile = () =>
	new File([new Uint8Array([137, 80, 78, 71])], 'diagram.png', { type: 'image/png' });

test('the paperclip attach control renders in the composer', async () => {
	const { findByTestId, getByTestId } = await renderApp({ initialPath: '/home' });
	(await findByTestId('chat-launcher')).click();
	await findByTestId('chat-panel');
	expect(getByTestId('chat-attach')).toBeTruthy();
});

test('attaching a file shows a pending chip and enables send with no text', async () => {
	const { findByTestId, getByTestId, user } = await renderApp({ initialPath: '/home' });
	(await findByTestId('chat-launcher')).click();
	await findByTestId('chat-panel');

	const send = getByTestId('chat-send') as HTMLButtonElement;
	expect(send.disabled).toBe(true);

	// Pick a file through the hidden input the UploadButton renders.
	const input = getByTestId('chat-attach-input') as HTMLInputElement;
	await user.upload(input, pngFile());

	// The uploaded file resolves to a chip in the composer…
	const chip = await findByTestId('chat-attachment-chip');
	expect(chip.textContent).toContain('diagram.png');
	// …and send is enabled even though the textarea is empty.
	await waitFor(() => expect(send.disabled).toBe(false));
});
