import { expect, type Page, test } from '@playwright/test';
import { authenticate, createTeamWithAgents, waitForPageLoad } from './helpers';

interface SeededIssue {
	team: { id: string; slug: string };
	token: string;
	issueId: string;
	commentId: string;
	headers: Record<string, string>;
}

async function seedIssueWithComment(page: Page): Promise<SeededIssue> {
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

	const issueRes = await page.request.post(`/api/teams/${team.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Reactions Issue', assignee_id: agents[0].id },
	});
	const issue = ((await issueRes.json()) as { data: { id: string } }).data;

	const commentRes = await page.request.post(`/api/teams/${team.id}/issues/${issue.id}/comments`, {
		headers,
		data: { content_type: 'text', content: { text: 'A comment to react to.' } },
	});
	const comment = ((await commentRes.json()) as { data: { id: string } }).data;

	return { team, token, issueId: issue.id, commentId: comment.id, headers };
}

test.describe('Comment reactions', () => {
	test('add and remove a ✓ reaction toggles the chip', async ({ page }) => {
		await authenticate(page);
		const { team, issueId } = await seedIssueWithComment(page);

		await page.goto(`/teams/${team.slug}/issues/${issueId}`);
		await waitForPageLoad(page);

		const addButton = page.getByTestId('add-reaction-button').first();
		await expect(addButton).toBeVisible({ timeout: 20_000 });

		await addButton.click();
		const picker = page.getByTestId('reaction-picker');
		await expect(picker).toBeVisible();
		await picker.locator('[data-reaction-kind="ack"]').click();

		const chip = page
			.getByTestId('comment-reactions')
			.locator('[data-reaction-kind="ack"]')
			.first();
		await expect(chip).toBeVisible({ timeout: 15_000 });
		await expect(chip).toHaveAttribute('data-you-reacted', 'true');
		await expect(chip).toContainText('1');

		await chip.click();
		await expect(
			page.getByTestId('comment-reactions').locator('[data-reaction-kind="ack"]'),
		).toHaveCount(0, { timeout: 15_000 });
	});

	test('reactions seeded via API render on page load', async ({ page }) => {
		await authenticate(page);
		const { team, issueId, commentId, token } = await seedIssueWithComment(page);

		await page.request.put(
			`/api/teams/${team.id}/issues/${issueId}/comments/${commentId}/reactions/ack`,
			{ headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
		);

		await page.goto(`/teams/${team.slug}/issues/${issueId}`);
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
		const { team, issueId, commentId, headers } = await seedIssueWithComment(page);

		// Pre-snapshot
		const before = await page.request.get(`/api/teams/${team.id}/issues/${issueId}/comments`, {
			headers,
		});
		expect(before.status()).toBe(200);

		await page.goto(`/teams/${team.slug}/issues/${issueId}`);
		await waitForPageLoad(page);

		const addButton = page.getByTestId('add-reaction-button').first();
		await addButton.click();
		await page.getByTestId('reaction-picker').locator('[data-reaction-kind="ack"]').click();

		const chip = page
			.getByTestId('comment-reactions')
			.locator('[data-reaction-kind="ack"]')
			.first();
		await expect(chip).toBeVisible({ timeout: 15_000 });

		// No comments should have been auto-created (the reaction should not have
		// produced a side-effect comment) and the reaction should be present.
		const after = await page.request.get(`/api/teams/${team.id}/issues/${issueId}/comments`, {
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
