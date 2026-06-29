import type { PGlite } from '@electric-sql/pglite';
import {
	ApprovalStatus,
	ApprovalType,
	CAPTAIN_AGENT_SLUG,
	DEFAULT_EFFORT,
	DEFAULT_HEARTBEAT_INTERVAL_MIN,
} from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	buildHirePayloadPatch,
	insertHireApproval,
	prepareHireProposal,
} from '../src/services/hire-proposal';
import { safeClose } from './helpers';
import { createTestApp, createTestTeam } from './helpers/app';
import { compliantPrompt } from './helpers/prompt';

/**
 * Branch-coverage companion for `services/hire-proposal.ts`. Drives every
 * rejection arm of `prepareHireProposal` (missing title, bad effort, budget
 * violation, prompt-vars violation, reserved slug, slug-already-exists, pending
 * duplicate, self-report, unknown manager), the optional-field defaulting on
 * the happy path, and every `buildHirePayloadPatch` field branch. Calls the
 * services directly against a seeded HQ team (which has a Captain) so the
 * slug-exists and reports_to-resolves arms have a real roster to hit.
 */

let db: PGlite;
let teamId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	const created = await createTestTeam(db, { name: 'Hire Branches Team' });
	teamId = (await created.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

function isError(
	r: Awaited<ReturnType<typeof prepareHireProposal>>,
): r is { error: string; conflict?: boolean } {
	return 'error' in r;
}

describe('prepareHireProposal — rejection branches', () => {
	it('rejects a missing/blank title', async () => {
		const r = await prepareHireProposal(db, teamId, { title: '   ' });
		expect(isError(r) && r.error).toBe('title is required');
	});

	it('rejects an invalid default_effort', async () => {
		const r = await prepareHireProposal(db, teamId, {
			title: 'Effort Bot',
			default_effort: 'turbo',
		});
		expect(isError(r) && r.error).toMatch(/Invalid default_effort: turbo/);
	});

	it('rejects an incoherent budget trio', async () => {
		const r = await prepareHireProposal(db, teamId, {
			title: 'Budget Bot',
			daily_budget_cents: 10_000,
			weekly_budget_cents: 1, // below the daily×7 floor
		});
		expect(isError(r) && r.error).toMatch(/Weekly budget must be at least/);
	});

	it('rejects a negative budget value', async () => {
		const r = await prepareHireProposal(db, teamId, {
			title: 'Negative Bot',
			daily_budget_cents: -5,
		});
		expect(isError(r) && r.error).toMatch(/must be an integer ≥ 0/);
	});

	it('rejects a non-empty system_prompt missing required vars', async () => {
		const r = await prepareHireProposal(db, teamId, {
			title: 'Prompt Bot',
			system_prompt: 'You are a bot with no substitution variables.',
		});
		expect(isError(r) && r.error).toMatch(/missing required substitution variable/);
	});

	it('rejects a reserved slug', async () => {
		const r = await prepareHireProposal(db, teamId, { title: 'admin' });
		expect(isError(r) && r.error).toMatch(/reserved/);
	});

	it('rejects a slug that already exists in the team (with conflict flag)', async () => {
		const r = await prepareHireProposal(db, teamId, { title: CAPTAIN_AGENT_SLUG });
		expect(isError(r)).toBe(true);
		if (isError(r)) {
			expect(r.error).toMatch(/already exists in this team/);
			expect(r.conflict).toBe(true);
		}
	});

	it('rejects a duplicate pending hire proposal (with conflict flag)', async () => {
		const prepared = await prepareHireProposal(db, teamId, { title: 'Pending Dupe' });
		expect(isError(prepared)).toBe(false);
		if (isError(prepared)) return;
		await insertHireApproval(db, teamId, prepared.payload, null);

		const r = await prepareHireProposal(db, teamId, { title: 'Pending Dupe' });
		expect(isError(r)).toBe(true);
		if (isError(r)) {
			expect(r.error).toMatch(/pending hire proposal for slug/);
			expect(r.conflict).toBe(true);
		}
	});

	it('rejects an agent reporting to itself', async () => {
		const r = await prepareHireProposal(db, teamId, {
			title: 'Self Reporter',
			reports_to: 'self-reporter',
		});
		expect(isError(r) && r.error).toMatch(/cannot report to itself/);
	});

	it('rejects an unknown manager in reports_to', async () => {
		const r = await prepareHireProposal(db, teamId, {
			title: 'Orphan Bot',
			reports_to: 'no-such-manager',
		});
		expect(isError(r) && r.error).toMatch(/no agent 'no-such-manager' in this team/);
	});
});

describe('prepareHireProposal — success branches', () => {
	it('applies defaults when optional fields are omitted', async () => {
		const r = await prepareHireProposal(db, teamId, { title: 'Default Bot' });
		expect(isError(r)).toBe(false);
		if (isError(r)) return;
		const p = r.payload;
		expect(p.slug).toBe('default-bot');
		expect(p.role_description).toBe('');
		expect(p.system_prompt).toBe('');
		expect(p.reports_to).toBeNull();
		expect(p.default_effort).toBe(DEFAULT_EFFORT);
		expect(p.heartbeat_interval_min).toBe(DEFAULT_HEARTBEAT_INTERVAL_MIN);
		expect(p.daily_budget_cents).toBe(0);
		expect(p.weekly_budget_cents).toBe(0);
		expect(p.monthly_budget_cents).toBe(3000);
		expect(p.touches_code).toBe(false);
	});

	it('keeps supplied values, a compliant prompt, and a resolvable reports_to', async () => {
		const r = await prepareHireProposal(db, teamId, {
			title: 'Senior Bot',
			role_description: 'does senior things',
			system_prompt: compliantPrompt('You are a senior bot.'),
			reports_to: CAPTAIN_AGENT_SLUG,
			default_effort: 'high',
			heartbeat_interval_min: 60,
			daily_budget_cents: 100,
			weekly_budget_cents: 1000,
			monthly_budget_cents: 5000,
			touches_code: true,
		});
		expect(isError(r)).toBe(false);
		if (isError(r)) return;
		const p = r.payload;
		expect(p.role_description).toBe('does senior things');
		expect(p.reports_to).toBe(CAPTAIN_AGENT_SLUG);
		expect(p.default_effort).toBe('high');
		expect(p.heartbeat_interval_min).toBe(60);
		expect(p.touches_code).toBe(true);
		expect(p.system_prompt).toContain('You are a senior bot.');
	});
});

describe('insertHireApproval', () => {
	it('inserts a pending hire approval without a task id', async () => {
		const prepared = await prepareHireProposal(db, teamId, { title: 'Approval No Task' });
		if (isError(prepared)) throw new Error('prepare failed');
		const row = await insertHireApproval(db, teamId, prepared.payload, null);
		expect(row.type).toBe(ApprovalType.Hire);
		expect(row.status).toBe(ApprovalStatus.Pending);
		expect((row.payload as { slug: string }).slug).toBe('approval-no-task');
		expect((row.payload as Record<string, unknown>).task_id).toBeUndefined();
	});

	it('merges the originating task id into the payload when supplied', async () => {
		const prepared = await prepareHireProposal(db, teamId, { title: 'Approval With Task' });
		if (isError(prepared)) throw new Error('prepare failed');
		const row = await insertHireApproval(db, teamId, prepared.payload, null, 'task-123');
		expect((row.payload as { task_id: string }).task_id).toBe('task-123');
	});
});

describe('buildHirePayloadPatch', () => {
	it('returns an empty patch when nothing is supplied', () => {
		expect(buildHirePayloadPatch({})).toEqual({});
	});

	it('includes every supplied field, trimming title, and clears reports_to on empty', () => {
		const patch = buildHirePayloadPatch({
			title: '  Trimmed  ',
			role_description: 'desc',
			system_prompt: 'prompt',
			reports_to: '   ', // whitespace-only → cleared to null
			default_effort: 'low',
			heartbeat_interval_min: 30,
			daily_budget_cents: 1,
			weekly_budget_cents: 2,
			monthly_budget_cents: 3,
			touches_code: true,
		});
		expect(patch).toEqual({
			title: 'Trimmed',
			role_description: 'desc',
			system_prompt: 'prompt',
			reports_to: null,
			default_effort: 'low',
			heartbeat_interval_min: 30,
			daily_budget_cents: 1,
			weekly_budget_cents: 2,
			monthly_budget_cents: 3,
			touches_code: true,
		});
	});

	it('keeps a non-empty reports_to (trimmed) and a false touches_code', () => {
		const patch = buildHirePayloadPatch({ reports_to: '  captain  ', touches_code: false });
		expect(patch).toEqual({ reports_to: 'captain', touches_code: false });
	});

	it('passes null reports_to straight through as a cleared line', () => {
		expect(buildHirePayloadPatch({ reports_to: null })).toEqual({ reports_to: null });
	});
});
