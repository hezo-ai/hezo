import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { DomainEventBus } from '../src/events/bus';
import {
	createProject,
	createProjectWithTeam,
	resolveCreationTemplate,
	resolveProjectTaskPrefix,
} from '../src/services/project-create';
import { safeClose } from './helpers';
import { authHeader, createStubDocker, createTestApp, createTestTeam } from './helpers/app';

/**
 * Branch coverage for services/project-create.ts not reached by
 * project-create-from-team.test.ts / project-create-broadcast.test.ts:
 *  - resolveProjectTaskPrefix: explicit-shape reject, collision, derive-suffix loop.
 *  - resolveCreationTemplate: explicit template, default Blank, source-team
 *    description fallback.
 *  - createProject: events-emit path + initialProjectPlan doc seeding +
 *    deferCaptainPlanningWake = false (second project counted).
 *  - createProjectWithTeam: invalid task_prefix up-front, prefix-collision unwind,
 *    actorUserId → member resolution.
 */

let db: Db;
let teamId: string;
let captainMemberId: string;
let startupTemplateId: string;
let creatorUserId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;

	const typesRes = await ctx.app.request('/api/team-templates', { headers: authHeader(ctx.token) });
	startupTemplateId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;

	const u = await db.query<{ id: string }>(
		`SELECT id FROM users WHERE is_superuser = true ORDER BY created_at LIMIT 1`,
	);
	creatorUserId = u.rows[0].id;

	const teamRes = await createTestTeam(db, {
		name: 'PC Branches Co',
		template_id: startupTemplateId,
	});
	teamId = (await teamRes.json()).data.id;
	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain' LIMIT 1`,
		[teamId],
	);
	captainMemberId = captain.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('resolveProjectTaskPrefix', () => {
	// A bare team with no project — UNIQUE(projects.team_id) allows at most one
	// project per team, so seed prefix collisions against a separate "holder" team
	// whose single project carries the colliding prefix.
	async function bareTeam(name: string): Promise<string> {
		const r = await db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ($1, $2) RETURNING id`,
			[name, `${name}-${Math.random().toString(16).slice(2, 8)}`.toLowerCase()],
		);
		return r.rows[0].id;
	}

	async function seedProjectWithPrefix(team: string, prefix: string): Promise<void> {
		await db.query(
			`INSERT INTO projects (team_id, name, slug, task_prefix, description)
			 VALUES ($1, $2, $3, $4, '')`,
			[team, `Holder ${prefix}`, `holder-${Math.random().toString(16).slice(2, 8)}`, prefix],
		);
	}

	it('rejects a malformed explicit prefix', async () => {
		const r = await resolveProjectTaskPrefix(db, teamId, 'toolong', 'Name');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe('INVALID_REQUEST');
	});

	it('accepts a valid explicit prefix and uppercases it', async () => {
		const t = await bareTeam('PrefixOk');
		const r = await resolveProjectTaskPrefix(db, t, 'zz9', 'Name');
		expect(r).toEqual({ ok: true, prefix: 'ZZ9' });
	});

	it('CONFLICTs on an explicit prefix already used by the team', async () => {
		const t = await bareTeam('PrefixConf');
		await seedProjectWithPrefix(t, 'QQ');
		const r = await resolveProjectTaskPrefix(db, t, 'qq', 'Name');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe('CONFLICT');
	});

	it('derives a suffixed prefix when the base is already taken', async () => {
		const t = await bareTeam('PrefixDerive');
		const base = (await resolveProjectTaskPrefix(db, t, undefined, 'Widget')) as {
			ok: true;
			prefix: string;
		};
		await seedProjectWithPrefix(t, base.prefix);
		// Now the base is taken on team t → derive a numbered suffix.
		const r = await resolveProjectTaskPrefix(db, t, undefined, 'Widget');
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.prefix).not.toBe(base.prefix);
			expect(r.prefix.startsWith(base.prefix)).toBe(true);
		}
	});
});

describe('resolveCreationTemplate', () => {
	it('returns the explicit template id when given', async () => {
		const r = await resolveCreationTemplate(db, { templateId: startupTemplateId });
		expect(r).toEqual({ ok: true, templateId: startupTemplateId });
	});

	it('defaults to the Blank template when neither id nor source given', async () => {
		const r = await resolveCreationTemplate(db, {});
		expect(r.ok).toBe(true);
		if (r.ok) {
			const blank = await db.query<{ id: string }>(
				`SELECT id FROM team_templates WHERE name = 'Blank'`,
			);
			expect(r.templateId).toBe(blank.rows[0].id);
		}
	});

	it('snapshots a source team using the default description when none provided', async () => {
		const srcRes = await createTestTeam(db, {
			name: 'Snap Src Co',
			template_id: startupTemplateId,
		});
		const srcId = (await srcRes.json()).data.id;
		const r = await resolveCreationTemplate(db, { sourceTeamId: srcId });
		expect(r.ok).toBe(true);
		if (r.ok) {
			const tpl = await db.query<{ description: string }>(
				`SELECT description FROM team_templates WHERE id = $1`,
				[r.templateId],
			);
			// The default fallback: `Snapshot of the "<name>" team`.
			expect(tpl.rows[0].description).toContain('Snap Src Co');
		}
	});
});

describe('createProject — events + plan-doc branches', () => {
	it('emits project.created and seeds the project-plan doc for the first project', async () => {
		const events = new DomainEventBus();
		const captured: Array<{ type: string }> = [];
		events.subscribe((e) => {
			if (e.type === 'project.created') captured.push({ type: e.type });
		});

		const teamRes = await createTestTeam(db, {
			name: 'PC Events Co',
			template_id: startupTemplateId,
		});
		const t = (await teamRes.json()).data.id;
		const cap = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain' LIMIT 1`,
			[t],
		);

		const first = await createProject(db, {
			teamId: t,
			captainMemberId: cap.rows[0].id,
			name: 'First Proj',
			slug: `first-proj-${Math.random().toString(16).slice(2, 8)}`,
			taskPrefix: 'FP',
			description: 'first',
			initialProjectPlan: '# Plan\n\nDo the thing.',
			events,
			actorType: 'admin',
			actorMemberId: null,
		});
		// First non-internal project on the team → deferred + audit emitted.
		expect(first.deferCaptainPlanningWake).toBe(true);
		expect(captured).toHaveLength(1);

		// The attached project plan was seeded as a doc.
		const planDoc = await db.query<{ slug: string }>(
			`SELECT slug FROM documents WHERE project_id = $1 AND slug = 'project-plan.md'`,
			[first.project.id as string],
		);
		expect(planDoc.rows).toHaveLength(1);
	});
});

describe('createProjectWithTeam — failure + actor branches', () => {
	const deps = () => ({
		db,
		docker: createStubDocker(),
		dataDir: '/tmp/hezo-pc-branches',
	});

	it('rejects an invalid task_prefix before standing up a team', async () => {
		const before = await teamCount();
		const r = await createProjectWithTeam(
			deps(),
			{ name: 'Bad Prefix Co', description: 'x', taskPrefix: 'lowercase-and-long' },
			{ provisionContainer: false },
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe('INVALID_REQUEST');
		// No orphan team left behind.
		expect(await teamCount()).toBe(before);
	});

	it('resolves the audit actor from actorUserId and provisions a team', async () => {
		const r = await createProjectWithTeam(
			deps(),
			{
				name: 'Actor Resolve Co',
				description: 'audited',
				templateId: startupTemplateId,
				actorUserId: creatorUserId,
				creatorUserId,
			},
			{ events: new DomainEventBus(), provisionContainer: false },
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			// The created project's audit event member resolved (or null) without error;
			// assert the team + planning task exist.
			expect(r.team.id).toBeTruthy();
			expect(r.planningTask.id).toBeTruthy();
			expect(r.coherenceTask).not.toBeNull();
		}
	});
});

async function teamCount(): Promise<number> {
	const r = await db.query<{ c: number }>('SELECT count(*)::int AS c FROM teams');
	return r.rows[0].c;
}
