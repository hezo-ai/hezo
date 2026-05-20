import type { PGlite } from '@electric-sql/pglite';
import { IssueStatus, WakeupSource } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { HIRE_TEAM_INTAKE_TITLE } from '../../services/hire-team-intake';
import { REQUIREMENTS_INTAKE_TITLE } from '../../services/requirements-intake';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
});

beforeEach(async () => {
	await db.query('DELETE FROM teams');
});

afterAll(async () => {
	await safeClose(db);
});

async function createBlankTeam(name: string) {
	const blank = await db.query<{ id: string }>(
		"SELECT id FROM team_templates WHERE name = 'Blank' LIMIT 1",
	);
	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name, template_id: blank.rows[0].id }),
	});
	expect(teamRes.status).toBe(201);
	return (await teamRes.json()).data as { id: string; slug: string };
}

describe('onboarding', () => {
	it('reports stage 1 as current for a new team', async () => {
		const team = await createBlankTeam('Onboard Stage Co');

		const res = await app.request(`/api/teams/${team.slug}/onboarding`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const status = (await res.json()).data as {
			show_welcome: boolean;
			current_stage: string;
			stages: Record<string, string>;
		};
		expect(status.show_welcome).toBe(true);
		expect(status.current_stage).toBe('requirements');
		expect(status.stages.requirements).toBe('current');
		expect(status.stages.hire_team).toBe('pending');
		expect(status.stages.start_project).toBe('pending');
	});

	it('defers planning wakeup on first user-facing project until start is confirmed', async () => {
		const team = await createBlankTeam('Defer Wake Co');

		const projectRes = await app.request(`/api/teams/${team.slug}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'First Product',
				description: 'Build the thing',
			}),
		});
		expect(projectRes.status).toBe(201);
		const project = (await projectRes.json()).data as {
			id: string;
			planning_issue_id: string;
		};

		const wakeupsBefore = await db.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM agent_wakeup_requests
			 WHERE team_id = $1 AND payload->>'issue_id' = $2`,
			[team.id, project.planning_issue_id],
		);
		expect(Number(wakeupsBefore.rows[0]?.count ?? 0)).toBe(0);

		const execBefore = await db.query<{ execution_started_at: string | null }>(
			'SELECT execution_started_at FROM projects WHERE id = $1',
			[project.id],
		);
		expect(execBefore.rows[0]?.execution_started_at).toBeNull();

		const startRes = await app.request(`/api/teams/${team.slug}/onboarding/start-project`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(startRes.status).toBe(400);

		const intakeRes = await app.request(`/api/teams/${team.slug}/requirements-intake`, {
			headers: authHeader(token),
		});
		const intake = (await intakeRes.json()).data as { issue_id: string };
		await app.request(`/api/teams/${team.slug}/issues/${intake.issue_id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: IssueStatus.Done }),
		});

		const hireRes = await app.request(`/api/teams/${team.slug}/hire-team-intake`, {
			headers: authHeader(token),
		});
		const hire = (await hireRes.json()).data as { issue_id: string };
		await app.request(`/api/teams/${team.slug}/issues/${hire.issue_id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: IssueStatus.Done }),
		});

		const confirmRes = await app.request(`/api/teams/${team.slug}/onboarding/start-project`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(confirmRes.status).toBe(200);

		const execAfter = await db.query<{ execution_started_at: string | null }>(
			'SELECT execution_started_at FROM projects WHERE id = $1',
			[project.id],
		);
		expect(execAfter.rows[0]?.execution_started_at).not.toBeNull();

		const wakeupsAfter = await db.query<{ source: string }>(
			`SELECT source::text FROM agent_wakeup_requests
			 WHERE team_id = $1 AND payload->>'issue_id' = $2`,
			[team.id, project.planning_issue_id],
		);
		expect(wakeupsAfter.rows.length).toBeGreaterThanOrEqual(1);
		expect(wakeupsAfter.rows.some((r) => r.source === WakeupSource.Assignment)).toBe(true);

		const statusRes = await app.request(`/api/teams/${team.slug}/onboarding`, {
			headers: authHeader(token),
		});
		const status = (await statusRes.json()).data as {
			show_welcome: boolean;
			stages: Record<string, string>;
		};
		expect(status.show_welcome).toBe(false);
		expect(status.stages.start_project).toBe('complete');
	});

	it('advances stages as intake tickets complete', async () => {
		const team = await createBlankTeam('Stage Advance Co');

		const intakeRes = await app.request(`/api/teams/${team.slug}/requirements-intake`, {
			headers: authHeader(token),
		});
		const intake = (await intakeRes.json()).data as { issue_id: string };

		await app.request(`/api/teams/${team.slug}/issues/${intake.issue_id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: IssueStatus.Done }),
		});

		const afterReq = await app.request(`/api/teams/${team.slug}/onboarding`, {
			headers: authHeader(token),
		});
		const reqStatus = (await afterReq.json()).data as {
			current_stage: string;
			stages: Record<string, string>;
		};
		expect(reqStatus.stages.requirements).toBe('complete');
		expect(reqStatus.current_stage).toBe('hire_team');

		const hireRes = await app.request(`/api/teams/${team.slug}/hire-team-intake`, {
			headers: authHeader(token),
		});
		const hire = (await hireRes.json()).data as { issue_id: string };
		await app.request(`/api/teams/${team.slug}/issues/${hire.issue_id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: IssueStatus.Done }),
		});

		const issuesRes = await app.request(`/api/teams/${team.slug}/issues`, {
			headers: authHeader(token),
		});
		const issues = (await issuesRes.json()).data as Array<{ title: string }>;
		expect(issues.some((i) => i.title === REQUIREMENTS_INTAKE_TITLE)).toBe(true);
		expect(issues.some((i) => i.title === HIRE_TEAM_INTAKE_TITLE)).toBe(true);

		const afterHire = await app.request(`/api/teams/${team.slug}/onboarding`, {
			headers: authHeader(token),
		});
		const hireStatus = (await afterHire.json()).data as {
			current_stage: string;
			stages: Record<string, string>;
		};
		expect(hireStatus.stages.hire_team).toBe('complete');
		expect(hireStatus.current_stage).toBe('start_project');
	});
});
