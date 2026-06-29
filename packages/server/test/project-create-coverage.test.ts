import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContainerDeps } from '../src/services/containers';
import {
	createProject,
	createProjectWithTeam,
	resolveCreationTemplate,
	resolveProjectTaskPrefix,
} from '../src/services/project-create';
import { safeClose } from './helpers';
import { createStubDocker, createTestApp, createTestTeam } from './helpers/app';

let db: PGlite;
let teamId: string;
let dataDir: string;
let deps: ContainerDeps;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	dataDir = mkdtempSync(join(tmpdir(), 'hezo-pc-cov-'));

	const teamRes = await createTestTeam(db, { name: 'PC Cov Co' });
	teamId = (await teamRes.json()).data.id;

	// Minimal ContainerDeps for createProjectWithTeam with provisioning disabled.
	deps = {
		db,
		docker: createStubDocker(),
		dataDir,
	} as unknown as ContainerDeps;
});

afterAll(async () => {
	await safeClose(db);
});

let freshCounter = 0;
async function freshTeam(): Promise<{ teamId: string; captainMemberId: string }> {
	freshCounter += 1;
	const res = await createTestTeam(db, { name: `PC Fresh ${freshCounter} Co` });
	const id = (await res.json()).data.id;
	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
		[id],
	);
	return { teamId: id, captainMemberId: captain.rows[0].id };
}

describe('resolveProjectTaskPrefix', () => {
	it('rejects a malformed provided prefix (400)', async () => {
		const r = await resolveProjectTaskPrefix(db, teamId, 'toolong5', 'Whatever');
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.code).toBe('INVALID_REQUEST');
			expect(r.status).toBe(400);
		}
	});

	it('uppercases and accepts a valid provided prefix', async () => {
		const r = await resolveProjectTaskPrefix(db, teamId, 'ab1', 'Whatever');
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.prefix).toBe('AB1');
	});

	it('returns CONFLICT when the provided prefix collides with an existing one (409)', async () => {
		const t = await freshTeam();
		await db.query(
			`INSERT INTO projects (team_id, name, slug, task_prefix, docker_base_image)
			 VALUES ($1, 'Prefix Holder', 'prefix-holder', 'DUP', 'hezo/agent-base:latest')`,
			[t.teamId],
		);
		const r = await resolveProjectTaskPrefix(db, t.teamId, 'dup', 'Whatever');
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.code).toBe('CONFLICT');
			expect(r.status).toBe(409);
		}
	});

	it('auto-derives a unique suffix when the base prefix is taken', async () => {
		const t = await freshTeam();
		// Seed a project whose task_prefix is exactly the derived base for "Zephyr".
		const base = (await resolveProjectTaskPrefix(db, t.teamId, undefined, 'Zephyr')) as {
			ok: true;
			prefix: string;
		};
		await db.query(
			`INSERT INTO projects (team_id, name, slug, task_prefix, docker_base_image)
			 VALUES ($1, 'Zephyr One', 'zephyr-one', $2, 'hezo/agent-base:latest')`,
			[t.teamId, base.prefix],
		);
		const r = await resolveProjectTaskPrefix(db, t.teamId, undefined, 'Zephyr');
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.prefix).not.toBe(base.prefix);
			expect(r.prefix.startsWith(base.prefix)).toBe(true);
		}
	});
});

describe('resolveCreationTemplate', () => {
	it('rejects providing both template_id and source_team_id (400)', async () => {
		const r = await resolveCreationTemplate(db, {
			templateId: 'a',
			sourceTeamId: 'b',
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.status).toBe(400);
	});

	it('passes through an explicit template_id', async () => {
		const r = await resolveCreationTemplate(db, { templateId: 'tmpl-123' });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.templateId).toBe('tmpl-123');
	});

	it('404s an unknown source team', async () => {
		const r = await resolveCreationTemplate(db, {
			sourceTeamId: '00000000-0000-0000-0000-000000000000',
		});
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.code).toBe('NOT_FOUND');
			expect(r.status).toBe(404);
		}
	});

	it('rejects the internal HQ team as a source (400)', async () => {
		const hq = await db.query<{ id: string }>(
			`SELECT t.id FROM teams t
			 JOIN projects p ON p.team_id = t.id
			 WHERE p.is_internal = true LIMIT 1`,
		);
		const r = await resolveCreationTemplate(db, { sourceTeamId: hq.rows[0].id });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.status).toBe(400);
	});

	it('defaults to the Blank template when neither field is provided', async () => {
		const blank = await db.query<{ id: string }>(
			`SELECT id FROM team_templates WHERE name = 'Blank'`,
		);
		const r = await resolveCreationTemplate(db, {});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.templateId).toBe(blank.rows[0].id);
	});
});

describe('createProject — initial project plan + docs seeding', () => {
	it('seeds a project-plan.md document when an initialProjectPlan is supplied', async () => {
		const t = await freshTeam();
		const result = await createProject(db, {
			teamId: t.teamId,
			captainMemberId: t.captainMemberId,
			name: 'Plan Project',
			slug: 'plan-project-cov',
			taskPrefix: 'PPC',
			description: 'has a plan',
			initialProjectPlan: '  # The Plan\n\nDo the things.  ',
		});
		const projectId = result.project.id as string;

		const planDoc = await db.query<{ content: string }>(
			`SELECT content FROM documents WHERE project_id = $1 AND slug = 'project-plan.md'`,
			[projectId],
		);
		expect(planDoc.rows.length).toBe(1);
		// Trimmed before insert.
		expect(planDoc.rows[0].content).toBe('# The Plan\n\nDo the things.');

		// The default architecture-guidelines doc is always seeded too.
		const archDoc = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM documents
			 WHERE project_id = $1 AND slug = 'architecture-guidelines.md'`,
			[projectId],
		);
		expect(archDoc.rows[0].n).toBe(1);

		// A fresh task counter starts at 1.
		const counter = await db.query<{ next_number: number }>(
			`SELECT next_number FROM project_task_counters WHERE project_id = $1`,
			[projectId],
		);
		expect(counter.rows[0].next_number).toBe(1);
	});

	it('reports deferCaptainPlanningWake true for the first user-facing project of a team', async () => {
		const t = await freshTeam();
		const first = await createProject(db, {
			teamId: t.teamId,
			captainMemberId: t.captainMemberId,
			name: 'First Project',
			slug: 'first-defer-project',
			taskPrefix: 'FDP',
			description: 'first',
		});
		// First non-internal project of the team → wake is deferred.
		expect(first.deferCaptainPlanningWake).toBe(true);
	});
});

describe('createProjectWithTeam — validation + coherence options', () => {
	it('rejects a malformed task_prefix before standing up a team (400)', async () => {
		const before = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM teams');
		const r = await createProjectWithTeam(
			deps,
			{ name: 'Bad Prefix Team', description: 'x', taskPrefix: 'lowercase-bad' },
			{ provisionContainer: false },
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.status).toBe(400);
		// No orphan team created.
		const after = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM teams');
		expect(after.rows[0].n).toBe(before.rows[0].n);
	});

	it('creates the coherence task unassigned when suppressCoherenceAutoStart is set', async () => {
		const r = await createProjectWithTeam(
			deps,
			{
				name: 'Suppressed Coherence Co',
				description: 'CEO-drafted setup',
				suppressCoherenceAutoStart: true,
			},
			{ provisionContainer: false },
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.coherenceTask).not.toBeNull();
			const row = await db.query<{ assignee_id: string | null }>(
				`SELECT assignee_id FROM tasks WHERE id = $1`,
				[r.coherenceTask!.id],
			);
			// Suppressed → unassigned, not auto-woken.
			expect(row.rows[0].assignee_id).toBeNull();

			// The planning task is blocked by the coherence task.
			const dep = await db.query<{ n: number }>(
				`SELECT count(*)::int AS n FROM task_dependencies
				 WHERE task_id = $1 AND blocked_by_task_id = $2`,
				[r.planningTask.id, r.coherenceTask!.id],
			);
			expect(dep.rows[0].n).toBe(1);
		}
	});
});
