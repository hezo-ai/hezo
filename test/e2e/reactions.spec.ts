import { expect, type Page, test } from '@playwright/test';
import {
	authenticate,
	clickAndWaitForResponse,
	createTeamWithAgents,
	waitForPageLoad,
} from './helpers';

interface SeededTask {
	team: { id: string; slug: string };
	token: string;
	taskId: string;
	commentId: string;
	headers: Record<string, string>;
}

async function seedTaskWithComment(page: Page): Promise<SeededTask> {
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const projRes = await page.request.post(`/api/teams/${team.id}/projects`, {
		headers,
		data: { name: 'Reactions Project', description: 'x' },
	});
	const project = ((await projRes.json()) as { data: { id: string } }).data;

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data;

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Reactions Task', assignee_id: agents[0].id },
	});
	const task = ((await taskRes.json()) as { data: { id: string } }).data;

	const commentRes = await page.request.post(`/api/teams/${team.id}/tasks/${task.id}/comments`, {
		headers,
		data: { content_type: 'text', content: { text: 'A comment to react to.' } },
	});
	const comment = ((await commentRes.json()) as { data: { id: string } }).data;

	return { team, token, taskId: task.id, commentId: comment.id, headers };
}

test.describe('Comment reactions', () => {
	// Shared e2e server + parallel workers can delay comment thread paint; allow an extra retry.
	test.describe.configure({ retries: 2 });

	test('add and remove a ✓ reaction toggles the chip', async ({ page }) => {
		await authenticate(page);
		const { team, taskId } = await seedTaskWithComment(page);

		await page.goto(`/teams/${team.slug}/tasks/${taskId}`);
		await waitForPageLoad(page);

		const addButton = page.getByTestId('add-reaction-button').first();
		await expect(addButton).toBeVisible({ timeout: 20_000 });

		await addButton.click();
		const picker = page.getByTestId('reaction-picker');
		await expect(picker).toBeVisible();
		const addResponse = await clickAndWaitForResponse(
			page,
			picker.locator('[data-reaction-kind="ack"]'),
			(url, method) => method === 'PUT' && /\/reactions\/ack$/.test(url.pathname),
		);
		expect(addResponse.ok()).toBe(true);

		const chip = page
			.getByTestId('comment-reactions')
			.locator('[data-reaction-kind="ack"]')
			.first();
		await expect(chip).toBeVisible({ timeout: 25_000 });
		await expect(chip).toHaveAttribute('data-you-reacted', 'true');
		await expect(chip).toContainText('1');

		const removeResponse = await clickAndWaitForResponse(
			page,
			chip,
			(url, method) => method === 'DELETE' && /\/reactions\/ack$/.test(url.pathname),
		);
		expect(removeResponse.ok()).toBe(true);
		await expect(
			page.getByTestId('comment-reactions').locator('[data-reaction-kind="ack"]'),
		).toHaveCount(0, { timeout: 25_000 });
	});

	test('reactions seeded via API render on page load', async ({ page }) => {
		await authenticate(page);
		const { team, taskId, commentId, token } = await seedTaskWithComment(page);

		await page.request.put(
			`/api/teams/${team.id}/tasks/${taskId}/comments/${commentId}/reactions/ack`,
			{ headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
		);

		await page.goto(`/teams/${team.slug}/tasks/${taskId}`);
		await waitForPageLoad(page);

		const chip = page
			.getByTestId('comment-reactions')
			.locator('[data-reaction-kind="ack"]')
			.first();
		await expect(chip).toBeVisible({ timeout: 20_000 });
		await expect(chip).toContainText('1');
		await expect(chip).toHaveAttribute('data-you-reacted', 'true');
	});

	test('reacting does not fire any agent wakeups', async ({ page }) => {
		await authenticate(page);
		const { team, taskId, commentId, headers } = await seedTaskWithComment(page);

		await page.goto(`/teams/${team.slug}/tasks/${taskId}`);
		await waitForPageLoad(page);

		const addButton = page.getByTestId('add-reaction-button').first();
		await expect(addButton).toBeVisible({ timeout: 20_000 });

		// Snapshot AFTER the page has loaded — onboarding/assignment side-effects
		// can land as additional comments between team creation and navigation.
		const before = await page.request.get(`/api/teams/${team.id}/tasks/${taskId}/comments`, {
			headers,
		});
		expect(before.status()).toBe(200);

		await addButton.click();
		const addResponse = await clickAndWaitForResponse(
			page,
			page.getByTestId('reaction-picker').locator('[data-reaction-kind="ack"]'),
			(url, method) => method === 'PUT' && /\/reactions\/ack$/.test(url.pathname),
		);
		expect(addResponse.ok()).toBe(true);

		const chip = page
			.getByTestId('comment-reactions')
			.locator('[data-reaction-kind="ack"]')
			.first();
		await expect(chip).toBeVisible({ timeout: 15_000 });

		// No comments should have been auto-created (the reaction should not have
		// produced a side-effect comment) and the reaction should be present.
		const after = await page.request.get(`/api/teams/${team.id}/tasks/${taskId}/comments`, {
			headers,
		});
		const beforeRows = ((await before.json()) as { data: Array<{ id: string }> }).data;
		const afterRows = (
			(await after.json()) as {
				data: Array<{ id: string; reactions?: Array<{ kind: string; members: unknown[] }> }>;
			}
		).data;
		expect(afterRows.length).toBe(beforeRows.length);
		const c = afterRows.find((r) => r.id === commentId);
		expect(c?.reactions?.find((r) => r.kind === 'ack')?.members).toHaveLength(1);
	});
});
