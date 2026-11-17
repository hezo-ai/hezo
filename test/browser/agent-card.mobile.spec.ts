import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, waitForPageLoad } from './helpers';

// The agent card on a phone. Browser tier for #2 (viewport): a phone has no
// hover, so a real touch tap must open the card rather than navigate; and #1
// (real layout): the card must sit inside the 390px screen. The card's content,
// links and chat shortcut are covered in the component tier (agent-card.test.tsx).

test.use({ hasTouch: true, isMobile: true });

async function openTaskWithAssignee(page: Page, token: string, name: string) {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const projectRes = await createProjectAndClearPlanning(page, '', token, { name });
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
	const agents = (
		(await agentsRes.json()) as {
			data: Array<{ id: string; slug: string; title: string; is_instance?: boolean }>;
		}
	).data;
	const agent = agents.find((a) => a.slug === 'captain') ?? agents.find((a) => !a.is_instance)!;

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Agent Card Task', assignee_id: agent.id },
	});
	const task = ((await taskRes.json()) as { data: { identifier: string } }).data;

	await page.goto(`/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'Agent Card Task' })).toBeVisible({
		timeout: 20000,
	});
	return { project, agent };
}

test.describe('Agent card - phone (390px, touch)', () => {
	test('a tap opens the card inside the screen, and its chat link opens the chat', async ({
		page,
		freshWorkspace,
	}) => {
		const { agent } = await openTaskWithAssignee(page, freshWorkspace.token, 'Agent Card Phone');
		const taskUrl = page.url();

		await page.getByTestId('task-assignee-inline-link').tap();

		const card = page.getByTestId('agent-card');
		await expect(card).toBeVisible();
		expect(page.url()).toBe(taskUrl);
		const box = await card.boundingBox();
		const viewport = page.viewportSize()!;
		expect(box).not.toBeNull();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
		expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);

		await page.getByTestId('agent-card-chat').tap();
		await expect(page.getByTestId('chat-panel')).toBeVisible();
		await expect(page.getByTestId('chat-room-title')).toHaveText(agent.title);
		await expect(card).toBeHidden();
		expect(page.url()).toBe(taskUrl);
	});

	test('the card closes on a tap outside, and its page link opens the agent page', async ({
		page,
		freshWorkspace,
	}) => {
		const { project, agent } = await openTaskWithAssignee(
			page,
			freshWorkspace.token,
			'Agent Card Phone Nav',
		);
		const name = page.getByTestId('task-assignee-inline-link');
		const card = page.getByTestId('agent-card');

		await name.tap();
		await expect(card).toBeVisible();
		await page.getByRole('heading', { name: 'Agent Card Task' }).tap();
		await expect(card).toBeHidden();

		await name.tap();
		await page.getByTestId('agent-card-page-link').tap();
		// The agent page opens on its default tab, a sub-path of the page.
		await expect(page).toHaveURL(new RegExp(`/projects/${project.slug}/agents/${agent.slug}(/|$)`));
	});
});
