import { DEFAULT_TEAM_ID, MemberType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let startupTemplateId: string;

interface CreatedProjectTeam {
	id: string;
	team_id: string;
	team_slug: string;
	slug: string;
	planning_task_id: string;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	const res = await app.request('/api/team-templates', { headers: authHeader(token) });
	const startup = (await res.json()).data.find((t: { name: string }) => t.name === 'App Team');
	startupTemplateId = startup.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function createProject(body: Record<string, unknown>) {
	return app.request('/api/projects', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

// All agent slugs on a team (member_agents), sorted — project teams carry no
// CEO/Coach members, so this is the full roster.
async function rosterSlugs(teamId: string): Promise<string[]> {
	const res = await db.query<{ slug: string }>(
		`SELECT ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND m.member_type = $2
		 ORDER BY ma.slug`,
		[teamId, MemberType.Agent],
	);
	return res.rows.map((r) => r.slug);
}

async function templateCount(): Promise<number> {
	const res = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM team_templates');
	return res.rows[0].n;
}

async function agentBudgets(
	teamId: string,
	slug: string,
): Promise<{ daily: number; weekly: number; monthly: number } | undefined> {
	const res = await db.query<{
		daily_budget_cents: number;
		weekly_budget_cents: number;
		monthly_budget_cents: number;
	}>(
		`SELECT ma.daily_budget_cents, ma.weekly_budget_cents, ma.monthly_budget_cents
		 FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $2`,
		[teamId, slug],
	);
	const row = res.rows[0];
	return row
		? {
				daily: row.daily_budget_cents,
				weekly: row.weekly_budget_cents,
				monthly: row.monthly_budget_cents,
			}
		: undefined;
}

describe('POST /projects — clone an existing team (source_team_id)', () => {
	it('provisions the new team from a fresh snapshot of the source team', async () => {
		// A source team with a non-trivial roster.
		const source = (
			await (
				await createProject({
					name: 'Clone Source Co',
					description: 'Source team to clone.',
					template_id: startupTemplateId,
				})
			).json()
		).data as CreatedProjectTeam;
		const sourceRoster = await rosterSlugs(source.team_id);
		expect(sourceRoster).toContain('captain');
		expect(sourceRoster).toContain('architect');
		expect(sourceRoster.length).toBeGreaterThan(1);

		const before = await templateCount();

		// Create a new project cloning that team.
		const cloneRes = await createProject({
			name: 'Cloned Co',
			description: 'Clones the source.',
			source_team_id: source.team_id,
		});
		expect(cloneRes.status).toBe(201);
		const clone = (await cloneRes.json()).data as CreatedProjectTeam;

		// The new team's roster mirrors the source.
		expect(await rosterSlugs(clone.team_id)).toEqual(sourceRoster);

		// Reporting structure round-trips: architect reports to the captain.
		const architect = await db.query<{ reports_to_slug: string | null }>(
			`SELECT mgr.slug AS reports_to_slug
			 FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 LEFT JOIN member_agents mgr ON mgr.id = ma.reports_to
			 WHERE m.team_id = $1 AND ma.slug = 'architect'`,
			[clone.team_id],
		);
		expect(architect.rows[0]?.reports_to_slug).toBe('captain');

		// A new permanent template was minted, named after the source team.
		expect(await templateCount()).toBe(before + 1);
		const minted = await db.query<{ id: string }>('SELECT id FROM team_templates WHERE name = $1', [
			'Clone Source Co',
		]);
		expect(minted.rows).toHaveLength(1);
	});

	it("mirrors the source agents' per-window (daily/weekly/monthly) budgets", async () => {
		const source = (
			await (
				await createProject({
					name: 'Budget Source Co',
					description: 'Source with tuned budgets.',
					template_id: startupTemplateId,
				})
			).json()
		).data as CreatedProjectTeam;

		// Tune the captain's three budget windows on the source team.
		await db.query(
			`UPDATE member_agents ma SET daily_budget_cents = 111, weekly_budget_cents = 222, monthly_budget_cents = 333
			 FROM members m WHERE m.id = ma.id AND m.team_id = $1 AND ma.slug = 'captain'`,
			[source.team_id],
		);

		// Sanity: the source captain actually carries the tuned windows.
		expect(await agentBudgets(source.team_id, 'captain')).toEqual({
			daily: 111,
			weekly: 222,
			monthly: 333,
		});

		const cloneRes = await createProject({
			name: 'Budget Clone Co',
			description: 'Clones the tuned budgets.',
			source_team_id: source.team_id,
		});
		expect(cloneRes.status).toBe(201);
		const clone = (await cloneRes.json()).data as CreatedProjectTeam;

		// The clone carries all three windows, not just monthly.
		expect(await agentBudgets(clone.team_id, 'captain')).toEqual({
			daily: 111,
			weekly: 222,
			monthly: 333,
		});
	});

	it('mints a fresh, distinctly-named template each time the same team is cloned', async () => {
		const source = (
			await (
				await createProject({
					name: 'Repeat Source Co',
					description: 'Cloned twice.',
					template_id: startupTemplateId,
				})
			).json()
		).data as CreatedProjectTeam;

		const first = await createProject({
			name: 'Repeat Clone One',
			description: 'First clone.',
			source_team_id: source.team_id,
		});
		expect(first.status).toBe(201);
		const second = await createProject({
			name: 'Repeat Clone Two',
			description: 'Second clone.',
			source_team_id: source.team_id,
		});
		expect(second.status).toBe(201);

		const names = await db.query<{ name: string }>(
			"SELECT name FROM team_templates WHERE name LIKE 'Repeat Source Co%' ORDER BY name",
		);
		expect(names.rows.map((r) => r.name)).toEqual(['Repeat Source Co', 'Repeat Source Co (2)']);
	});

	it('rejects cloning the internal HQ team', async () => {
		const res = await createProject({
			name: 'No HQ Clone',
			description: 'Should fail.',
			source_team_id: DEFAULT_TEAM_ID,
		});
		expect(res.status).toBe(400);
	});

	it('rejects an unknown source team', async () => {
		const res = await createProject({
			name: 'Unknown Source',
			description: 'Should 404.',
			source_team_id: '00000000-0000-0000-0000-000000000000',
		});
		expect(res.status).toBe(404);
	});

	it('rejects passing both template_id and source_team_id', async () => {
		const source = (
			await (
				await createProject({
					name: 'Both Fields Co',
					description: 'Source.',
					template_id: startupTemplateId,
				})
			).json()
		).data as CreatedProjectTeam;
		const res = await createProject({
			name: 'Both Fields Clone',
			description: 'Should 400.',
			template_id: startupTemplateId,
			source_team_id: source.team_id,
		});
		expect(res.status).toBe(400);
	});
});

describe('POST /project-intakes — records the chosen team type as a baseline', () => {
	it('records a source-team clone as the baseline without creating a team or snapshot', async () => {
		const source = (
			await (
				await createProject({
					name: 'Intake Source Co',
					description: 'Source for intake baseline.',
					template_id: startupTemplateId,
				})
			).json()
		).data as CreatedProjectTeam;

		const templatesBefore = await templateCount();
		const teamsBefore = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM teams');

		const res = await app.request('/api/project-intakes', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Intake Clone Co',
				description: 'Cloned via intake.',
				source_team_id: source.team_id,
			}),
		});
		expect(res.status).toBe(201);
		const intake = (await res.json()).data as { intake_task_id: string; project_slug: string };
		// The conversation lives in HQ; nothing is materialised yet.
		expect(intake.project_slug).toBe('hq');

		const teamsAfter = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM teams');
		expect(teamsAfter.rows[0].n).toBe(teamsBefore.rows[0].n);
		// No snapshot template is minted up front — only recorded as the baseline.
		expect(await templateCount()).toBe(templatesBefore);

		const task = await db.query<{ description: string }>(
			'SELECT description FROM tasks WHERE id = $1',
			[intake.intake_task_id],
		);
		expect(task.rows[0].description).toContain(source.team_id);
		expect(task.rows[0].description).toContain('Intake Source Co');
	});
});
