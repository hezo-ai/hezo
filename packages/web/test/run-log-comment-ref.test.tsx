import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

// A comment public_id the agent's reasoning refers to (creation-timestamp slug).
const PUBLIC_ID = '20260618030521';

const LOG_TEXT = [
	'[session] model=claude-opus-4 tools=42',
	`The admin approved at ${PUBLIC_ID} — proceeding to the next stage.`,
	'[done] success turns=1 duration=500ms tokens=10/20 cost=$0.0001',
].join('\n');

test('agent-run formatted view links a comment public_id in the prose to the run task', async () => {
	const seeded = { projectSlug: '', agentSlug: '', runId: '', taskId: '' };

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Run Link Project' });
			const task = await seedTask(ws, project, {
				title: 'Approve the spec',
				assignee_id: captain.id,
			});
			// A run scoped to the task: its detail response carries task_identifier /
			// task_title / project_slug, which the page passes as the comment-ref task.
			const run = await ctx.db.query<{ id: string }>(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at, log_text, input_tokens, output_tokens, cost_cents)
				 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status, now(), now(), $4, 10, 20, 1)
				 RETURNING id`,
				[captain.id, ws.team.id, task.id, LOG_TEXT],
			);
			seeded.projectSlug = project.slug;
			seeded.agentSlug = captain.slug;
			seeded.runId = run.rows[0].id;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/executions/$runId',
		params: { projectId: seeded.projectSlug, agentId: seeded.agentSlug, runId: seeded.runId },
	});

	const link = (await findByTestId('comment-mention-link', undefined, {
		timeout: 15_000,
	})) as HTMLAnchorElement;
	expect(link.getAttribute('href')).toBe(
		`/projects/${seeded.projectSlug}/tasks/${seeded.taskId}#comment-${PUBLIC_ID}`,
	);
	expect(link.textContent).toBe(PUBLIC_ID);
});
