import { HEZO_DOCS_URL } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveSystemPrompt } from '../src/services/template-resolver';
import { authHeader, createTestProject, createTestTeam } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

let ctx: ServerTestContext;
let teamId: string;
let projectId: string;
let projectSlug: string;
let taskPrefix: string;
let captainId: string;
let engineerId: string;

const DOCS_MARKER = '<!-- HEZO_DOCS: injected at runtime -->';

beforeAll(async () => {
	ctx = await createTestContext();

	const typesRes = await ctx.app.request('/api/team-templates', {
		headers: authHeader(ctx.token),
	});
	const startup = ((await typesRes.json()).data as Array<{ id: string; name: string }>).find(
		(t) => t.name === 'Startup',
	);
	expect(startup).toBeDefined();

	const teamRes = await createTestTeam(ctx.db, {
		name: 'Resolver Fill Co',
		description: 'Cover the resolver end to end',
		template_id: startup?.id,
	});
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(ctx.db, teamId, {
		name: 'Resolver Fill Project',
		description: 'Resolver coverage project.',
	});
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;
	taskPrefix = project.task_prefix;

	const agents = await ctx.db.query<{ id: string; slug: string }>(
		`SELECT ma.id, ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1`,
		[teamId],
	);
	captainId = agents.rows.find((a) => a.slug === 'captain')?.id as string;
	engineerId = agents.rows.find((a) => a.slug === 'engineer')?.id as string;
	expect(captainId).toBeTruthy();
	expect(engineerId).toBeTruthy();
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

describe('placeholder substitution', () => {
	it('substitutes current_date, team_name and team_description', async () => {
		const result = await resolveSystemPrompt(
			ctx.db,
			'{{current_date}} | {{team_name}} | {{team_description}}',
			{ teamId, mode: 'placeholders' },
		);
		expect(result).toMatch(
			/^\d{4}-\d{2}-\d{2} \| Resolver Fill Co \| Cover the resolver end to end/,
		);
	});

	it('substitutes empty strings for team fields on an unknown team', async () => {
		const result = await resolveSystemPrompt(ctx.db, 'N:[{{team_name}}] D:[{{team_description}}]', {
			teamId: '00000000-0000-0000-0000-000000000000',
			mode: 'placeholders',
		});
		expect(result).toContain('N:[] D:[]');
	});

	it('resolves {{reports_to}} to the manager display name for an agent', async () => {
		const result = await resolveSystemPrompt(ctx.db, 'Boss: {{reports_to}}', {
			teamId,
			agentId: engineerId,
			mode: 'placeholders',
		});
		expect(result).toContain('Boss: Architect');
	});

	it('resolves {{reports_to}} to empty without an agent', async () => {
		const result = await resolveSystemPrompt(ctx.db, 'Boss:[{{reports_to}}]', {
			teamId,
			mode: 'placeholders',
		});
		expect(result).toContain('Boss:[]');
	});

	it('substitutes {{team_context}} inline for the agent and empty without one', async () => {
		await ctx.db.query(`UPDATE member_agents SET team_context = 'CTX MARKER 42' WHERE id = $1`, [
			engineerId,
		]);
		const withAgent = await resolveSystemPrompt(ctx.db, 'TC: {{team_context}}', {
			teamId,
			agentId: engineerId,
			mode: 'placeholders',
		});
		expect(withAgent).toContain('TC: CTX MARKER 42');

		const withoutAgent = await resolveSystemPrompt(ctx.db, 'TC:[{{team_context}}]', {
			teamId,
			mode: 'placeholders',
		});
		expect(withoutAgent).toContain('TC:[]');
	});

	it('strips the retired {{kb_context}} placeholder including its trailing newline', async () => {
		const result = await resolveSystemPrompt(ctx.db, 'before\n{{kb_context}}\nafter', {
			teamId,
			mode: 'placeholders',
		});
		expect(result).not.toContain('kb_context');
		expect(result).toContain('before\nafter');
	});

	it('renders {{skills_context}} with only the built-in virtual skill when no DB skills exist', async () => {
		await ctx.db.query('DELETE FROM skills');
		const result = await resolveSystemPrompt(ctx.db, '{{skills_context}}', {
			teamId,
			mode: 'placeholders',
		});
		// The empty-DB case is no longer an empty-state message: the built-in
		// connector-recipes virtual skill always appears in the manifest.
		expect(result).toContain('The team skills database holds reusable know-how.');
		expect(result).toContain('(slug: connector-recipes)');
	});

	it('renders {{skills_context}} as a name+slug manifest pointing at get_skill', async () => {
		await ctx.db.query(
			`INSERT INTO skills (name, slug, description, content)
			 VALUES ('Deploy Runbook', 'deploy-runbook', 'How we deploy', '# Deploy'),
			        ('No Desc Skill', 'no-desc-skill', '', '# Bare')`,
		);
		const result = await resolveSystemPrompt(ctx.db, '{{skills_context}}', {
			teamId,
			mode: 'placeholders',
		});
		expect(result).toContain("Call get_skill(slug) to load a skill's full instructions");
		expect(result).toContain('- Deploy Runbook (slug: deploy-runbook): How we deploy');
		// Description-less skill gets no trailing colon segment.
		expect(result).toContain('- No Desc Skill (slug: no-desc-skill)');
		expect(result).not.toContain('- No Desc Skill (slug: no-desc-skill):');
		// Full bodies are never inlined.
		expect(result).not.toContain('# Deploy');
	});

	it('renders the {{team_preferences_context}} empty state when no preferences exist', async () => {
		const result = await resolveSystemPrompt(ctx.db, 'Prefs: {{team_preferences_context}}', {
			teamId,
			mode: 'placeholders',
		});
		expect(result).toContain('Prefs: No preferences set.');
	});

	it('renders {{team_preferences_context}} from the stored preferences doc', async () => {
		await ctx.db.query(
			`INSERT INTO documents (team_id, type, slug, content)
			 VALUES ($1, 'team_preferences', 'team-preferences', 'Always use tabs.')`,
			[teamId],
		);
		const result = await resolveSystemPrompt(ctx.db, 'Prefs: {{team_preferences_context}}', {
			teamId,
			mode: 'placeholders',
		});
		expect(result).toContain('Prefs: Always use tabs.');
	});

	it('renders the docs empty-state for {{project_docs_context}} without a project', async () => {
		const result = await resolveSystemPrompt(ctx.db, '{{project_docs_context}}', {
			teamId,
			mode: 'placeholders',
		});
		expect(result).toContain('No project documentation available yet.');
		expect(result).toContain('write_project_doc');
	});

	it('renders {{project_docs_context}} as a manifest with title and title-less lines', async () => {
		await ctx.db.query(
			`INSERT INTO documents (team_id, project_id, type, slug, title, content)
			 VALUES ($1, $2, 'project_doc', 'bare-notes.md', '', 'note body')`,
			[teamId, projectId],
		);
		const result = await resolveSystemPrompt(ctx.db, '{{project_docs_context}}', {
			teamId,
			projectId,
			mode: 'placeholders',
		});
		expect(result).toContain('read_project_doc(filename)');
		// createTestProject seeds architecture-guidelines.md with a title.
		expect(result).toMatch(
			/- architecture-guidelines\.md — Architecture Guidelines \(updated \d{4}-\d{2}-\d{2}\)/,
		);
		expect(result).toMatch(/- bare-notes\.md \(updated \d{4}-\d{2}-\d{2}\)/);
		expect(result).not.toContain('note body');
	});

	it('renders {{projects_context}} with the project roster and never HQ or UUIDs', async () => {
		const result = await resolveSystemPrompt(ctx.db, '{{projects_context}}', {
			teamId,
			mode: 'placeholders',
		});
		expect(result).toContain('Hezo is project-centric');
		expect(result).toContain(`slug: ${projectSlug}`);
		expect(result).toContain(`prefix: ${taskPrefix}`);
		expect(result).toMatch(/\d+ open tickets?/);
		expect(result).not.toContain(projectId);
		const hq = await ctx.db.query<{ slug: string }>(
			'SELECT slug FROM projects WHERE is_internal = true LIMIT 1',
		);
		expect(result).not.toContain(`slug: ${hq.rows[0].slug}`);
	});

	it('blanks {{requester_context}}', async () => {
		const result = await resolveSystemPrompt(ctx.db, 'R:[{{requester_context}}]', {
			teamId,
			mode: 'placeholders',
		});
		expect(result).toContain('R:[]');
	});
});

describe('HEZO_DOCS marker', () => {
	it('embeds the bundled docs when embedDocs is set', async () => {
		const result = await resolveSystemPrompt(ctx.db, `pre\n${DOCS_MARKER}\npost`, {
			teamId,
			embedDocs: true,
			mode: 'placeholders',
		});
		expect(result).not.toContain('HEZO_DOCS');
		expect(result).toContain('# Hezo documentation');
	});

	it('replaces the marker with a live-docs pointer otherwise', async () => {
		const result = await resolveSystemPrompt(ctx.db, `pre\n${DOCS_MARKER}\npost`, {
			teamId,
			mode: 'placeholders',
		});
		expect(result).not.toContain('HEZO_DOCS');
		expect(result).toContain(`Full Hezo product & API documentation: ${HEZO_DOCS_URL}`);
		expect(result).not.toContain('# Hezo documentation');
	});
});

describe('mode gating', () => {
	it('placeholders mode returns before appending any run blocks', async () => {
		const result = await resolveSystemPrompt(ctx.db, 'Bare {{team_name}}', {
			teamId,
			projectId,
			agentId: captainId,
			mode: 'placeholders',
		});
		expect(result).toContain('Bare Resolver Fill Co');
		expect(result).not.toContain('## Run Context');
		expect(result).not.toContain('## Project State');
		expect(result).not.toContain('## Teammates');
		expect(result).not.toContain('## Working Guidelines');
	});

	it('preview mode omits Run Context and Repository but keeps Teammates + guidelines', async () => {
		const result = await resolveSystemPrompt(ctx.db, 'Preview {{team_name}}', {
			teamId,
			projectId,
			mode: 'preview',
		});
		expect(result).toContain('Preview Resolver Fill Co');
		expect(result).not.toContain('## Run Context');
		expect(result).not.toContain('## Repository');
		expect(result).toContain('## Project State');
		expect(result).toContain('## Teammates');
		expect(result).toContain('## Working Guidelines');
	});

	it('runtime mode appends Run Context, Project State, Teammates and shared guidelines in order', async () => {
		const result = await resolveSystemPrompt(ctx.db, 'Base prompt', { teamId, projectId });
		const runCtx = result.indexOf('## Run Context');
		const state = result.indexOf('## Project State');
		const teammates = result.indexOf('## Teammates');
		const shared = result.indexOf('## Working Guidelines');
		expect(runCtx).toBeGreaterThan(-1);
		expect(state).toBeGreaterThan(runCtx);
		expect(teammates).toBeGreaterThan(state);
		expect(shared).toBeGreaterThan(teammates);
	});
});

describe('run context block', () => {
	it('names the project by slug and the ticket by identifier, never UUIDs', async () => {
		const task = await ctx.db.query<{ id: string; identifier: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority, labels)
			 VALUES ($1, $2, next_project_task_number($2), 'RCF-1', 'Run ctx ticket', 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING id, identifier`,
			[teamId, projectId],
		);
		const result = await resolveSystemPrompt(ctx.db, 'Base', {
			teamId,
			projectId,
			taskId: task.rows[0].id,
		});
		expect(result).toContain(`- Project: \`${projectSlug}\``);
		expect(result).toContain(`- Current ticket: \`${task.rows[0].identifier}\``);
		expect(result).not.toContain(task.rows[0].id);
		expect(result).not.toContain(projectId);
	});

	it('replaces the identifier list with roaming guidance for crossTeam sessions', async () => {
		const result = await resolveSystemPrompt(ctx.db, 'Base', {
			teamId,
			projectId,
			crossTeam: true,
		});
		expect(result).toContain('## Run Context');
		expect(result).toContain('You are not scoped to a single project');
		expect(result).not.toContain('## Project State');
		expect(result).not.toContain('## Teammates');
		expect(result).not.toContain('## Repository');
	});
});

describe('team context / teammates blocks', () => {
	it('emits ## Your Team when the agent has stored team_context and orders it before Teammates', async () => {
		await ctx.db.query(`UPDATE member_agents SET team_context = 'ORG CHART BODY' WHERE id = $1`, [
			captainId,
		]);
		const result = await resolveSystemPrompt(ctx.db, 'Base', { teamId, agentId: captainId });
		expect(result).toContain('## Your Team');
		expect(result).toContain('ORG CHART BODY');
		expect(result.indexOf('## Your Team')).toBeLessThan(result.indexOf('## Teammates'));
	});

	it('omits ## Your Team when the stored team_context is blank', async () => {
		await ctx.db.query(`UPDATE member_agents SET team_context = '  ' WHERE id = $1`, [captainId]);
		const result = await resolveSystemPrompt(ctx.db, 'Base', { teamId, agentId: captainId });
		expect(result).not.toContain('## Your Team');
	});

	it('lists teammates by @slug — Title and excludes the running agent', async () => {
		const result = await resolveSystemPrompt(ctx.db, 'Base', { teamId, agentId: captainId });
		expect(result).toContain('- @engineer — Engineer');
		expect(result).toContain('- @architect — Architect');
		expect(result).not.toContain('- @captain — Captain');
	});

	it('renders the no-teammates empty state on a Captain-only team', async () => {
		const soloRes = await createTestTeam(ctx.db, { name: 'Solo Fill Co' });
		const soloTeamId = (await soloRes.json()).data.id;
		const solo = await ctx.db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
			[soloTeamId],
		);
		const result = await resolveSystemPrompt(ctx.db, 'Base', {
			teamId: soloTeamId,
			agentId: solo.rows[0].id,
		});
		expect(result).toContain('## Teammates');
		expect(result).toContain('_No other enabled teammates in this team._');
	});
});

describe('project state block', () => {
	it('lists active tickets with status, priority and assignee', async () => {
		const result = await resolveSystemPrompt(ctx.db, 'Base', { teamId, projectId });
		expect(result).toContain('## Project State');
		expect(result).toContain('### Active tickets');
		// The planning ticket seeded by createTestProject is open and Captain-assigned.
		expect(result).toMatch(/- .+ — Draft execution plan.*\(backlog, high, assigned to Captain\)/);
		// The unassigned run-context ticket renders the fallback assignee.
		expect(result).toContain('assigned to unassigned');
	});

	it('shows the agent-scoped created-on-prior-runs subsection', async () => {
		const run = await ctx.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, status, started_at)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, now())
			 RETURNING id`,
			[captainId, teamId],
		);
		await ctx.db.query(
			`INSERT INTO tasks (team_id, project_id, assignee_id, created_by_run_id, number, identifier, title, status, priority, labels)
			 VALUES ($1, $2, $3, $4, next_project_task_number($2), 'RCF-CR-1', 'Fan-out to engineer', 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)`,
			[teamId, projectId, engineerId, run.rows[0].id],
		);
		const result = await resolveSystemPrompt(ctx.db, 'Base', {
			teamId,
			projectId,
			agentId: captainId,
		});
		expect(result).toContain('### Tickets you created on prior runs (newest first)');
		expect(result).toContain('Fan-out to engineer');
		expect(result).toContain('(backlog, assigned to Engineer)');
	});

	it('shows the created-none empty state for an agent with no prior creations', async () => {
		const result = await resolveSystemPrompt(ctx.db, 'Base', {
			teamId,
			projectId,
			agentId: engineerId,
		});
		expect(result).toContain('You have not created any tickets in this project on prior runs.');
	});

	it('renders the no-active-tickets empty state', async () => {
		await ctx.db.query(`UPDATE tasks SET status = 'cancelled'::task_status WHERE project_id = $1`, [
			projectId,
		]);
		const result = await resolveSystemPrompt(ctx.db, 'Base', { teamId, projectId });
		expect(result).toContain('_No active tickets in this project._');
	});
});

describe('repository block', () => {
	it('omits the block when the project has no linked repo', async () => {
		const result = await resolveSystemPrompt(ctx.db, 'Base', { teamId, projectId });
		expect(result).not.toContain('## Repository');
	});

	it('falls back to the first repo when no designated_repo_id is set', async () => {
		await ctx.db.query(
			`INSERT INTO repos (project_id, repo_identifier, host_type)
			 VALUES ($1, 'acme/first', 'github'::repo_host_type)`,
			[projectId],
		);
		const result = await resolveSystemPrompt(ctx.db, 'Base', { teamId, projectId });
		expect(result).toContain('## Repository');
		expect(result).toContain('Designated repository: `acme/first` (github)');
		expect(result).not.toContain('Also linked');
	});

	it('names the designated repo and lists the others as also-linked', async () => {
		const second = await ctx.db.query<{ id: string }>(
			`INSERT INTO repos (project_id, repo_identifier, host_type)
			 VALUES ($1, 'acme/second', 'github'::repo_host_type)
			 RETURNING id`,
			[projectId],
		);
		await ctx.db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [
			second.rows[0].id,
			projectId,
		]);
		const result = await resolveSystemPrompt(ctx.db, 'Base', { teamId, projectId });
		expect(result).toContain('Designated repository: `acme/second` (github)');
		expect(result).toContain('Also linked: `acme/first`');
		expect(result).toContain('Never create a new repository');
	});
});

describe('empty-roster projects context', () => {
	it('shows the intake pointer when only HQ exists', async () => {
		// A fresh context has only the internal HQ project.
		const fresh = await createTestContext();
		try {
			const hqTeam = await fresh.db.query<{ team_id: string }>(
				'SELECT team_id FROM projects WHERE is_internal = true LIMIT 1',
			);
			const result = await resolveSystemPrompt(fresh.db, '{{projects_context}}', {
				teamId: hqTeam.rows[0].team_id,
				mode: 'placeholders',
			});
			expect(result).toContain('No projects exist yet beyond HQ');
		} finally {
			await destroyTestContext(fresh);
		}
	});
});
