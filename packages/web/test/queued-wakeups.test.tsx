import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

async function seedQueuedWakeup(
	teamId: string,
	taskId: string,
	memberId: string,
	opts: { coalesced?: number; source?: string } = {},
) {
	const ctx = getTestContext();
	await ctx.db.query(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, coalesced_count, payload)
		 VALUES ($1, $2, $3::wakeup_source, 'queued', $4, $5::jsonb)`,
		[
			memberId,
			teamId,
			opts.source ?? 'assignment',
			opts.coalesced ?? 0,
			JSON.stringify({ task_id: taskId }),
		],
	);
}

test('shows a queued agent once without a coalesced-count multiplier', async () => {
	let ctx: {
		projectSlug: string;
		teamId: string;
		taskId: string;
		taskSlug: string;
		agentId: string;
		agentName: string;
	};
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Queue Demo' });
			const task = await seedTask(ws, project, { title: 'Queue Task' });
			const ctxInner = getTestContext();
			const agentRes = await ctxInner.db.query<{ id: string; title: string }>(
				`SELECT id, title FROM member_agents LIMIT 1`,
			);
			ctx = {
				projectSlug: project.slug,
				teamId: ws.team.id,
				taskId: task.id,
				taskSlug: task.identifier,
				agentId: agentRes.rows[0].id,
				agentName: agentRes.rows[0].title,
			};
		},
	});

	// A wakeup that coalesced several triggers — historically rendered as "×N".
	await seedQueuedWakeup(ctx!.teamId, ctx!.taskId, ctx!.agentId, { coalesced: 3 });

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: ctx!.projectSlug, taskId: ctx!.taskSlug },
	});

	const list = await findByTestId('queued-agents-list');
	expect(list.textContent).toContain(ctx!.agentName);
	// The agent appears as a single pending run — no multiplier surfaced.
	expect(list.textContent).not.toContain('×');
});
