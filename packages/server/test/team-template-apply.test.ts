import { CAPTAIN_AGENT_SLUG, COACH_AGENT_SLUG, DEFAULT_TEAM_ID, DocumentType } from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { applyTemplateToTeam } from '../src/services/team-template-apply';
import { createTeam } from '../src/services/teams';
import { safeClose } from './helpers';
import { createTestApp, createTestProject } from './helpers/app';

let db: Db;
let docker: { listContainers: () => Promise<unknown[]> };
let dataDir: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	docker = { listContainers: async () => [] };
	dataDir = ctx.dataDir;
});

beforeEach(async () => {
	// Keep the HQ team (it hosts the CEO that coordination flows depend on).
	await db.query('DELETE FROM teams WHERE id != $1', [DEFAULT_TEAM_ID]);
});

afterAll(async () => {
	await safeClose(db);
});

async function getTemplateId(name: string): Promise<string> {
	const r = await db.query<{ id: string }>('SELECT id FROM team_templates WHERE name = $1', [name]);
	return r.rows[0].id;
}

async function getAgentSlugs(teamId: string): Promise<string[]> {
	const r = await db.query<{ slug: string }>(
		`SELECT ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 ORDER BY ma.slug`,
		[teamId],
	);
	return r.rows.map((x) => x.slug);
}

async function getAgentSystemPrompt(teamId: string, slug: string): Promise<string> {
	const r = await db.query<{ content: string }>(
		`SELECT d.content FROM documents d
		 JOIN member_agents ma ON ma.id = d.member_agent_id
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $2 AND d.type = $3`,
		[teamId, slug, DocumentType.AgentSystemPrompt],
	);
	return r.rows[0]?.content ?? '';
}

async function getCaptainMemberId(teamId: string): Promise<string | null> {
	const r = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $2`,
		[teamId, CAPTAIN_AGENT_SLUG],
	);
	return r.rows[0]?.id ?? null;
}

describe('applyTemplateToTeam', () => {
	it('seeds the Captain when applying Blank to a fresh team', async () => {
		const blankId = await getTemplateId('Blank');
		const team = await createTeam(
			{ db, docker: docker as never, dataDir },
			{ name: 'Apply Blank Co', templateId: blankId },
		);

		const slugs = await getAgentSlugs(team.id);
		expect(slugs).toEqual([CAPTAIN_AGENT_SLUG]);
	});

	it('upgrades the existing Blank Captain prompt when App Team is applied later', async () => {
		const blankId = await getTemplateId('Blank');
		const startupId = await getTemplateId('App Team');

		const team = await createTeam(
			{ db, docker: docker as never, dataDir },
			{ name: 'Apply Upgrade Co', templateId: blankId },
		);
		const captainIdBefore = await getCaptainMemberId(team.id);
		const promptBefore = await getAgentSystemPrompt(team.id, CAPTAIN_AGENT_SLUG);

		await applyTemplateToTeam(db, team.id, startupId, { dataDir });

		const captainIdAfter = await getCaptainMemberId(team.id);
		expect(captainIdAfter).toBe(captainIdBefore);

		const promptAfter = await getAgentSystemPrompt(team.id, CAPTAIN_AGENT_SLUG);
		expect(promptAfter).not.toBe(promptBefore);
		expect(promptAfter.length).toBeGreaterThan(0);

		const slugs = await getAgentSlugs(team.id);
		expect(slugs).toContain('architect');
		expect(slugs).toContain('engineer');
		expect(slugs).toContain('product-lead');
		expect(slugs).toContain(CAPTAIN_AGENT_SLUG);
		expect(slugs).not.toContain(COACH_AGENT_SLUG);
		expect(new Set(slugs).size).toBe(slugs.length);
	});

	it('is additive — applying App Team twice does not duplicate agents', async () => {
		const blankId = await getTemplateId('Blank');
		const startupId = await getTemplateId('App Team');

		const team = await createTeam(
			{ db, docker: docker as never, dataDir },
			{ name: 'Apply Idempotent Co', templateId: blankId },
		);
		await applyTemplateToTeam(db, team.id, startupId, { dataDir });
		const before = await getAgentSlugs(team.id);

		await applyTemplateToTeam(db, team.id, startupId, { dataDir });
		const after = await getAgentSlugs(team.id);

		expect(after).toEqual(before);
	});

	it('enqueues a team-coherence-review task when the roster actually changed', async () => {
		const blankId = await getTemplateId('Blank');
		const startupId = await getTemplateId('App Team');

		const team = await createTeam(
			{ db, docker: docker as never, dataDir },
			{ name: 'Apply Coherence Co', templateId: blankId },
		);
		// Coherence/setup tasks live in the team's own project (CEO-actioned).
		await createTestProject(db, team.id, { name: 'Coherence Project' });
		const before = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM tasks
			 WHERE team_id = $1 AND labels @> '["team-coherence-review"]'::jsonb`,
			[team.id],
		);
		expect(before.rows[0].count).toBe(0);

		await applyTemplateToTeam(db, team.id, startupId, { dataDir });

		const after = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM tasks
			 WHERE team_id = $1 AND labels @> '["team-coherence-review"]'::jsonb`,
			[team.id],
		);
		expect(after.rows[0].count).toBeGreaterThanOrEqual(1);
	});
});
