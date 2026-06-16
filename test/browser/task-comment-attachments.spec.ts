import { expect, test } from './fixtures';
import {
	createProjectAndClearPlanning,
	uniqueName,
	waitForAgentIdle,
	waitForPageLoad,
} from './helpers';

const PNG_BYTES = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

// Attachment chips/previews only render after the dropped file's upload
// round-trips to the server (handleFiles → upload.mutateAsync). Under CI load
// (parallel workers + 1 Hz agent cron + dev-mode Vite) that can outrun
// Playwright's default, so wait as generously as the composer's own load wait.
const UPLOAD_WAIT_MS = 20_000;

test.describe('Task Comment Attachments', () => {
	async function createTask(page: import('@playwright/test').Page, token: string) {
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projRes = await createProjectAndClearPlanning(page, '', token, {
			name: uniqueName('Attachments Project'),
			description: 'Test project.',
		});
		const project = (
			(await projRes.json()) as { data: { id: string; slug: string; team_slug: string } }
		).data;

		const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
		const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
		const assigneeId = (agents.find((a) => a.slug === 'captain') ?? agents[0]).id;

		const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
			headers,
			data: { project_id: project.id, title: 'Attach me', assignee_id: assigneeId },
		});
		const task = ((await taskRes.json()) as { data: { id: string } }).data;

		await waitForAgentIdle(page, project.team_slug, assigneeId, token);

		return { token, task, project, headers };
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
		sharedPage: page,
		context,
		sharedWorkspace,
	}) => {
		const { task, project } = await createTask(page, sharedWorkspace.token);

		await page.goto(`/projects/${project.slug}/tasks/${task.id}`);
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
		await expect(chip).toBeVisible({ timeout: UPLOAD_WAIT_MS });

		const send = page.getByRole('button', { name: 'Comment', exact: true });
		await expect(send).toBeEnabled();
		await send.click();

		const thumb = page
			.locator('[data-testid="comment-attachment-thumb"][data-filename="shot.png"]')
			.first();
		await expect(thumb).toBeVisible({ timeout: UPLOAD_WAIT_MS });

		const [popup] = await Promise.all([context.waitForEvent('page'), thumb.click()]);
		await popup.waitForLoadState();
		expect(popup.url()).toContain('/api/assets/');
		await popup.close();
	});

	test('hint with tooltip shows when empty, hides once a chip appears, returns after removal', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { task, project } = await createTask(page, sharedWorkspace.token);

		await page.goto(`/projects/${project.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);
		await expect(page.getByPlaceholder('Add a comment...')).toBeVisible({ timeout: 20000 });

		const hint = page.locator('[data-testid="comment-attachment-hint"]');
		await expect(hint).toBeVisible();
		await expect(hint).toContainText('Drag and drop files to attach');

		const info = page.locator('[data-testid="comment-attachment-hint-info"]');
		const tooltip = page.getByRole('tooltip');
		// Radix opens this tooltip immediately on keyboard focus, but on hover only
		// after a delay and only while the synthetic pointer stays put — in headless
		// Chromium that hover open is unreliable and can be missed for the whole poll
		// window. Drive it by focusing the trigger (deterministic), with a hover as a
		// secondary nudge, and re-assert under toPass so a stray blur/re-render while
		// the form settles self-heals.
		await expect(async () => {
			await page.mouse.move(0, 0);
			await info.hover();
			await info.focus();
			await expect(tooltip).toBeVisible({ timeout: 2500 });
			const text = (await tooltip.textContent()) ?? '';
			expect(text).toContain('PNG');
			expect(text).toContain('PDF');
			expect(text).toContain('MP3');
			expect(text).toContain('MP4');
			expect(text).toContain('10');
		}).toPass({ timeout: 15000 });

		await dropFile(
			page,
			'[data-testid="comment-attachments-drop"]',
			'shot.png',
			'image/png',
			Array.from(PNG_BYTES),
		);

		const chip = page.locator('[data-testid="comment-attachment-chip"]', { hasText: 'shot.png' });
		await expect(chip).toBeVisible({ timeout: UPLOAD_WAIT_MS });
		await expect(hint).toBeHidden();

		await chip.getByRole('button', { name: 'Remove attachment' }).click();
		await expect(chip).toBeHidden();
		await expect(hint).toBeVisible();
	});

	test('pending chip exposes a preview link with the signed asset URL', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { task, project } = await createTask(page, sharedWorkspace.token);

		await page.goto(`/projects/${project.slug}/tasks/${task.id}`);
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
		await expect(preview).toBeVisible({ timeout: UPLOAD_WAIT_MS });
		await expect(preview).toHaveAttribute('target', '_blank');
		await expect(preview).toHaveAttribute('rel', 'noopener noreferrer');
		const href = await preview.getAttribute('href');
		expect(href).toBeTruthy();
		expect(href).toContain('/api/assets/');
	});

	test('rejects an unsupported extension with an inline error chip', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { task, project } = await createTask(page, sharedWorkspace.token);

		await page.goto(`/projects/${project.slug}/tasks/${task.id}`);
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
		sharedPage: page,
		sharedWorkspace,
	}) => {
		await page.setViewportSize({ width: 375, height: 812 });
		const { task, project } = await createTask(page, sharedWorkspace.token);

		await page.goto(`/projects/${project.slug}/tasks/${task.id}`);
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
		await expect(chip).toBeVisible({ timeout: UPLOAD_WAIT_MS });
		await expect(hint).toBeHidden();
		await expect(chip.locator('[data-testid="comment-attachment-preview"]')).toBeVisible();
	});
});
