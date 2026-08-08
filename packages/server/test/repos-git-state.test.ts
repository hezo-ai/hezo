import { CAPTAIN_AGENT_SLUG } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	authHeader,
	createAgentRun,
	createTestProject,
	createTestTeam,
	finalizeAgentRun,
	mintAgentToken,
} from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

// Route control-flow tests for the admin git-state + reset endpoints. Real git
// output requires a running container (Docker), which the test harness fakes, so
// these assert auth/validation/guards — not git behaviour (see
// git-clone-state.test.ts for the git helpers exercised against real git).

let ctx: ServerTestContext;
let teamId: string;
let projectSlug: string;
let projectId: string;
let planningTaskId: string;
let captainId: string;
let repoId: string;

beforeAll(async () => {
	ctx = await createTestContext();
	const team = (await (await createTestTeam(ctx.db, { name: 'Repo QA' })).json()).data;
	teamId = team.id;
	const project = (await (await createTestProject(ctx.db, teamId, { name: 'Website' })).json())
		.data;
	projectSlug = project.slug;
	projectId = project.id;
	planningTaskId = project.planning_task_id as string;

	const captain = await ctx.db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $2 LIMIT 1`,
		[teamId, CAPTAIN_AGENT_SLUG],
	);
	captainId = captain.rows[0].id;

	const repo = await ctx.db.query<{ id: string }>(
		`INSERT INTO repos (project_id, repo_identifier, host_type, setup_status)
		 VALUES ($1, 'acme/website', 'github'::repo_host_type, 'ready'::repo_setup_status)
		 RETURNING id`,
		[projectId],
	);
	repoId = repo.rows[0].id;
});

afterAll(() => destroyTestContext(ctx));

const gitStateUrl = () => `${ctx.baseUrl}/api/projects/${projectSlug}/repos/${repoId}/git-state`;
const resetUrl = () => `${ctx.baseUrl}/api/projects/${projectSlug}/repos/${repoId}/reset`;

describe('GET /repos/:repoId/git-state', () => {
	it('rejects a non-superuser (team-member agent) with 403', async () => {
		// A team-member agent passes project-access middleware and reaches the
		// in-handler requireSuperuser gate — so a 403 here proves that gate, not membership.
		const { token, runId } = await mintAgentToken(
			ctx.db,
			ctx.masterKeyManager,
			captainId,
			teamId,
			planningTaskId,
		);
		const res = await fetch(gitStateUrl(), { headers: authHeader(token) });
		expect(res.status).toBe(403);
		await finalizeAgentRun(ctx.db, runId);
	});

	it('reports container_running:false when the project has no running container', async () => {
		const res = await fetch(gitStateUrl(), { headers: authHeader(ctx.token) });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: { container_running: boolean } };
		expect(body.data.container_running).toBe(false);
	});

	it('404s for a repo that is not on the project', async () => {
		const url = `${ctx.baseUrl}/api/projects/${projectSlug}/repos/00000000-0000-0000-0000-000000000000/git-state`;
		const res = await fetch(url, { headers: authHeader(ctx.token) });
		expect(res.status).toBe(404);
	});

	it('reports active_runs so the panel can gate reset before it fails server-side', async () => {
		// Container "running" reaches the payload that carries active_runs (no .git
		// dir → getCloneState short-circuits to cloned:false; no execs needed).
		await ctx.db.query(
			`UPDATE projects SET container_id = 'test-container', container_status = 'running' WHERE id = $1`,
			[projectId],
		);
		try {
			const idle = (await (
				await fetch(gitStateUrl(), { headers: authHeader(ctx.token) })
			).json()) as {
				data: { container_running: boolean; active_runs: number };
			};
			expect(idle.data.container_running).toBe(true);
			expect(idle.data.active_runs).toBe(0);

			// A queued/running run on the project is exactly what the reset guard blocks on.
			const runId = await createAgentRun(ctx.db, captainId, teamId, planningTaskId);
			try {
				const busy = (await (
					await fetch(gitStateUrl(), { headers: authHeader(ctx.token) })
				).json()) as { data: { active_runs: number } };
				expect(busy.data.active_runs).toBe(1);
			} finally {
				await finalizeAgentRun(ctx.db, runId);
			}
		} finally {
			await ctx.db.query(
				`UPDATE projects SET container_id = NULL, container_status = NULL WHERE id = $1`,
				[projectId],
			);
		}
	});
});

describe('POST /repos/:repoId/reset', () => {
	it('rejects a non-superuser (team-member agent) with 403', async () => {
		const { token, runId } = await mintAgentToken(
			ctx.db,
			ctx.masterKeyManager,
			captainId,
			teamId,
			planningTaskId,
		);
		const res = await fetch(resetUrl(), {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'discard_local' }),
		});
		expect(res.status).toBe(403);
		await finalizeAgentRun(ctx.db, runId);
	});

	it('rejects an unknown action with 400', async () => {
		const res = await fetch(resetUrl(), {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'nuke_everything' }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('INVALID_REQUEST');
	});

	it('blocks reset with 409 while an agent run is active on the project', async () => {
		const runId = await createAgentRun(ctx.db, captainId, teamId, planningTaskId);
		const res = await fetch(resetUrl(), {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'discard_local' }),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('RUN_IN_PROGRESS');
		await finalizeAgentRun(ctx.db, runId);
	});

	it('blocks discard_local with 409 when the container is not running', async () => {
		const res = await fetch(resetUrl(), {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'discard_local' }),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('CONTAINER_NOT_RUNNING');
	});
});
