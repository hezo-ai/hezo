import { formatContainerMetaLogLine } from '@hezo/shared';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

const CONTAINER_ID = '56ccc501e6dd28a4f3b1c09a77e5d4128b6f0a91ce23d7845fa6b0192e3c4d5f';

const LOG_TEXT = [
	'[session] model=claude-opus-4 tools=42',
	'[runner] Starting the project container…',
	`[runner] ${formatContainerMetaLogLine({
		containerId: CONTAINER_ID,
		memoryBytes: 4 * 1024 ** 3,
		diskCeilingBytes: 4 * 1024 ** 3,
	})}`,
	'Refactored the parser.',
	'[done] success turns=1 duration=500ms tokens=10/20 cost=$0.0001',
].join('\n');

test('a run log links its container to that container’s page and states what it was built with', async () => {
	const seeded = { projectSlug: '', agentSlug: '', runId: '' };

	const { findByTestId, router, container } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Container Meta Project' });
			const task = await seedTask(ws, project, { title: 'Ship it', assignee_id: captain.id });
			const run = await ctx.db.query<{ id: string }>(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at, input_tokens, output_tokens, cost_cents)
				 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status, now(), now(), 10, 20, 1)
				 RETURNING id`,
				[captain.id, ws.team.id, task.id],
			);
			await ctx.db.query(
				'INSERT INTO heartbeat_run_log_chunks (run_id, seq, content) VALUES ($1, 0, $2)',
				[run.rows[0].id, LOG_TEXT],
			);
			seeded.projectSlug = project.slug;
			seeded.agentSlug = captain.slug;
			seeded.runId = run.rows[0].id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/executions/$runId',
		params: { projectId: seeded.projectSlug, agentId: seeded.agentSlug, runId: seeded.runId },
	});

	const link = (await findByTestId('log-container-link', undefined, {
		timeout: 15_000,
	})) as HTMLAnchorElement;
	// The full engine id keys the container page; the label is shortened the same
	// way the Containers list shortens it.
	expect(link.getAttribute('href')).toBe(`/settings/containers/${CONTAINER_ID}`);
	expect(link.textContent).toBe(CONTAINER_ID.slice(0, 12));

	const block = container.querySelector('[data-testid="log-runner-block"]');
	expect(block?.textContent).toContain('4 GB RAM · 4 GB disk');
	// The runner lines are the run host talking, not the agent - they must not be
	// swept into the prose block beside them.
	expect(block?.textContent).not.toContain('Refactored the parser.');
});
