import { expect, test } from './fixtures';
import {
	createProjectAndClearPlanning,
	saveAndWaitForRefetch,
	taskMatcher,
	uniqueName,
	waitForAgentIdle,
	waitForPageLoad,
} from './helpers';

type Page = import('@playwright/test').Page;

interface SeededTask {
	team: { id: string; slug: string };
	token: string;
	taskId: string;
	commentId: string;
	headers: Record<string, string>;
}

async function seedTaskWithComment(
	page: Page,
	team: { id: string; slug: string },
	token: string,
	agents: Array<{ id: string }>,
): Promise<SeededTask> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const projRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Reactions Project'),
		description: 'x',
	});
	const project = ((await projRes.json()) as { data: { id: string } }).data;

	const assigneeId = agents[0].id;

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Reactions Task', assignee_id: assigneeId },
	});
	const task = ((await taskRes.json()) as { data: { id: string } }).data;

	const commentRes = await page.request.post(`/api/teams/${team.id}/tasks/${task.id}/comments`, {
		headers,
		data: { content_type: 'text', content: { text: 'A comment to react to.' } },
	});
	const comment = ((await commentRes.json()) as { data: { id: string } }).data;

	// Drain the assignment-driven wakeup so the comment thread isn't re-rendering
	// under the test's click on the reaction picker.
	await waitForAgentIdle(page, team.id, assigneeId, token);

	return { team, token, taskId: task.id, commentId: comment.id, headers };
}

test.describe('Comment reactions', () => {
	test('add and remove a ✓ reaction toggles the chip', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, taskId } = await seedTaskWithComment(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents,
		);

		await page.goto(`/teams/${team.slug}/tasks/${taskId}`);
		await waitForPageLoad(page);

		const addButton = page.getByTestId('add-reaction-button').first();
		await expect(addButton).toBeVisible({ timeout: 20_000 });

		await addButton.click();
		const picker = page.getByTestId('reaction-picker');
		await expect(picker).toBeVisible();

		// Wait for both the PUT mutation and the GET refetch that React Query's
		// onSettled triggers, so the chip is in the DOM before we assert on it.
		await saveAndWaitForRefetch(page, picker.locator('[data-reaction-kind="ack"]'), {
			mutation: (url, method) => method === 'PUT' && /\/reactions\/ack$/.test(url.pathname),
			refetch: taskMatcher({
				teamId: team.slug,
				taskId: taskId,
				subResource: 'comments',
				method: 'GET',
			}),
		});

		const chip = page
			.getByTestId('comment-reactions')
			.locator('[data-reaction-kind="ack"]')
			.first();
		await expect(chip).toBeVisible({ timeout: 25_000 });
		await expect(chip).toHaveAttribute('data-you-reacted', 'true');
		await expect(chip).toContainText('1');

		await saveAndWaitForRefetch(page, chip, {
			mutation: (url, method) => method === 'DELETE' && /\/reactions\/ack$/.test(url.pathname),
			refetch: taskMatcher({
				teamId: team.slug,
				taskId: taskId,
				subResource: 'comments',
				method: 'GET',
			}),
		});

		await expect(
			page.getByTestId('comment-reactions').locator('[data-reaction-kind="ack"]'),
		).toHaveCount(0, { timeout: 25_000 });
	});

	test('reactions seeded via API render on page load', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, taskId, commentId, token } = await seedTaskWithComment(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents,
		);

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

	test('reacting does not fire any agent wakeups', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, taskId, commentId, headers } = await seedTaskWithComment(
			page,
			sharedWorkspace.team,
			sharedWorkspace.token,
			sharedWorkspace.agents,
		);

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
		await saveAndWaitForRefetch(
			page,
			page.getByTestId('reaction-picker').locator('[data-reaction-kind="ack"]'),
			{
				mutation: (url, method) => method === 'PUT' && /\/reactions\/ack$/.test(url.pathname),
				refetch: taskMatcher({
					teamId: team.slug,
					taskId: taskId,
					subResource: 'comments',
					method: 'GET',
				}),
			},
		);

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
