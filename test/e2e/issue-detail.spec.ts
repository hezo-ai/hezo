import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, waitForPageLoad } from './helpers';

type Page = import('@playwright/test').Page;

async function createProjectViaApi(
	page: Page,
	teamId: string,
	token: string,
	name: string,
	description: string,
): Promise<{ id: string; slug: string }> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const res = await page.request.post(`/api/teams/${teamId}/projects`, {
		headers,
		data: { name, description },
	});
	return ((await res.json()) as { data: { id: string; slug: string } }).data;
}

async function createIssueViaApi(
	page: Page,
	teamId: string,
	token: string,
	data: { project_id: string; title: string; assignee_id: string; description?: string },
) {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const res = await page.request.post(`/api/teams/${teamId}/issues`, { headers, data });
	return (
		(await res.json()) as {
			data: { id: string; identifier: string; title: string };
		}
	).data;
}

async function createSubIssueViaApi(
	page: Page,
	teamId: string,
	token: string,
	parentId: string,
	data: { title: string; assignee_id: string },
) {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const res = await page.request.post(`/api/teams/${teamId}/issues/${parentId}/sub-issues`, {
		headers,
		data,
	});
	return ((await res.json()) as { data: { id: string; identifier: string; title: string } }).data;
}

test.describe('Issue detail — breadcrumbs and depth', () => {
	test('breadcrumb walks the parent chain on a sub-sub-issue', async ({ page, freshWorkspace }) => {
		const { team, agents, token } = freshWorkspace;
		const engineer = agents.find((a) => a.slug === 'engineer') ?? agents[0];

		const project = await createProjectViaApi(
			page,
			team.id,
			token,
			'Breadcrumb Project',
			'Seeded for breadcrumb test.',
		);

		const root = await createIssueViaApi(page, team.id, token, {
			project_id: project.id,
			title: 'Root Issue',
			assignee_id: engineer.id,
		});
		const sub = await createSubIssueViaApi(page, team.id, token, root.id, {
			title: 'Sub Issue',
			assignee_id: engineer.id,
		});
		const subSub = await createSubIssueViaApi(page, team.id, token, sub.id, {
			title: 'Sub-Sub Issue',
			assignee_id: engineer.id,
		});

		await page.goto(
			`/teams/${team.id}/projects/${project.slug}/issues/${subSub.identifier.toLowerCase()}`,
		);
		await waitForPageLoad(page);
		await expect(page.getByRole('heading', { name: 'Sub-Sub Issue' })).toBeVisible({
			timeout: 20000,
		});

		const breadcrumb = page.getByTestId('breadcrumb');
		await expect(breadcrumb).toContainText(root.identifier);
		await expect(breadcrumb).toContainText(sub.identifier);
		await expect(breadcrumb).toContainText(subSub.identifier);

		const rootLink = breadcrumb.getByRole('link', { name: root.identifier });
		await expect(rootLink).toBeVisible();
		await rootLink.click();
		await expect(page.getByRole('heading', { name: 'Root Issue' })).toBeVisible({
			timeout: 20000,
		});
	});

	test('breadcrumb on a top-level issue shows no ancestors', async ({ page, freshWorkspace }) => {
		const { team, agents, token } = freshWorkspace;
		const engineer = agents.find((a) => a.slug === 'engineer') ?? agents[0];

		const project = await createProjectViaApi(
			page,
			team.id,
			token,
			'Top Project',
			'Top-level breadcrumb check.',
		);
		const issue = await createIssueViaApi(page, team.id, token, {
			project_id: project.id,
			title: 'Top-Level Issue',
			assignee_id: engineer.id,
		});

		await page.goto(
			`/teams/${team.id}/projects/${project.slug}/issues/${issue.identifier.toLowerCase()}`,
		);
		await waitForPageLoad(page);
		await expect(page.getByRole('heading', { name: 'Top-Level Issue' })).toBeVisible({
			timeout: 20000,
		});

		const breadcrumb = page.getByTestId('breadcrumb');
		await expect(breadcrumb).toContainText('Issues');
		await expect(breadcrumb).toContainText(issue.identifier);
		await expect(breadcrumb.getByRole('link')).toHaveCount(3);
	});

	test('UI surfaces the depth-cap error when creating a sub-issue under a depth-2 ticket', async ({
		page,
		freshWorkspace,
	}) => {
		const { team, agents, token } = freshWorkspace;
		const engineer = agents.find((a) => a.slug === 'engineer') ?? agents[0];

		const project = await createProjectViaApi(
			page,
			team.id,
			token,
			'Depth Project',
			'Depth-cap UI check.',
		);
		const root = await createIssueViaApi(page, team.id, token, {
			project_id: project.id,
			title: 'Depth Root',
			assignee_id: engineer.id,
		});
		const sub = await createSubIssueViaApi(page, team.id, token, root.id, {
			title: 'Depth Sub',
			assignee_id: engineer.id,
		});
		const subSub = await createSubIssueViaApi(page, team.id, token, sub.id, {
			title: 'Depth Sub-Sub',
			assignee_id: engineer.id,
		});

		await page.goto(
			`/teams/${team.id}/projects/${project.slug}/issues/${subSub.identifier.toLowerCase()}`,
		);
		await waitForPageLoad(page);
		await expect(page.getByRole('heading', { name: 'Depth Sub-Sub' })).toBeVisible({
			timeout: 20000,
		});

		await page.getByTestId('sub-issues-add').click();
		await page.getByTestId('sub-issue-title-input').fill('Should be rejected');
		await page.getByRole('button', { name: 'Create', exact: true }).click();

		await expect(page.getByTestId('sub-issue-error')).toContainText(/2 levels deep/);
	});
});

test.describe('Issue detail — friendly URLs and mentions', () => {
	test('canonical issue URL is project-scoped; short and UUID forms redirect', async ({
		page,
		freshWorkspace,
	}) => {
		const { team, agents, token } = freshWorkspace;
		const captain = agents.find((a) => a.slug === 'captain')!;

		const project = await createProjectAndClearPlanning(page, team.id, token, {
			name: 'URL Test Project',
			description: 'Validates friendly issue URLs.',
		});
		const issue = await createIssueViaApi(page, team.id, token, {
			project_id: project.id,
			title: 'Friendly URL issue',
			assignee_id: captain.id,
		});

		const friendly = issue.identifier.toLowerCase();
		const canonicalPath = `/teams/${team.slug}/projects/${project.slug}/issues/${friendly}`;

		await page.goto(canonicalPath);
		await expect(page.getByRole('heading', { name: issue.title })).toBeVisible();
		expect(new URL(page.url()).pathname).toBe(canonicalPath);

		await page.goto(`/teams/${team.slug}/issues/${friendly}`);
		await page.waitForURL(`**${canonicalPath}`, { timeout: 20000 });
		expect(new URL(page.url()).pathname).toBe(canonicalPath);
		await expect(page.getByRole('heading', { name: issue.title })).toBeVisible();

		await page.goto(`/teams/${team.slug}/issues/${issue.id}`);
		await page.waitForURL(`**${canonicalPath}`, { timeout: 20000 });
		expect(new URL(page.url()).pathname).toBe(canonicalPath);

		await page.goto(`/teams/${team.slug}/projects/${project.slug}/issues/${issue.id}`);
		await page.waitForURL(`**${canonicalPath}`, { timeout: 20000 });
		expect(new URL(page.url()).pathname).toBe(canonicalPath);
	});

	test('bare ticket identifier renders as a tooltip-ed link and navigates to the target issue', async ({
		page,
		freshWorkspace,
	}) => {
		const { team, agents, token } = freshWorkspace;
		const captain = agents.find((a) => a.slug === 'captain')!;

		const projA = await createProjectAndClearPlanning(page, team.id, token, {
			name: 'Mention Source',
			description: 'Source project for mention test.',
		});
		const projB = await createProjectAndClearPlanning(page, team.id, token, {
			name: 'Mention Target',
			description: 'Target project for mention test.',
		});

		const target = await createIssueViaApi(page, team.id, token, {
			project_id: projB.id,
			title: 'Target issue title goes here',
			assignee_id: captain.id,
		});
		const source = await createIssueViaApi(page, team.id, token, {
			project_id: projA.id,
			title: 'Source issue',
			description: `See also ${target.identifier} for related work.`,
			assignee_id: captain.id,
		});

		await page.goto(
			`/teams/${team.slug}/projects/${projA.slug}/issues/${source.identifier.toLowerCase()}`,
		);
		await expect(page.getByRole('heading', { name: 'Source issue' })).toBeVisible();

		const mentionLink = page.getByTestId('issue-mention-link').first();
		await expect(mentionLink).toBeVisible();
		await expect(mentionLink).toContainText(target.identifier);

		await mentionLink.hover();
		await expect(page.getByText(target.title, { exact: true })).toBeVisible();

		await mentionLink.click();
		await expect(page.getByRole('heading', { name: target.title })).toBeVisible();
		const targetPath = `/teams/${team.slug}/projects/${projB.slug}/issues/${target.identifier.toLowerCase()}`;
		expect(new URL(page.url()).pathname).toBe(targetPath);
	});
});

test.describe('Issue detail — right sidebar', () => {
	test('right sidebar floats sticky on desktop scroll and houses the Effort control while wake-assignee lives in the comment form', async ({
		page,
		freshWorkspace,
	}) => {
		const { team, agents, token } = freshWorkspace;
		await page.setViewportSize({ width: 1280, height: 720 });

		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const project = await createProjectViaApi(
			page,
			team.id,
			token,
			'Sidebar Project',
			'Sidebar test project.',
		);
		const issue = await createIssueViaApi(page, team.id, token, {
			project_id: project.id,
			title: 'Sidebar Test Issue',
			assignee_id: agents[0].id,
		});

		for (let i = 0; i < 25; i++) {
			await page.request.post(`/api/teams/${team.id}/issues/${issue.id}/comments`, {
				headers,
				data: {
					content_type: 'text',
					content: { text: `Filler comment ${i}. ${'lorem ipsum '.repeat(30)}` },
				},
			});
		}

		await page.goto(`/teams/${team.slug}/issues/${issue.id}`);
		await waitForPageLoad(page);

		const sidebar = page.getByTestId('issue-sidebar');
		await expect(sidebar).toBeVisible({ timeout: 20000 });

		const position = await sidebar.evaluate((el) => getComputedStyle(el).position);
		expect(position).toBe('sticky');

		const main = page.locator('main').first();
		const initialY = (await sidebar.boundingBox())?.y ?? 0;

		await main.evaluate((el) => {
			el.scrollBy(0, 800);
		});
		await page.waitForTimeout(100);

		const scrolled = await sidebar.boundingBox();
		expect(scrolled).not.toBeNull();
		expect(scrolled!.y).toBeLessThanOrEqual(initialY);
		expect(scrolled!.y).toBeGreaterThanOrEqual(0);
		expect(scrolled!.y + scrolled!.height).toBeLessThanOrEqual(720);

		const effort = sidebar.getByLabel(
			'Reasoning effort for the agent run triggered by this comment',
		);
		await expect(effort).toBeVisible();

		await expect(sidebar.getByRole('checkbox', { name: 'Wake assignee on submit' })).toHaveCount(0);
	});
});

test.describe('Issue detail — info tooltips on pinned cards', () => {
	test('Progress Summary and Rules labels expose info icons with help text at mobile viewport', async ({
		page,
		freshWorkspace,
	}) => {
		const { team, agents, token } = freshWorkspace;
		await page.setViewportSize({ width: 375, height: 720 });

		const project = await createProjectViaApi(
			page,
			team.id,
			token,
			'Tooltip Project',
			'Info tooltip coverage.',
		);
		const issue = await createIssueViaApi(page, team.id, token, {
			project_id: project.id,
			title: 'Tooltip Test Issue',
			assignee_id: agents[0].id,
		});

		await page.goto(
			`/teams/${team.slug}/projects/${project.slug}/issues/${issue.identifier.toLowerCase()}`,
		);
		await waitForPageLoad(page);
		await expect(page.getByRole('heading', { name: 'Tooltip Test Issue' })).toBeVisible({
			timeout: 20000,
		});

		const progressInfo = page.getByTestId('progress-summary-info');
		await expect(progressInfo).toBeVisible();
		await expect(progressInfo).toHaveAttribute('aria-label', 'About Progress Summary');

		const rulesInfo = page.getByTestId('rules-info');
		await expect(rulesInfo).toBeVisible();
		await expect(rulesInfo).toHaveAttribute('aria-label', 'About Rules');

		const progressCard = page.getByTestId('pinned-progress-summary');
		await expect(progressCard).toContainText('Progress Summary');
		await expect(progressCard.getByRole('button', { name: 'Edit' })).toBeVisible();

		const rulesCard = page.getByTestId('pinned-rules');
		await expect(rulesCard).toContainText('Rules');
		await expect(rulesCard.getByRole('button', { name: 'Edit' })).toBeVisible();
	});
});

test.describe('Issue detail — initial scroll and scroll-to-bottom button', () => {
	test('lands at top of ticket page and floating button scrolls to bottom on demand', async ({
		page,
		freshWorkspace,
	}) => {
		const { team, agents, token } = freshWorkspace;
		await page.setViewportSize({ width: 1280, height: 720 });

		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const project = await createProjectViaApi(
			page,
			team.id,
			token,
			'Scroll Project',
			'Scroll behavior test.',
		);
		const issue = await createIssueViaApi(page, team.id, token, {
			project_id: project.id,
			title: 'Scroll Test Issue',
			assignee_id: agents[0].id,
			description: 'A short description so the page header stays compact.',
		});

		for (let i = 0; i < 30; i++) {
			await page.request.post(`/api/teams/${team.id}/issues/${issue.id}/comments`, {
				headers,
				data: {
					content_type: 'text',
					content: { text: `Filler comment ${i}. ${'lorem ipsum '.repeat(30)}` },
				},
			});
		}

		await page.goto(
			`/teams/${team.slug}/projects/${project.slug}/issues/${issue.identifier.toLowerCase()}`,
		);
		await waitForPageLoad(page);
		await expect(page.getByRole('heading', { name: 'Scroll Test Issue' })).toBeInViewport();

		const main = page.locator('main').first();
		await expect.poll(() => main.evaluate((el) => el.scrollTop), { timeout: 10000 }).toBe(0);

		const button = page.getByTestId('issue-scroll-to-bottom');
		await expect(button).toBeVisible();

		await button.click();

		await expect(button).toBeHidden({ timeout: 10000 });
		await expect(page.getByPlaceholder('Add a comment...')).toBeInViewport();
	});

	test('button is also functional at mobile viewport', async ({ page, freshWorkspace }) => {
		const { team, agents, token } = freshWorkspace;
		await page.setViewportSize({ width: 375, height: 720 });

		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const project = await createProjectViaApi(
			page,
			team.id,
			token,
			'Mobile Scroll Project',
			'Mobile scroll behavior test.',
		);
		const issue = await createIssueViaApi(page, team.id, token, {
			project_id: project.id,
			title: 'Mobile Scroll Issue',
			assignee_id: agents[0].id,
		});

		for (let i = 0; i < 30; i++) {
			await page.request.post(`/api/teams/${team.id}/issues/${issue.id}/comments`, {
				headers,
				data: {
					content_type: 'text',
					content: { text: `Mobile filler ${i}. ${'lorem ipsum '.repeat(30)}` },
				},
			});
		}

		await page.goto(
			`/teams/${team.slug}/projects/${project.slug}/issues/${issue.identifier.toLowerCase()}`,
		);
		await waitForPageLoad(page);
		await expect(page.getByRole('heading', { name: 'Mobile Scroll Issue' })).toBeInViewport();

		const main = page.locator('main').first();
		await expect.poll(() => main.evaluate((el) => el.scrollTop), { timeout: 10000 }).toBe(0);

		const button = page.getByTestId('issue-scroll-to-bottom');
		await expect(button).toBeVisible();
		await button.click();

		await expect(button).toBeHidden({ timeout: 10000 });
		await expect(page.getByPlaceholder('Add a comment...')).toBeInViewport();
	});
});
