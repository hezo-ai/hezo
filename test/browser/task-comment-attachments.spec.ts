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
// round-trips to the server (handleFiles → upload.mutateAsync) and the composer
// commits its local state. The historical first-attempt failures here were not
// upload latency: they were the route's UUID→identifier canonicalization redirect
// remounting CommentComposer mid-upload and wiping its pending-attachment state
// (see openTaskDetail below), which no timeout could rescue. With canonical
// navigation that race is gone; this generous budget is just headroom for genuine
// PGlite saturation — the e2e server runs on a single-connection PGlite, so every
// query from all four parallel workers serialises through it and a burst can queue
// the upload's handful of queries behind other workers' requests.
const UPLOAD_WAIT_MS = 30_000;

test.describe('Task Comment Attachments', () => {
	// The task is assigned to the Captain because the API requires every task to
	// carry an agent assignee. `waitForAgentIdle` then drains the Captain's
	// assignment-triggered run before the test interacts, so a synthetic run
	// comment can't land mid-assertion.
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
		const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

		await waitForAgentIdle(page, project.team_slug, assigneeId, token);

		return { token, task, project, headers };
	}

	// Open a task's detail page ready for composer interaction. Navigate by the
	// canonical friendly identifier, NOT task.id (UUID): a UUID URL triggers the
	// route's canonicalization redirect (routes/.../$taskId.tsx), which changes the
	// useTask query key, drops the page to its `isLoading` branch, and remounts
	// CommentComposer — wiping the composer-local pendingAttachmentIds/metaById. If
	// that remount races an in-flight upload, the chip/thumb/preview never renders
	// and no UPLOAD_WAIT_MS can save it. Friendly-id navigation is already canonical,
	// so the redirect never fires and the composer stays mounted across the upload.
	async function openTaskDetail(
		page: import('@playwright/test').Page,
		projectSlug: string,
		task: { identifier: string },
	) {
		const friendlyId = task.identifier.toLowerCase();
		await page.goto(`/projects/${projectSlug}/tasks/${friendlyId}`);
		await waitForPageLoad(page);
		// Cheap regression guard: passes instantly when already canonical; if anyone
		// reverts to UUID navigation it forces the redirect to settle before we touch
		// the composer (the agent-run-logs.spec.ts safety pattern).
		await expect(page).toHaveURL(new RegExp(`/tasks/${friendlyId}$`));
		await expect(page.getByPlaceholder('Add a comment...')).toBeVisible({ timeout: 20000 });
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

	// Dispatch a drop and confirm it actually reached the handler by waiting for the
	// upload POST to fire. A registered drop kicks off `upload.mutateAsync` (the
	// POST) synchronously, so if no request appears within a few seconds the
	// synthetic DragEvent was swallowed (handler not yet bound / lost under CI
	// load) and we re-dispatch. We key off the *request*, never the response: a
	// genuinely slow upload must not be mistaken for a lost drop, or the retry
	// would fire a second upload and the composer (which does not dedupe) would
	// render two chips.
	async function dropFileAndAwaitUpload(
		page: import('@playwright/test').Page,
		taskId: string,
		selector: string,
		filename: string,
		mime: string,
		bytes: number[],
	) {
		for (let attempt = 0; attempt < 3; attempt++) {
			const uploadStarted = page
				.waitForRequest(
					(r) => r.method() === 'POST' && r.url().includes(`/tasks/${taskId}/assets`),
					{ timeout: 5000 },
				)
				.catch(() => null);
			await dropFile(page, selector, filename, mime, bytes);
			if (await uploadStarted) return;
		}
		throw new Error(`drop on ${selector} never triggered an upload for task ${taskId}`);
	}

	test('drag-drop adds a chip, sends, renders an icon thumb, opens in new tab', async ({
		sharedPage: page,
		context,
		sharedWorkspace,
	}) => {
		const { task, project } = await createTask(page, sharedWorkspace.token);

		await openTaskDetail(page, project.slug, task);

		await dropFileAndAwaitUpload(
			page,
			task.id,
			'[data-testid="comment-attachments-drop"]',
			'shot.png',
			'image/png',
			Array.from(PNG_BYTES),
		);

		const chip = page.locator('[data-testid="comment-attachment-chip"]', { hasText: 'shot.png' });
		await expect(chip).toBeVisible({ timeout: UPLOAD_WAIT_MS });

		// Don't wake the Captain on submit: its synthetic run would post a run
		// comment and re-render the thread while we're waiting on the attachment
		// thumb below, adding avoidable load and re-render races. The thumb is what
		// this test asserts, not the agent run.
		await page.getByRole('checkbox', { name: 'Wake assignee on submit' }).uncheck();

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

		await openTaskDetail(page, project.slug, task);

		const hint = page.locator('[data-testid="comment-attachment-hint"]');
		await expect(hint).toBeVisible();
		await expect(hint).toContainText('Drag and drop files to attach');

		const info = page.locator('[data-testid="comment-attachment-hint-info"]');
		const tooltip = page.getByRole('tooltip');
		// Radix opens this tooltip in its trigger's `onFocus` handler, which fires
		// only on an actual focus *change* — and its hover-open is unreliable in
		// headless Chromium (the pointer has to land and stay put through the delay).
		// So drive it by focus, but blur first on every attempt: if a previous
		// attempt left the trigger focused while a settle re-render closed the
		// tooltip, re-focusing an already-focused element is a no-op that never
		// re-opens it, and the poll would spin until timeout. Park the pointer away
		// first so a stray hover open/close can't race the focus path.
		await page.mouse.move(0, 0);
		await expect(async () => {
			await info.blur();
			await info.focus();
			await expect(tooltip).toBeVisible({ timeout: 2500 });
			const text = (await tooltip.textContent()) ?? '';
			expect(text).toContain('PNG');
			expect(text).toContain('PDF');
			expect(text).toContain('MP3');
			expect(text).toContain('MP4');
			expect(text).toContain('10');
		}).toPass({ timeout: 15000 });

		await dropFileAndAwaitUpload(
			page,
			task.id,
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

		await openTaskDetail(page, project.slug, task);

		await dropFileAndAwaitUpload(
			page,
			task.id,
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

		await openTaskDetail(page, project.slug, task);

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

		await openTaskDetail(page, project.slug, task);

		const hint = page.locator('[data-testid="comment-attachment-hint"]');
		await expect(hint).toBeVisible();
		await expect(hint).toContainText('Drag and drop files to attach');

		await dropFileAndAwaitUpload(
			page,
			task.id,
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
