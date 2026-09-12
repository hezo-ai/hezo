// Criterion #2 (viewport-conditional behaviour): the execution row is one flex
// line on desktop and three wrapped bands below `sm`, which only resolves once a
// real layout pass runs the media query and wraps the line. happy-dom reports no
// geometry at all, so a component test would pass whatever the row did.
//
// The `mobile` Playwright project runs every *.mobile.spec.ts at 390px (see
// playwright.config.ts). The run list is stubbed rather than driven from real
// agent runs: what is under test is the row's geometry at a narrow viewport, and
// a synthetic list pins the content the boxes are measured against.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, waitForPageLoad } from './helpers';

type CreatedProject = { id: string; slug: string; team_id: string };

const LONG_TITLE = 'Daily X engagement: discover conversations and draft replies';

/**
 * Runs stamped relative to now, so `RelativeTime` renders its "N minutes ago"
 * form - past a day old it switches to an absolute date and the band-1
 * assertions would be measuring a different string.
 */
function minutesAgo(minutes: number): string {
	return new Date(Date.now() - minutes * 60_000).toISOString();
}

function makeRun(overrides: Record<string, unknown>) {
	return {
		id: 'aaaa0000-0000-0000-0000-0000000000a1',
		member_id: 'm-1',
		team_id: 't-1',
		wakeup_id: null,
		task_id: 'task-1',
		kind: 'task',
		task_identifier: 'HM-345',
		task_title: LONG_TITLE,
		project_id: 'p-1',
		project_slug: 'demo',
		project_name: 'Demo Project',
		status: 'succeeded',
		queued_reason: null,
		started_at: minutesAgo(2),
		finished_at: minutesAgo(1),
		exit_code: 0,
		error: null,
		input_tokens: 0,
		output_tokens: 0,
		cost_cents: 9,
		usage_partial: false,
		invocation_command: null,
		log_text: null,
		working_dir: null,
		trigger_source: 'heartbeat',
		trigger_payload: null,
		trigger_comment_id: null,
		trigger_comment_public_id: null,
		trigger_actor_member_id: null,
		trigger_actor_slug: null,
		trigger_actor_title: null,
		trigger_comment_task_id: null,
		trigger_comment_task_identifier: null,
		trigger_comment_project_slug: null,
		run_comment_id: null,
		run_comment_public_id: null,
		created_tasks: [],
		created_docs: [],
		created_skills: [],
		proposed_skills: [],
		...overrides,
	};
}

async function stubRuns(page: Page) {
	const runs = [
		makeRun({}),
		makeRun({
			id: 'aaaa0000-0000-0000-0000-0000000000a2',
			started_at: minutesAgo(5),
			finished_at: minutesAgo(4),
		}),
		makeRun({
			id: 'aaaa0000-0000-0000-0000-0000000000a3',
			started_at: minutesAgo(20),
			finished_at: minutesAgo(19),
		}),
	];
	await page.route('**/api/projects/*/agents/*/heartbeat-runs?*', async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: runs, meta: { page: 1, per_page: 50, total: runs.length } }),
		});
	});
}

async function openExecutions(page: Page, token: string, name: string) {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const projectRes = await createProjectAndClearPlanning(page, '', token, {
		name,
		description: 'Mobile run-list layout test.',
	});
	const project = ((await projectRes.json()) as { data: CreatedProject }).data;

	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];

	await stubRuns(page);
	await page.goto(`/projects/${project.slug}/agents/${captain.id}/executions`);
	await waitForPageLoad(page);
	return { project, captainId: captain.id };
}

test.describe('Agent executions — mobile layout (390px)', () => {
	test('a run row stacks into status/title/meta bands instead of a squeezed column', async ({
		page,
		freshWorkspace,
	}) => {
		await openExecutions(page, freshWorkspace.token, 'Mobile Runs Stack');

		const row = page.getByTestId('execution-row').first();
		await expect(row).toBeVisible({ timeout: 20000 });

		const rowBox = (await row.boundingBox())!;
		const badgeBox = (await row.getByText('succeeded').boundingBox())!;
		const idBox = (await row.getByText('HM-345').boundingBox())!;
		const titleBox = (await row.getByTestId('execution-row-title').boundingBox())!;
		const whenBox = (await row.getByText(/ago$/).boundingBox())!;

		// Band 1: status, task id and the timestamp share a line, the timestamp
		// pushed to the row's right edge.
		expect(Math.abs(idBox.y - badgeBox.y)).toBeLessThan(6);
		expect(Math.abs(whenBox.y - badgeBox.y)).toBeLessThan(6);
		expect(rowBox.x + rowBox.width - (whenBox.x + whenBox.width)).toBeLessThan(20);

		// The identifier is never broken across lines - that split is what made the
		// old single-line row unreadable here.
		expect(idBox.height).toBeLessThan(24);

		// Band 2: the title starts below band 1 and gets the full column width,
		// clamped to two lines rather than wrapping into a narrow ribbon.
		expect(titleBox.y).toBeGreaterThan(badgeBox.y + badgeBox.height - 2);
		expect(titleBox.width).toBeGreaterThan(rowBox.width * 0.8);
		expect(titleBox.height).toBeLessThan(44);

		// The whole row stays compact enough that several runs fit one screen.
		expect(rowBox.height).toBeLessThan(120);
	});

	test('the run list clears the fixed chat launcher and never scrolls sideways', async ({
		page,
		freshWorkspace,
	}) => {
		await openExecutions(page, freshWorkspace.token, 'Mobile Runs Clearance');

		const rows = page.getByTestId('execution-row');
		await expect(rows.first()).toBeVisible({ timeout: 20000 });

		// The page column never overflows its own viewport width.
		const overflow = await page.evaluate(() => {
			const main = document.querySelector('main');
			return main ? main.scrollWidth - main.clientWidth : 0;
		});
		expect(overflow).toBeLessThanOrEqual(1);

		// Scrolled to the bottom, the last row is fully inside the viewport - no
		// floating corner button overlays the list any more (the chat launcher
		// moved into the app header), so the row just has to be reachable.
		await page.evaluate(() => {
			document.querySelector('main')?.scrollTo({ top: 999_999, behavior: 'instant' });
		});
		const lastRowBox = (await rows.last().boundingBox())!;
		const viewport = page.viewportSize()!;
		expect(lastRowBox.y + lastRowBox.height).toBeLessThanOrEqual(viewport.height + 1);
	});
});
