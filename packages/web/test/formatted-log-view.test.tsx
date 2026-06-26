import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

const LOG_TEXT = [
	'[session] model=deepseek-v4-pro tools=115',
	'[thinking] Planning the approach now.',
	'[thinking] My plan: 1. Investigate storage 2. Survey implementations 3. Write the report',
	'Here is the plan to follow:',
	'- first item',
	'- second item',
	'[tool] Bash(command=ls -la /tmp, description=list files)',
	'[tool-result] total 8 drwxr-xr-x 4 node node',
	'All done with the work.',
	'[done] success turns=3 duration=1200ms tokens=100/200 cost=$0.0100',
].join('\n');

test('run log defaults to the formatted view and toggles to raw via the icon buttons', async () => {
	const seeded = { projectSlug: '', agentSlug: '', runId: '' };

	const { findByText, findByTestId, queryByText, getByLabelText, user, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const agent = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const run = await ctx.db.query<{ id: string }>(
				`INSERT INTO heartbeat_runs (member_id, team_id, status, started_at, finished_at, log_text, input_tokens, output_tokens, cost_cents)
				 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, now(), now(), $3, 100, 200, 1)
				 RETURNING id`,
				[agent.id, ws.team.id, LOG_TEXT],
			);
			seeded.projectSlug = ws.internalSlug;
			seeded.agentSlug = agent.slug;
			seeded.runId = run.rows[0].id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/executions/$runId',
		params: { projectId: seeded.projectSlug, agentId: seeded.agentSlug, runId: seeded.runId },
	});

	// Formatted is the default: the tool name renders without its `[tool]` prefix,
	// and the markdown list renders as real <li> elements.
	const toolLabel = await findByText('Bash', undefined, { timeout: 15_000 });
	const listItem = await findByText('first item');
	expect(listItem.closest('li')).not.toBeNull();

	// A collapsed thinking enumeration (`1. … 2. … 3. …` on one line) is reflowed into a
	// real list inside the thinking block, not shown as a run-on paragraph.
	const thinkingItem = await findByText('Investigate storage');
	expect(thinkingItem.closest('li')).not.toBeNull();

	const body = await findByTestId('run-log');
	expect(body.textContent).not.toContain('[tool]');
	expect(body.textContent).not.toContain('[thinking]');
	expect(body.textContent).not.toContain('[session]');

	// The tool result is hidden until the tool block is expanded.
	expect(queryByText(/total 8/)).toBeNull();
	const toolButton = toolLabel.closest('button');
	expect(toolButton).not.toBeNull();
	await user.click(toolButton as HTMLButtonElement);
	await findByText(/total 8/);

	// Switching to Raw shows the literal prefixed line.
	await user.click(getByLabelText('Raw logs'));
	const rawBody = await findByTestId('run-log');
	expect(rawBody.textContent).toContain('[tool] Bash(command=ls -la /tmp, description=list files)');
	// Raw lines render bright (text-text-1) on the forced-dark terminal surface,
	// not the dim text-text-2 that low-contrasts against #0d1117 in light mode.
	expect(rawBody.className).toContain('log-surface-dark');
	const rawLine = await findByText('[tool] Bash(command=ls -la /tmp, description=list files)');
	expect(rawLine.className).toContain('text-text-1');
	expect(rawLine.className).not.toContain('text-text-2');

	// Switching back to Formatted hides the prefixes again.
	await user.click(getByLabelText('Formatted view'));
	await findByText('Bash');
	expect((await findByTestId('run-log')).textContent).not.toContain('[tool]');
});
