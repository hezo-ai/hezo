import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { resolveSystemPrompt } from '../src/services/template-resolver';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	projectSlugForTeamSlug,
} from './helpers/app';

let db: PGlite;
let app: Hono<Env>;
let token: string;
let teamId: string;
let projectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Template Co',

			description: 'Build amazing things',
		}),
	});
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Template Project',
		description: 'Test project.',
	});
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('template resolver', () => {
	it('resolves {{current_date}}', async () => {
		const result = await resolveSystemPrompt(db, 'Today is {{current_date}}.', {
			teamId,
		});
		expect(result).toMatch(/Today is \d{4}-\d{2}-\d{2}\./);
	});

	it('resolves {{team_name}}', async () => {
		const result = await resolveSystemPrompt(db, 'Working for {{team_name}}.', {
			teamId,
		});
		expect(result).toContain('Working for Template Co.');
	});

	it('resolves {{team_mission}} to team description', async () => {
		const result = await resolveSystemPrompt(db, 'Mission: {{team_mission}}', {
			teamId,
		});
		expect(result).toContain('Mission: Build amazing things');
	});

	it('resolves {{team_description}} to team description', async () => {
		const result = await resolveSystemPrompt(db, 'Desc: {{team_description}}', {
			teamId,
		});
		expect(result).toContain('Desc: Build amazing things');
	});

	it('resolves team_name, team_mission, and team_description in a single query', async () => {
		const result = await resolveSystemPrompt(
			db,
			'{{team_name}} - {{team_mission}} ({{team_description}})',
			{ teamId },
		);
		expect(result).toContain('Template Co - Build amazing things (Build amazing things)');
	});

	it('resolves {{team_preferences_context}} with no prefs', async () => {
		const result = await resolveSystemPrompt(db, 'Prefs: {{team_preferences_context}}', {
			teamId,
		});
		expect(result).toContain('No preferences set');
	});

	it('resolves {{project_docs_context}} to empty-state when the project has no docs', async () => {
		// The team already owns its one project (created in beforeAll), and the 1:1
		// invariant forbids a second on the same team — so the docless project lives
		// on its own fresh team.
		const doclessTeamRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Docless Co', description: 'No docs here' }),
		});
		const doclessTeamId = (await doclessTeamRes.json()).data.id as string;
		const bare = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, description, docker_base_image)
			 VALUES ($1, 'Docless', 'docless', 'DL', 'No docs here', 'hezo/agent-base:latest')
			 RETURNING id`,
			[doclessTeamId],
		);
		const result = await resolveSystemPrompt(db, 'Docs: {{project_docs_context}}', {
			teamId: doclessTeamId,
			projectId: bare.rows[0].id,
		});
		expect(result).toContain('No project documentation available');
	});

	it('renders {{project_docs_context}} with a not-a-file warning and bare-filename headings when docs exist', async () => {
		const docRes = await app.request(`/api/projects/${projectId}/docs/spec.md`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: 'Detailed spec.' }),
		});
		expect(docRes.status).toBe(200);

		const result = await resolveSystemPrompt(db, '{{project_docs_context}}', {
			teamId,
			projectId,
		});
		expect(result).toContain(
			'The following project docs are stored in the project-doc database, not the filesystem.',
		);
		expect(result).toContain('use `write_project_doc`');
		expect(result).toContain('`Edit`/`Write` tools will NOT work');
		expect(result).toContain('### spec.md');
		expect(result).not.toContain('## spec.md (link: spec.md)');
		expect(result).toContain('Detailed spec.');

		const warningIdx = result.indexOf(
			'The following project docs are stored in the project-doc database',
		);
		const headingIdx = result.indexOf('### spec.md');
		expect(warningIdx).toBeGreaterThanOrEqual(0);
		expect(headingIdx).toBeGreaterThan(warningIdx);
	});

	it('passes through text without template variables', async () => {
		const result = await resolveSystemPrompt(db, 'Hello world', { teamId });
		expect(result).toContain('Hello world');
	});

	it('resolves multiple variables in one template', async () => {
		const result = await resolveSystemPrompt(db, 'Team: {{team_name}}, Date: {{current_date}}', {
			teamId,
		});
		expect(result).toContain('Team: Template Co');
		expect(result).toMatch(/Date: \d{4}-\d{2}-\d{2}/);
	});

	it('resolves {{reports_to}} without agentId to empty string', async () => {
		const result = await resolveSystemPrompt(db, 'Reports to: {{reports_to}}', {
			teamId,
		});
		expect(result).toContain('Reports to: ');
	});

	it('resolves {{requester_context}} to empty string', async () => {
		const result = await resolveSystemPrompt(db, 'Context: {{requester_context}}', {
			teamId,
		});
		expect(result).toContain('Context: ');
	});

	it('appends shared working guidelines to every prompt', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		expect(result).toContain('## Working Guidelines');
		expect(result).toContain('### Ticket Maintenance');
		expect(result).toContain('### Completion Handoff');
		expect(result).toContain('### Knowledge Maintenance');
		expect(result).toContain('### Sub-Agents & Parallel Exploration');
		expect(result).toContain('### Sub-Task Delegation');
		expect(result).toContain('### Fetching External URLs');
		expect(result).toContain('curl');
		expect(result).toContain('### Comment Timing');
		expect(result).toContain('update_task');
		expect(result).toContain('write_project_doc');
		expect(result).toContain('create_skill');
		expect(result).toContain('create_task');
	});

	it('completion handoff guidance covers mark-done, auto-wake, and no-mention rules', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		expect(result).toContain('### Completion Handoff');
		expect(result).toContain('update_task(status: "done")');
		expect(result).toContain('dependents');
		expect(result).toContain('do not `@`-mention any agent in that comment');
	});

	it('tells agents not to park a done deliverable as blocked and to spin off the gated tail', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		expect(result).toContain(
			"Don't park a ticket `blocked` when your own deliverable is already done",
		);
		expect(result).toContain('blocked_by_task_ids');
		expect(result).toContain('deliverable-feed test');
	});

	it('mention discipline names the three structural-routing channels and the handoff carve-out', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		expect(result).toContain('### @-Mention Discipline');
		// three structural channels that already wake the recipient
		expect(result).toContain('`create_task` with `assignee_slug`');
		expect(result).toContain('`blocked_by_task_ids`');
		expect(result).toContain('cascade unblock');
		// explicit handoff carve-out: use @@, not @
		expect(result).toContain('Handoff comments specifically');
		expect(result).toContain('reference the next role as `@@<slug>`, not `@<slug>`');
		// rubric example shows the passive-handoff pattern
		expect(result).toContain('@@architect — BE-4 and BE-5 unblock now');
	});

	it('mention discipline makes @@ the explicit default and flags the status-recap antipattern', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// passive is the explicit presumption; single-@ is the deliberate exception
		expect(result).toContain('Default to `@@` (passive)');
		expect(result).toContain('do I need this agent to act on this ticket right now');
		// the exact pattern that over-pinged the roster: crediting reviewers in a recap stays passive
		expect(result).toContain('Status updates and review recaps credit people');
		expect(result).toContain('at most one');
	});

	it('injects Run Context with only team id when no project/task', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		expect(result).toContain('## Run Context');
		expect(result).toContain(`Team ID: ${teamId}`);
		expect(result).not.toContain('Project ID:');
		expect(result).not.toContain('Task ID:');
	});

	it('injects Run Context with team + project ids when task missing', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId,
			projectId,
		});
		expect(result).toContain(`Team ID: ${teamId}`);
		expect(result).toContain(`Project ID: ${projectId}`);
		expect(result).not.toContain('Task ID:');
	});

	it('injects Run Context with all three ids when taskId supplied', async () => {
		const fakeTaskId = '11111111-2222-3333-4444-555555555555';
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId,
			projectId,
			taskId: fakeTaskId,
		});
		expect(result).toContain(`Team ID: ${teamId}`);
		expect(result).toContain(`Project ID: ${projectId}`);
		expect(result).toContain(`Task ID: ${fakeTaskId}`);
	});

	it('preview mode substitutes placeholders, omits Run Context, keeps Teammates and Working Guidelines', async () => {
		const result = await resolveSystemPrompt(
			db,
			'Working for {{team_name}}, mission: {{team_mission}}.',
			{ teamId, mode: 'preview' },
		);
		expect(result).toContain('Working for Template Co');
		expect(result).toContain('Build amazing things');
		expect(result).not.toContain('{{');
		expect(result).not.toContain('## Run Context');
		expect(result).not.toContain(`Team ID: ${teamId}`);
		expect(result).toContain('## Teammates');
		expect(result).toContain('## Working Guidelines');
	});
});

describe('template resolver with agents', () => {
	let agentTeamId: string;
	let agentTeamSlug: string;
	let engineerAgentId: string;
	let captainAgentId: string;

	beforeAll(async () => {
		// Get the builtin team type
		const typesRes = await app.request('/api/team-templates', {
			method: 'GET',
			headers: authHeader(token),
		});
		const types = (await typesRes.json()) as any;
		const softDevType = types.data.find((t: any) => t.name === 'Startup');

		// Create a team with the software dev team type to auto-create agents
		const teamRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Agent Test Co',

				description: 'Test team for agent templates',
				template_id: softDevType.id,
			}),
		});
		const agentTeamData = ((await teamRes.json()) as any).data;
		agentTeamId = agentTeamData.id;
		agentTeamSlug = agentTeamData.slug;

		// Get agents
		const agentsRes = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, agentTeamSlug)}/agents`,
			{
				method: 'GET',
				headers: authHeader(token),
			},
		);
		const agents = ((await agentsRes.json()) as any).data;
		const engineer = agents.find((a: any) => a.slug === 'engineer');
		const captain = agents.find((a: any) => a.slug === 'captain');
		engineerAgentId = engineer.id;
		captainAgentId = captain.id;
	});

	it('resolves {{reports_to}} with agentId to manager display name', async () => {
		const result = await resolveSystemPrompt(db, 'Reports to: {{reports_to}}', {
			teamId: agentTeamId,
			agentId: engineerAgentId,
		});
		expect(result).toContain('Reports to: Architect');
	});

	it('resolves {{reports_to}} for Captain (no manager) to empty string', async () => {
		const result = await resolveSystemPrompt(db, 'Reports to: {{reports_to}}', {
			teamId: agentTeamId,
			agentId: captainAgentId,
		});
		expect(result).toContain('Reports to: ');
	});

	it('resolves a full system prompt template with all variables', async () => {
		const template = `You are an Engineer at {{team_name}}.

Team mission: {{team_mission}}
You report to: Architect ({{reports_to}})

Current date: {{current_date}}

{{skills_context}}

{{team_preferences_context}}

{{project_docs_context}}

{{requester_context}}`;

		await db.query(
			"INSERT INTO skills (team_id, name, slug, description, content) VALUES ($1, 'Team Overview', 'team-overview', 'Team overview summary', '# Team Overview')",
			[agentTeamId],
		);

		const result = await resolveSystemPrompt(db, template, {
			teamId: agentTeamId,
			agentId: engineerAgentId,
		});

		expect(result).toContain('You are an Engineer at Agent Test Co.');
		expect(result).toContain('Team mission: Test team for agent templates');
		expect(result).toContain('You report to: Architect (Architect)');
		expect(result).toMatch(/Current date: \d{4}-\d{2}-\d{2}/);
		expect(result).toContain('Team Overview');
		expect(result).toContain('No preferences set');
		expect(result).toContain('No project documentation available');
	});

	async function getAgentPrompt(agentId: string): Promise<string> {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, agentTeamSlug)}/agents/${agentId}/system-prompt`,
			{
				headers: authHeader(token),
			},
		);
		return (((await res.json()) as any).data?.content ?? '') as string;
	}

	it('agents created from team type have system prompts', async () => {
		const agentsRes = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, agentTeamSlug)}/agents`,
			{
				method: 'GET',
				headers: authHeader(token),
			},
		);
		const agents = ((await agentsRes.json()) as any).data.filter((a: any) => !a.is_instance);

		for (const agent of agents) {
			const prompt = await getAgentPrompt(agent.id);
			expect(prompt).toBeTruthy();
			expect(prompt.length).toBeGreaterThan(100);
			expect(prompt).toContain('{{team_name}}');
			expect(prompt).toContain('{{team_mission}}');
			expect(prompt).toContain('{{current_date}}');
			expect(prompt).toContain('{{skills_context}}');
			expect(prompt).toMatch(/##\s*Rules/);
		}
	});

	it('each agent has role-specific system prompt content', async () => {
		const agentsRes = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, agentTeamSlug)}/agents`,
			{
				method: 'GET',
				headers: authHeader(token),
			},
		);
		const agents = ((await agentsRes.json()) as any).data;
		const bySlug = new Map<string, any>(agents.map((a: any) => [a.slug, a]));

		expect(await getAgentPrompt(bySlug.get('captain').id)).toContain('You are the Captain of');
		expect(await getAgentPrompt(bySlug.get('architect').id)).toContain('You are the Architect at');
		expect(await getAgentPrompt(bySlug.get('product-lead').id)).toContain(
			'You are the Product Lead at',
		);
		expect(await getAgentPrompt(bySlug.get('engineer').id)).toContain('You are an Engineer at');
		expect(await getAgentPrompt(bySlug.get('qa-engineer').id)).toContain(
			'You are the QA Engineer at',
		);
		expect(await getAgentPrompt(bySlug.get('ui-designer').id)).toContain(
			'You are the UI Designer at',
		);
		expect(await getAgentPrompt(bySlug.get('devops-engineer').id)).toContain(
			'You are the DevOps Engineer at',
		);
		expect(await getAgentPrompt(bySlug.get('marketing-lead').id)).toContain(
			'You are the Marketing Lead at',
		);
		expect(await getAgentPrompt(bySlug.get('researcher').id)).toContain(
			'You are the Researcher at',
		);
	});

	it('Captain system prompt does not use {{reports_to}}', async () => {
		const agentsRes = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, agentTeamSlug)}/agents`,
			{
				method: 'GET',
				headers: authHeader(token),
			},
		);
		const agents = ((await agentsRes.json()) as any).data;
		const captain = agents.find((a: any) => a.slug === 'captain');
		expect(await getAgentPrompt(captain.id)).not.toContain('{{reports_to}}');
	});

	it('non-Captain agents use {{reports_to}} in their system prompts', async () => {
		const agentsRes = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, agentTeamSlug)}/agents`,
			{
				method: 'GET',
				headers: authHeader(token),
			},
		);
		const agents = ((await agentsRes.json()) as any).data;
		const nonCeo = agents.filter(
			(a: any) => !a.is_instance && a.slug !== 'captain' && a.slug !== 'architect',
		);
		for (const agent of nonCeo) {
			expect(await getAgentPrompt(agent.id)).toContain('{{reports_to}}');
		}
	});
});

describe('teammates block', () => {
	let tbTeamId: string;
	let tbTeamSlug: string;
	let tbCaptainMemberId: string;
	let tbEngineerMemberId: string;

	beforeAll(async () => {
		const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
		const startup = ((await typesRes.json()) as any).data.find((t: any) => t.name === 'Startup');

		const teamRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Teammates Co',
				description: 'Teammates block test team',
				template_id: startup.id,
			}),
		});
		const tbTeamData = ((await teamRes.json()) as any).data;
		tbTeamId = tbTeamData.id;
		tbTeamSlug = tbTeamData.slug;

		const agentsRes = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, tbTeamSlug)}/agents`,
			{
				headers: authHeader(token),
			},
		);
		const agents = ((await agentsRes.json()) as any).data;
		tbCaptainMemberId = agents.find((a: any) => a.slug === 'captain').id;
		tbEngineerMemberId = agents.find((a: any) => a.slug === 'engineer').id;
	});

	it('appends a Teammates header and the slug-not-title directive to every prompt', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId: tbTeamId });
		expect(result).toContain('## Teammates');
		expect(result).toContain('write `@<slug>` (active) or `@@<slug>` (passive) from this list');
		expect(result).toContain('Bare titles do not linkify.');
	});

	it('lists every enabled peer in @<slug> — Title form, sorted by title', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId: tbTeamId });
		expect(result).toContain('- @architect — Architect');
		expect(result).toContain('- @captain — Captain');
		expect(result).toContain('- @engineer — Engineer');
		expect(result).toContain('- @product-lead — Product Lead');
		expect(result).toContain('- @qa-engineer — QA Engineer');
		expect(result).toContain('- @researcher — Researcher');

		const block = result.slice(result.indexOf('## Teammates'));
		const archIdx = block.indexOf('- @architect');
		const captainIdx = block.indexOf('- @captain');
		const engIdx = block.indexOf('- @engineer');
		expect(archIdx).toBeGreaterThan(-1);
		expect(archIdx).toBeLessThan(captainIdx);
		expect(captainIdx).toBeLessThan(engIdx);
	});

	it('excludes the running agent from the teammates list', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: tbTeamId,
			agentId: tbCaptainMemberId,
		});
		expect(result).toContain('## Teammates');
		expect(result).not.toContain('- @captain — Captain');
		expect(result).toContain('- @architect — Architect');
		expect(result).toContain('- @engineer — Engineer');
	});

	it('excludes agents with admin_status != enabled', async () => {
		await db.query(
			`UPDATE member_agents SET admin_status = 'disabled'::agent_admin_status WHERE id = $1`,
			[tbEngineerMemberId],
		);

		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId: tbTeamId });
		expect(result).toContain('## Teammates');
		expect(result).not.toContain('- @engineer — Engineer');
		expect(result).toContain('- @architect — Architect');

		await db.query(
			`UPDATE member_agents SET admin_status = 'enabled'::agent_admin_status WHERE id = $1`,
			[tbEngineerMemberId],
		);
	});

	it('does not include agents from other teams', async () => {
		const otherRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Isolated Co', description: 'builtin agents only' }),
		});
		const otherId = ((await otherRes.json()) as any).data.id;

		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId: otherId });
		expect(result).toContain('## Teammates');
		// The builtin Captain is seeded for every team (Coach now lives only in HQ),
		// but the startup-template-only roles from the other test team must not bleed in.
		expect(result).toContain('- @captain — Captain');
		expect(result).not.toContain('- @coach — Coach');
		expect(result).not.toContain('- @architect — Architect');
		expect(result).not.toContain('- @engineer — Engineer');
		expect(result).not.toContain('- @product-lead — Product Lead');
	});

	it('renders before SHARED_INSTRUCTIONS and after the Project State block', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId: tbTeamId });
		const teammatesIdx = result.indexOf('## Teammates');
		const guidelinesIdx = result.indexOf('## Working Guidelines');
		expect(teammatesIdx).toBeGreaterThan(-1);
		expect(guidelinesIdx).toBeGreaterThan(-1);
		expect(teammatesIdx).toBeLessThan(guidelinesIdx);
	});
});

describe('team context block', () => {
	let tcTeamId: string;
	let tcTeamSlug: string;
	let tcCaptainMemberId: string;
	let tcEngineerMemberId: string;

	beforeAll(async () => {
		const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
		const startup = ((await typesRes.json()) as any).data.find((t: any) => t.name === 'Startup');

		const teamRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Team Context Co',
				description: 'Team context block test team',
				template_id: startup.id,
			}),
		});
		const tcTeamData = ((await teamRes.json()) as any).data;
		tcTeamId = tcTeamData.id;
		tcTeamSlug = tcTeamData.slug;

		const agentsRes = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, tcTeamSlug)}/agents`,
			{
				headers: authHeader(token),
			},
		);
		const agents = ((await agentsRes.json()) as any).data;
		tcCaptainMemberId = agents.find((a: any) => a.slug === 'captain').id;
		tcEngineerMemberId = agents.find((a: any) => a.slug === 'engineer').id;
	});

	it('emits a ## Your Team block when the agent has a stored team_context', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: tcTeamId,
			agentId: tcEngineerMemberId,
		});
		expect(result).toContain('## Your Team');
		expect(result).toContain('precomputed so you don');
	});

	it("renders the engineer's stored team_context content (Startup template default)", async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: tcTeamId,
			agentId: tcEngineerMemberId,
		});
		expect(result).toContain('You report to the @architect');
		expect(result).toContain('@qa-engineer');
		expect(result).toContain('@security-engineer');
	});

	it('omits the block entirely when team_context is empty', async () => {
		await db.query(`UPDATE member_agents SET team_context = '' WHERE id = $1`, [
			tcEngineerMemberId,
		]);

		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: tcTeamId,
			agentId: tcEngineerMemberId,
		});
		expect(result).not.toContain('## Your Team');
		// Teammates block still renders as a fallback.
		expect(result).toContain('## Teammates');
	});

	it('omits the block when no agentId is supplied (preview/team-level resolve)', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId: tcTeamId });
		expect(result).not.toContain('## Your Team');
	});

	it('renders Your Team before Teammates so the rich narrative leads', async () => {
		await db.query(`UPDATE member_agents SET team_context = $1 WHERE id = $2`, [
			'Test team_context content',
			tcCaptainMemberId,
		]);
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: tcTeamId,
			agentId: tcCaptainMemberId,
		});
		const yourTeamIdx = result.indexOf('## Your Team');
		const teammatesIdx = result.indexOf('## Teammates');
		expect(yourTeamIdx).toBeGreaterThan(-1);
		expect(teammatesIdx).toBeGreaterThan(yourTeamIdx);
	});

	it('substitutes {{team_context}} inline when the template uses it', async () => {
		await db.query(`UPDATE member_agents SET team_context = $1 WHERE id = $2`, [
			'INLINE TEAM CONTEXT MARKER',
			tcCaptainMemberId,
		]);
		const result = await resolveSystemPrompt(db, 'Body: {{team_context}}', {
			teamId: tcTeamId,
			agentId: tcCaptainMemberId,
		});
		expect(result).toContain('Body: INLINE TEAM CONTEXT MARKER');
	});
});

describe('project state block', () => {
	let psTeamId: string;
	let psTeamSlug: string;
	let psProjectId: string;
	let psProjectSlug: string;
	let psCaptainMemberId: string;
	let psArchitectMemberId: string;

	beforeAll(async () => {
		const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
		const startup = ((await typesRes.json()) as any).data.find((t: any) => t.name === 'Startup');

		const teamRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Project State Co',
				description: 'PS test team',
				template_id: startup.id,
			}),
		});
		const psTeamData = ((await teamRes.json()) as any).data;
		psTeamId = psTeamData.id;
		psTeamSlug = psTeamData.slug;

		// Materialize the team's single project up front so its prefix (PP) and
		// planning ticket are the ones the Project State block reflects. Creating it
		// before resolving the agents endpoint avoids a generic 'Work Project' being
		// minted first and returned by the idempotent helper.
		const projectRes = await createTestProject(db, psTeamId, {
			name: 'PS Project',
			description: 'Test',
		});
		const psProjectData = (await projectRes.json()).data as { id: string; slug: string };
		psProjectId = psProjectData.id;
		psProjectSlug = psProjectData.slug;

		const agentsRes = await app.request(`/api/projects/${psProjectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = ((await agentsRes.json()) as any).data;
		psCaptainMemberId = agents.find((a: any) => a.slug === 'captain').id;
		psArchitectMemberId = agents.find((a: any) => a.slug === 'architect').id;
	});

	it('omits Project State block when projectId is absent', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: psTeamId,
		});
		expect(result).not.toContain('## Project State');
	});

	it('renders Project State header with active tickets when projectId is set', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: psTeamId,
			projectId: psProjectId,
		});
		expect(result).toContain('## Project State');
		expect(result).toContain('### Active tickets');
		// Startup-template projects auto-create a planning ticket assigned to the Captain.
		expect(result).toMatch(/- PP-\d+ — Draft execution plan/);
		expect(result).toContain('assigned to Captain');
	});

	it('renders empty-state when the project has no active tickets', async () => {
		// Cancel the auto-created planning ticket on a fresh project so it has no active tickets.
		const projectRes = await createTestProject(db, psTeamId, {
			name: 'Empty PS Project',
			description: 'Test',
		});
		const emptyProjectId = ((await projectRes.json()) as any).data.id;

		await db.query(`UPDATE tasks SET status = 'cancelled'::task_status WHERE project_id = $1`, [
			emptyProjectId,
		]);

		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: psTeamId,
			projectId: emptyProjectId,
		});
		expect(result).toContain('## Project State');
		expect(result).toContain('No active tickets in this project.');
	});

	it('lists active tickets and excludes terminal-status ones', async () => {
		const activeRes = await app.request(`/api/projects/${psProjectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: psProjectId,
				title: 'Active backlog item',
				assignee_id: psArchitectMemberId,
			}),
		});
		const active = ((await activeRes.json()) as any).data;

		const doneRes = await app.request(`/api/projects/${psProjectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: psProjectId,
				title: 'Already finished item',
				assignee_id: psArchitectMemberId,
			}),
		});
		const done = ((await doneRes.json()) as any).data;
		await app.request(`/api/projects/${psProjectSlug}/tasks/${done.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'done' }),
		});

		const result = await resolveSystemPrompt(db, 'X', {
			teamId: psTeamId,
			projectId: psProjectId,
		});
		expect(result).toContain('## Project State');
		expect(result).toContain(active.identifier);
		expect(result).toContain('Active backlog item');
		expect(result).toContain('assigned to Architect');
		expect(result).not.toContain('Already finished item');
	});

	it('shows "Tickets you created" subsection scoped to the agent\'s prior runs', async () => {
		const planningTaskRes = await app.request(`/api/projects/${psProjectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: psProjectId,
				title: 'Captain planning ticket',
				assignee_id: psCaptainMemberId,
			}),
		});
		const planningTask = ((await planningTaskRes.json()) as any).data;

		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status, now())
			 RETURNING id`,
			[psCaptainMemberId, psTeamId, planningTask.id],
		);

		const subRes = await db.query<{ identifier: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, parent_task_id, created_by_run_id, number, identifier, title, description, status, priority, labels)
			 VALUES ($1, $2, $3, NULL, $4, next_project_task_number($2), 'PS-CR-1', 'Delegated to architect by Captain', '', 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING identifier`,
			[psTeamId, psProjectId, psArchitectMemberId, run.rows[0].id],
		);

		const result = await resolveSystemPrompt(db, 'X', {
			teamId: psTeamId,
			projectId: psProjectId,
			agentId: psCaptainMemberId,
		});
		expect(result).toContain('### Tickets you created on prior runs');
		expect(result).toContain(subRes.rows[0].identifier);
		expect(result).toContain('Delegated to architect by Captain');
	});

	it('"Tickets you created" is empty for an agent that hasn\'t created any', async () => {
		const result = await resolveSystemPrompt(db, 'X', {
			teamId: psTeamId,
			projectId: psProjectId,
			agentId: psArchitectMemberId,
		});
		expect(result).toContain('### Tickets you created on prior runs');
		expect(result).toContain('You have not created any tickets in this project on prior runs');
	});

	it('omits "Tickets you created" subsection when agentId is absent', async () => {
		const result = await resolveSystemPrompt(db, 'X', {
			teamId: psTeamId,
			projectId: psProjectId,
		});
		expect(result).not.toContain('Tickets you created on prior runs');
	});
});
