import { expect, test } from '@playwright/test';
import {
	authenticate,
	createProjectAndClearPlanning,
	createTeamWithAgents,
	waitForPageLoad,
} from './helpers';

const PNG_BYTES = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

test.describe('Task Comment Attachments', () => {
	async function createTask(page: import('@playwright/test').Page) {
		const { team, token } = await createTeamWithAgents(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projRes = await createProjectAndClearPlanning(page, team.id, token, {
			name: 'Attachments Project',
			description: 'Test project.',
		});
		const project = ((await projRes.json()) as { data: { id: string } }).data;

		const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const agents = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data;

		const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
			headers,
			data: { project_id: project.id, title: 'Attach me', assignee_id: agents[0].id },
		});
		const task = ((await taskRes.json()) as { data: { id: string } }).data;

		return { team, token, task, headers };
	}

	async function dropFile(
		page: import('@playwright/test').Page,
		selector: string,
		filename: string,
		mime: string,
		bytes: number[],
	) {
		await page.evaluate(
			async ({ selector, filename, mime, bytes }) => {
				const el = document.querySelector(selector);
				if (!el) throw new Error(`no element matching ${selector}`);
				const data = new Uint8Array(bytes);
				const file = new File([data], filename, { type: mime });
				const dt = new DataTransfer();
				dt.items.add(file);
				for (const type of ['dragenter', 'dragover', 'drop']) {
					el.dispatchEvent(
						new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }),
					);
				}
			},
			{ selector, filename, mime, bytes: Array.from(bytes) },
		);
	}

	test('drag-drop adds a chip, sends, renders an icon thumb, opens in new tab', async ({
		page,
		context,
	}) => {
		await authenticate(page);
		const { team, task } = await createTask(page);

		await page.goto(`/teams/${team.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);
		await expect(page.getByPlaceholder('Add a comment...')).toBeVisible({ timeout: 20000 });

		await dropFile(
			page,
			'[data-testid="comment-attachments-drop"]',
			'shot.png',
			'image/png',
			Array.from(PNG_BYTES),
		);

		const chip = page.locator('[data-testid="comment-attachment-chip"]', { hasText: 'shot.png' });
		await expect(chip).toBeVisible({ timeout: 10000 });

		const send = page.getByRole('button', { name: 'Comment', exact: true });
		await expect(send).toBeEnabled();
		await send.click();

		const thumb = page
			.locator('[data-testid="comment-attachment-thumb"][data-filename="shot.png"]')
			.first();
		await expect(thumb).toBeVisible({ timeout: 15000 });

		const [popup] = await Promise.all([context.waitForEvent('page'), thumb.click()]);
		await popup.waitForLoadState();
		expect(popup.url()).toContain('/api/assets/');
		await popup.close();
	});

	test('hint with tooltip shows when empty, hides once a chip appears, returns after removal', async ({
		page,
	}) => {
		await authenticate(page);
		const { team, task } = await createTask(page);

		await page.goto(`/teams/${team.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);
		await expect(page.getByPlaceholder('Add a comment...')).toBeVisible({ timeout: 20000 });

		const hint = page.locator('[data-testid="comment-attachment-hint"]');
		await expect(hint).toBeVisible();
		await expect(hint).toContainText('Drag and drop files to attach');

		const info = page.locator('[data-testid="comment-attachment-hint-info"]');
		await info.hover();
		const tooltip = page.getByRole('tooltip');
		await expect(tooltip).toBeVisible({ timeout: 5000 });
		await expect(tooltip).toContainText('PNG');
		await expect(tooltip).toContainText('PDF');
		await expect(tooltip).toContainText('MP3');
		await expect(tooltip).toContainText('MP4');
		await expect(tooltip).toContainText('10');

		await dropFile(
			page,
			'[data-testid="comment-attachments-drop"]',
			'shot.png',
			'image/png',
			Array.from(PNG_BYTES),
		);

		const chip = page.locator('[data-testid="comment-attachment-chip"]', { hasText: 'shot.png' });
		await expect(chip).toBeVisible({ timeout: 10000 });
		await expect(hint).toBeHidden();

		await chip.getByRole('button', { name: 'Remove attachment' }).click();
		await expect(chip).toBeHidden();
		await expect(hint).toBeVisible();
	});

	test('pending chip exposes a preview link with the signed asset URL', async ({ page }) => {
		await authenticate(page);
		const { team, task } = await createTask(page);

		await page.goto(`/teams/${team.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);
		await expect(page.getByPlaceholder('Add a comment...')).toBeVisible({ timeout: 20000 });

		await dropFile(
			page,
			'[data-testid="comment-attachments-drop"]',
			'preview.png',
			'image/png',
			Array.from(PNG_BYTES),
		);

		const preview = page
			.locator('[data-testid="comment-attachment-preview"]')
			.filter({ hasText: 'preview.png' });
		await expect(preview).toBeVisible({ timeout: 10000 });
		await expect(preview).toHaveAttribute('target', '_blank');
		await expect(preview).toHaveAttribute('rel', 'noopener noreferrer');
		const href = await preview.getAttribute('href');
		expect(href).toBeTruthy();
		expect(href).toContain('/api/assets/');
	});

	test('rejects an unsupported extension with an inline error chip', async ({ page }) => {
		await authenticate(page);
		const { team, task } = await createTask(page);

		await page.goto(`/teams/${team.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);
		await expect(page.getByPlaceholder('Add a comment...')).toBeVisible({ timeout: 20000 });

		await dropFile(
			page,
			'[data-testid="comment-attachments-drop"]',
			'virus.exe',
			'application/octet-stream',
			[0, 1, 2],
		);

		const errorChip = page.locator('[data-testid="comment-attachment-error"]');
		await expect(errorChip).toBeVisible({ timeout: 5000 });
		await expect(errorChip).toContainText('virus.exe');
	});

	test('mobile viewport — hint visible, chips wrap and overlay still triggers', async ({
		page,
	}) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await authenticate(page);
		const { team, task } = await createTask(page);

		await page.goto(`/teams/${team.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);
		await expect(page.getByPlaceholder('Add a comment...')).toBeVisible({ timeout: 20000 });

		const hint = page.locator('[data-testid="comment-attachment-hint"]');
		await expect(hint).toBeVisible();
		await expect(hint).toContainText('Drag and drop files to attach');

		await dropFile(
			page,
			'[data-testid="comment-attachments-drop"]',
			'mobile.png',
			'image/png',
			Array.from(PNG_BYTES),
		);

		const chip = page.locator('[data-testid="comment-attachment-chip"]', {
			hasText: 'mobile.png',
		});
		await expect(chip).toBeVisible({ timeout: 10000 });
		await expect(hint).toBeHidden();
		await expect(chip.locator('[data-testid="comment-attachment-preview"]')).toBeVisible();
	});
});
