// Playwright (not component): the upload flow normalizes the picked image with a
// real canvas — createImageBitmap + canvas.toBlob('image/png') — which happy-dom
// can't execute (reason #3: native input/canvas work the component runner can't
// synthesize). Only a real browser engine produces the cropped PNG that gets
// uploaded, so the end-to-end "pick → crop → save → renders in rail" path lives here.

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

test.describe('Project icon', () => {
	test('upload an image in settings, then it renders in the rail', async ({
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

		// Pick a file — the hidden input drives handleFile → canvas normalize → preview.
		await page.getByTestId('project-icon-input').setInputFiles({
			name: 'logo.png',
			mimeType: 'image/png',
			buffer: Buffer.from(PNG_BYTES),
		});

		// Save the cropped preview; wait for the PUT to land.
		const saveBtn = page.getByTestId('project-icon-save');
		await expect(saveBtn).toBeVisible({ timeout: 15_000 });
		const putResponse = page.waitForResponse(
			(r) =>
				r.url().includes(`/api/projects/${project.slug}/icon`) &&
				r.request().method() === 'PUT' &&
				r.status() === 200,
		);
		await saveBtn.click();
		await putResponse;

		// Settings now reflects the icon: Remove appears, preview holds an <img>.
		await expect(page.getByTestId('project-icon-remove')).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId('project-icon-preview').locator('img')).toBeVisible();

		// The rail avatar for this project renders the icon image, not initials.
		const railAvatar = page.getByTestId(`project-rail-avatar-${project.slug}`);
		await expect(railAvatar.locator('img')).toBeVisible({ timeout: 15_000 });
	});
});
