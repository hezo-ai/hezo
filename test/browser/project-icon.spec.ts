// Playwright (not component): the upload flow normalizes the picked image with a
// real canvas — createImageBitmap + canvas.toBlob('image/png') — which happy-dom
// can't execute (reason #3: native input/canvas work the component runner can't
// synthesize). This spec covers exactly that browser-specific path: pick a file →
// real canvas crop → upload → the settings control reflects the saved icon.
//
// It deliberately does NOT assert the served <img> actually paints. That depends
// on a network image load of the signed icon URL, which is flaky on the saturated
// single-PGlite e2e server (and the Avatar's onError fallback hides the <img> if
// that GET is slow). The "renders an <img> when icon_url is set" behaviour is
// covered deterministically by the component test (packages/web) and the signed-URL
// serve is covered by the server test (packages/server/test/project-icon.test.ts).

import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

// A small but fully-valid 1×1 PNG the browser can decode and re-encode.
const PNG_BYTES = [
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
];

// Generous waits: the e2e server is a single-connection PGlite shared by 4 parallel
// workers, so an upload's queries can queue behind other workers' under load.
const UPLOAD_WAIT_MS = 60_000;

test.describe('Project icon', () => {
	test('upload an image in settings via the real canvas-crop flow', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const project = await createProjectAndClearPlanning(page, '', sharedWorkspace.token, {
			name: uniqueName('Iconic'),
			description: 'Project icon e2e.',
		});

		await page.goto(`/projects/${project.slug}/settings`);
		await waitForPageLoad(page);

		// First-run state: Upload image, no Remove.
		await expect(page.getByTestId('project-icon-upload')).toContainText('Upload image');
		await expect(page.getByTestId('project-icon-remove')).toHaveCount(0);

		// Arm the upload-response wait before interacting. Match the PUT by URL+method
		// (not status) so a non-2xx fails loud on the assertion below instead of hanging.
		const uploadResponse = page.waitForResponse(
			(r) =>
				r.url().includes(`/api/projects/${project.slug}/icon`) && r.request().method() === 'PUT',
			{ timeout: UPLOAD_WAIT_MS },
		);

		// Pick a file — the hidden input drives handleFile → real canvas normalize → preview.
		await page.getByTestId('project-icon-input').setInputFiles({
			name: 'logo.png',
			mimeType: 'image/png',
			buffer: Buffer.from(PNG_BYTES),
		});

		// The Save button only appears once the canvas produced a cropped preview blob.
		const saveBtn = page.getByTestId('project-icon-save');
		await expect(saveBtn).toBeVisible({ timeout: 30_000 });
		await saveBtn.click();

		const res = await uploadResponse;
		expect(res.status()).toBe(200);

		// The upload response carries the signed icon_url, which the hook writes into the
		// project caches — so the control flips to Replace/Remove without a refetch.
		await expect(page.getByTestId('project-icon-remove')).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId('project-icon-upload')).toContainText('Replace image');
	});
});
