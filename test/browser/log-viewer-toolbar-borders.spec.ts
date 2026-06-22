// Playwright (decision tree #1: real CSS layout). The toolbar's non-toggle
// buttons must render with no visible border, while an active (depressed) toggle
// keeps one. That hinges on a `border-transparent!` utility beating the global
// unlayered `* { border-color: var(--border) }` rule — a real-cascade outcome
// happy-dom can't compute, so it needs Chromium + the compiled stylesheet.
import { expect, test } from './fixtures';

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

test('toolbar buttons show a border only when they are an active toggle', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, agents, projectSlug } = sharedWorkspace;
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const runId = '99999999-9999-9999-9999-0000000border';
	const runResponse = {
		id: runId,
		member_id: captain.id,
		team_id: team.id,
		task_id: '22222222-2222-2222-2222-0000000border',
		task_identifier: 'BORDER-1',
		task_title: 'Toolbar Border Task',
		project_id: '11111111-1111-1111-1111-0000000border',
		status: 'running',
		started_at: new Date(Date.now() - 60_000).toISOString(),
		finished_at: null,
		exit_code: null,
		error: null,
		input_tokens: 0,
		output_tokens: 0,
		cost_cents: 0,
		invocation_command: null,
		log_text: Array.from({ length: 30 }, (_, i) => `[synthetic] line ${i}`).join('\n'),
		working_dir: null,
		created_tasks: [],
	};

	await page.route(
		`**/api/projects/*/agents/${captain.id}/heartbeat-runs/${runId}`,
		async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ data: runResponse }),
			});
		},
	);

	await page.goto(`/projects/${projectSlug}/agents/${captain.id}/executions/${runId}`);
	await expect(page.getByTestId('run-log')).toBeVisible({ timeout: 15_000 });

	const borderColor = (name: string) =>
		page
			.getByRole('button', { name })
			.first()
			.evaluate((el) => getComputedStyle(el).borderTopColor);

	// Pure action buttons never have an active state → no visible border.
	expect(await borderColor('Copy logs to clipboard')).toBe(TRANSPARENT);
	expect(await borderColor('Expand log viewer')).toBe(TRANSPARENT);

	// Auto-scroll defaults on (depressed) → it keeps a visible border.
	const autoScroll = page.getByRole('button', { name: 'Toggle auto-scroll' }).first();
	await expect(autoScroll).toHaveAttribute('aria-pressed', 'true');
	expect(await autoScroll.evaluate((el) => getComputedStyle(el).borderTopColor)).not.toBe(
		TRANSPARENT,
	);

	// Toggling it off removes the depressed state → border goes away too.
	await autoScroll.click();
	await page.mouse.move(0, 0); // settle the colour transition without hover
	await expect(autoScroll).toHaveAttribute('aria-pressed', 'false');
	await expect
		.poll(() => autoScroll.evaluate((el) => getComputedStyle(el).borderTopColor))
		.toBe(TRANSPARENT);
});
