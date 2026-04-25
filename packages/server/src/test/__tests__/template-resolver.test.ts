import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { resolveSystemPrompt } from '../../services/template-resolver';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let db: PGlite;
let app: Hono<Env>;
let token: string;
let companyId: string;
let projectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Template Co',

			description: 'Build amazing things',
		}),
	});
	companyId = (await companyRes.json()).data.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Template Project', description: 'Test project.' }),
	});
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('template resolver', () => {
	it('resolves {{current_date}}', async () => {
		const result = await resolveSystemPrompt(db, 'Today is {{current_date}}.', {
			companyId,
		});
		expect(result).toMatch(/Today is \d{4}-\d{2}-\d{2}\./);
	});

	it('resolves {{company_name}}', async () => {
		const result = await resolveSystemPrompt(db, 'Working for {{company_name}}.', {
			companyId,
		});
		expect(result).toContain('Working for Template Co.');
	});

	it('resolves {{company_mission}} to company description', async () => {
		const result = await resolveSystemPrompt(db, 'Mission: {{company_mission}}', {
			companyId,
		});
		expect(result).toContain('Mission: Build amazing things');
	});

	it('resolves {{company_description}} to company description', async () => {
		const result = await resolveSystemPrompt(db, 'Desc: {{company_description}}', {
			companyId,
		});
		expect(result).toContain('Desc: Build amazing things');
	});

	it('resolves company_name, company_mission, and company_description in a single query', async () => {
		const result = await resolveSystemPrompt(
			db,
			'{{company_name}} - {{company_mission}} ({{company_description}})',
			{ companyId },
		);
		expect(result).toContain('Template Co - Build amazing things (Build amazing things)');
	});

	it('resolves {{kb_context}} with no docs', async () => {
		const result = await resolveSystemPrompt(db, 'KB: {{kb_context}}', {
			companyId,
		});
		expect(result).toContain('No knowledge base documents available');
	});

	it('renders {{kb_context}} with bare-filename link tokens when docs exist', async () => {
		const kbRes = await app.request(`/api/companies/${companyId}/kb-docs`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Coding Standards',
				slug: 'coding-standards.md',
				content: 'Prefer early returns.',
			}),
		});
		expect(kbRes.status).toBe(201);

		const result = await resolveSystemPrompt(db, '{{kb_context}}', { companyId });
		expect(result).toContain('## Coding Standards (link: coding-standards.md)');
		expect(result).toContain('Prefer early returns.');
	});

	it('resolves {{company_preferences_context}} with no prefs', async () => {
		const result = await resolveSystemPrompt(db, 'Prefs: {{company_preferences_context}}', {
			companyId,
		});
		expect(result).toContain('No preferences set');
	});

	it('resolves {{project_docs_context}} without designated repo', async () => {
		const result = await resolveSystemPrompt(db, 'Docs: {{project_docs_context}}', {
			companyId,
			projectId,
		});
		expect(result).toContain('No project documentation available');
	});

	it('renders {{project_docs_context}} with bare-filename link tokens when docs exist', async () => {
		const docRes = await app.request(
			`/api/companies/${companyId}/projects/${projectId}/docs/spec.md`,
			{
				method: 'PUT',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: 'Detailed spec.' }),
			},
		);
		expect(docRes.status).toBe(200);

		const result = await resolveSystemPrompt(db, '{{project_docs_context}}', {
			companyId,
			projectId,
		});
		expect(result).toContain('## spec.md (link: spec.md)');
		expect(result).toContain('Detailed spec.');
	});

	it('passes through text without template variables', async () => {
		const result = await resolveSystemPrompt(db, 'Hello world', { companyId });
		expect(result).toContain('Hello world');
	});

	it('resolves multiple variables in one template', async () => {
		const result = await resolveSystemPrompt(
			db,
			'Company: {{company_name}}, Date: {{current_date}}',
			{ companyId },
		);
		expect(result).toContain('Company: Template Co');
		expect(result).toMatch(/Date: \d{4}-\d{2}-\d{2}/);
	});

	it('resolves {{reports_to}} without agentId to empty string', async () => {
		const result = await resolveSystemPrompt(db, 'Reports to: {{reports_to}}', {
			companyId,
		});
		expect(result).toContain('Reports to: ');
	});

	it('resolves {{requester_context}} to empty string', async () => {
		const result = await resolveSystemPrompt(db, 'Context: {{requester_context}}', {
			companyId,
		});
		expect(result).toContain('Context: ');
	});

	it('resolves {{company_goals}} with no goals', async () => {
		const result = await resolveSystemPrompt(db, 'Goals: {{company_goals}}', { companyId });
		expect(result).toContain('No active goals');
	});

	it('resolves {{company_goals}} with active and archived goals', async () => {
		await app.request(`/api/companies/${companyId}/goals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Ship v1', description: 'Public launch by Q3.' }),
		});
		const scopedRes = await app.request(`/api/companies/${companyId}/goals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Cut hosting costs', project_id: projectId }),
		});
		const archivedRes = await app.request(`/api/companies/${companyId}/goals`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Old goal' }),
		});
		const archivedId = (await archivedRes.json()).data.id;
		await app.request(`/api/companies/${companyId}/goals/${archivedId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'archived' }),
		});
		expect(scopedRes.status).toBe(201);

		const result = await resolveSystemPrompt(db, '{{company_goals}}', { companyId });
		expect(result).toContain('Ship v1');
		expect(result).toContain('Public launch by Q3');
		expect(result).toContain('Cut hosting costs');
		expect(result).toContain('Project: Template Project');
		expect(result).toContain('Company-wide');
		expect(result).not.toContain('Old goal');
	});

	it('appends shared working guidelines to every prompt', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { companyId });
		expect(result).toContain('## Working Guidelines');
		expect(result).toContain('### Ticket Maintenance');
		expect(result).toContain('### Knowledge Maintenance');
		expect(result).toContain('### Sub-Agents & Parallel Exploration');
		expect(result).toContain('### Sub-Issue Delegation');
		expect(result).toContain('update_issue');
		expect(result).toContain('write_project_doc');
		expect(result).toContain('upsert_kb_doc');
		expect(result).toContain('create_issue');
	});

	it('injects Run Context with only company id when no project/issue', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { companyId });
		expect(result).toContain('## Run Context');
		expect(result).toContain(`Company ID: ${companyId}`);
		expect(result).not.toContain('Project ID:');
		expect(result).not.toContain('Issue ID:');
	});

	it('injects Run Context with company + project ids when issue missing', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			companyId,
			projectId,
		});
		expect(result).toContain(`Company ID: ${companyId}`);
		expect(result).toContain(`Project ID: ${projectId}`);
		expect(result).not.toContain('Issue ID:');
	});

	it('injects Run Context with all three ids when issueId supplied', async () => {
		const fakeIssueId = '11111111-2222-3333-4444-555555555555';
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			companyId,
			projectId,
			issueId: fakeIssueId,
		});
		expect(result).toContain(`Company ID: ${companyId}`);
		expect(result).toContain(`Project ID: ${projectId}`);
		expect(result).toContain(`Issue ID: ${fakeIssueId}`);
	});
});

describe('template resolver with agents', () => {
	let agentCompanyId: string;
	let engineerAgentId: string;
	let ceoAgentId: string;

	beforeAll(async () => {
		// Get the builtin company type
		const typesRes = await app.request('/api/company-types', {
			method: 'GET',
			headers: authHeader(token),
		});
		const types = (await typesRes.json()) as any;
		const softDevType = types.data.find((t: any) => t.name === 'Startup');

		// Create a company with the software dev team type to auto-create agents
		const companyRes = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Agent Test Co',

				description: 'Test company for agent templates',
				template_id: softDevType.id,
			}),
		});
		agentCompanyId = ((await companyRes.json()) as any).data.id;

		// Get agents
		const agentsRes = await app.request(`/api/companies/${agentCompanyId}/agents`, {
			method: 'GET',
			headers: authHeader(token),
		});
		const agents = ((await agentsRes.json()) as any).data;
		const engineer = agents.find((a: any) => a.slug === 'engineer');
		const ceo = agents.find((a: any) => a.slug === 'ceo');
		engineerAgentId = engineer.id;
		ceoAgentId = ceo.id;
	});

	it('resolves {{reports_to}} with agentId to manager display name', async () => {
		const result = await resolveSystemPrompt(db, 'Reports to: {{reports_to}}', {
			companyId: agentCompanyId,
			agentId: engineerAgentId,
		});
		expect(result).toContain('Reports to: Architect');
	});

	it('resolves {{reports_to}} for CEO (no manager) to empty string', async () => {
		const result = await resolveSystemPrompt(db, 'Reports to: {{reports_to}}', {
			companyId: agentCompanyId,
			agentId: ceoAgentId,
		});
		expect(result).toContain('Reports to: ');
	});

	it('resolves a full system prompt template with all variables', async () => {
		const template = `You are an Engineer at {{company_name}}.

Company mission: {{company_mission}}
You report to: Architect ({{reports_to}})

Current date: {{current_date}}

{{kb_context}}

{{company_preferences_context}}

{{project_docs_context}}

{{requester_context}}`;

		const result = await resolveSystemPrompt(db, template, {
			companyId: agentCompanyId,
			agentId: engineerAgentId,
		});

		expect(result).toContain('You are an Engineer at Agent Test Co.');
		expect(result).toContain('Company mission: Test company for agent templates');
		expect(result).toContain('You report to: Architect (Architect)');
		expect(result).toMatch(/Current date: \d{4}-\d{2}-\d{2}/);
		expect(result).toContain('Company Overview');
		expect(result).toContain('No preferences set');
		expect(result).toContain('No project documentation available');
	});

	async function getAgentPrompt(agentId: string): Promise<string> {
		const res = await app.request(
			`/api/companies/${agentCompanyId}/agents/${agentId}/system-prompt`,
			{ headers: authHeader(token) },
		);
		return (((await res.json()) as any).data?.content ?? '') as string;
	}

	it('agents created from company type have system prompts', async () => {
		const agentsRes = await app.request(`/api/companies/${agentCompanyId}/agents`, {
			method: 'GET',
			headers: authHeader(token),
		});
		const agents = ((await agentsRes.json()) as any).data;

		for (const agent of agents) {
			const prompt = await getAgentPrompt(agent.id);
			expect(prompt).toBeTruthy();
			expect(prompt.length).toBeGreaterThan(100);
			expect(prompt).toContain('{{company_name}}');
			expect(prompt).toContain('{{company_mission}}');
			expect(prompt).toContain('{{current_date}}');
			expect(prompt).toContain('{{kb_context}}');
			expect(prompt).toMatch(/##\s*Rules/);
		}
	});

	it('each agent has role-specific system prompt content', async () => {
		const agentsRes = await app.request(`/api/companies/${agentCompanyId}/agents`, {
			method: 'GET',
			headers: authHeader(token),
		});
		const agents = ((await agentsRes.json()) as any).data;
		const bySlug = new Map<string, any>(agents.map((a: any) => [a.slug, a]));

		expect(await getAgentPrompt(bySlug.get('ceo').id)).toContain('You are the CEO of');
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

	it('CEO system prompt does not use {{reports_to}}', async () => {
		const agentsRes = await app.request(`/api/companies/${agentCompanyId}/agents`, {
			method: 'GET',
			headers: authHeader(token),
		});
		const agents = ((await agentsRes.json()) as any).data;
		const ceo = agents.find((a: any) => a.slug === 'ceo');
		expect(await getAgentPrompt(ceo.id)).not.toContain('{{reports_to}}');
	});

	it('non-CEO agents use {{reports_to}} in their system prompts', async () => {
		const agentsRes = await app.request(`/api/companies/${agentCompanyId}/agents`, {
			method: 'GET',
			headers: authHeader(token),
		});
		const agents = ((await agentsRes.json()) as any).data;
		const nonCeo = agents.filter(
			(a: any) => a.slug !== 'ceo' && a.slug !== 'architect' && a.slug !== 'coach',
		);
		for (const agent of nonCeo) {
			expect(await getAgentPrompt(agent.id)).toContain('{{reports_to}}');
		}
	});
});

describe('project state block', () => {
	let psCompanyId: string;
	let psProjectId: string;
	let psCeoMemberId: string;
	let psArchitectMemberId: string;

	beforeAll(async () => {
		const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
		const startup = ((await typesRes.json()) as any).data.find((t: any) => t.name === 'Startup');

		const companyRes = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Project State Co',
				description: 'PS test company',
				template_id: startup.id,
			}),
		});
		psCompanyId = ((await companyRes.json()) as any).data.id;

		const agentsRes = await app.request(`/api/companies/${psCompanyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = ((await agentsRes.json()) as any).data;
		psCeoMemberId = agents.find((a: any) => a.slug === 'ceo').id;
		psArchitectMemberId = agents.find((a: any) => a.slug === 'architect').id;

		const projectRes = await app.request(`/api/companies/${psCompanyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'PS Project', description: 'Test' }),
		});
		psProjectId = ((await projectRes.json()).data as { id: string }).id;
	});

	it('omits Project State block when projectId is absent', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			companyId: psCompanyId,
		});
		expect(result).not.toContain('## Project State');
	});

	it('renders Project State header with active tickets when projectId is set', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			companyId: psCompanyId,
			projectId: psProjectId,
		});
		expect(result).toContain('## Project State');
		expect(result).toContain('### Active tickets');
		// Startup-template projects auto-create a planning ticket assigned to CEO.
		expect(result).toMatch(/- PP-\d+ — Draft execution plan/);
		expect(result).toContain('assigned to CEO');
	});

	it('renders empty-state when the project has no active tickets', async () => {
		// Cancel the auto-created planning ticket on a fresh project so it has no active tickets.
		const projectRes = await app.request(`/api/companies/${psCompanyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Empty PS Project', description: 'Test' }),
		});
		const emptyProjectId = ((await projectRes.json()) as any).data.id;

		await db.query(`UPDATE issues SET status = 'cancelled'::issue_status WHERE project_id = $1`, [
			emptyProjectId,
		]);

		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			companyId: psCompanyId,
			projectId: emptyProjectId,
		});
		expect(result).toContain('## Project State');
		expect(result).toContain('No active tickets in this project.');
	});

	it('lists active tickets and excludes terminal-status ones', async () => {
		const activeRes = await app.request(`/api/companies/${psCompanyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: psProjectId,
				title: 'Active backlog item',
				assignee_id: psArchitectMemberId,
			}),
		});
		const active = ((await activeRes.json()) as any).data;

		const doneRes = await app.request(`/api/companies/${psCompanyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: psProjectId,
				title: 'Already finished item',
				assignee_id: psArchitectMemberId,
			}),
		});
		const done = ((await doneRes.json()) as any).data;
		await app.request(`/api/companies/${psCompanyId}/issues/${done.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'done' }),
		});

		const result = await resolveSystemPrompt(db, 'X', {
			companyId: psCompanyId,
			projectId: psProjectId,
		});
		expect(result).toContain('## Project State');
		expect(result).toContain(active.identifier);
		expect(result).toContain('Active backlog item');
		expect(result).toContain('assigned to Architect');
		expect(result).not.toContain('Already finished item');
	});

	it('shows "Tickets you created" subsection scoped to the agent\'s prior runs', async () => {
		const planningIssueRes = await app.request(`/api/companies/${psCompanyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: psProjectId,
				title: 'CEO planning ticket',
				assignee_id: psCeoMemberId,
			}),
		});
		const planningIssue = ((await planningIssueRes.json()) as any).data;

		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, company_id, issue_id, status, started_at)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status, now())
			 RETURNING id`,
			[psCeoMemberId, psCompanyId, planningIssue.id],
		);

		const subRes = await db.query<{ identifier: string }>(
			`INSERT INTO issues (company_id, project_id, assignee_id, parent_issue_id, created_by_run_id, number, identifier, title, description, status, priority, labels)
			 VALUES ($1, $2, $3, NULL, $4, next_project_issue_number($2), 'PS-CR-1', 'Delegated to architect by CEO', '', 'backlog'::issue_status, 'medium'::issue_priority, '[]'::jsonb)
			 RETURNING identifier`,
			[psCompanyId, psProjectId, psArchitectMemberId, run.rows[0].id],
		);

		const result = await resolveSystemPrompt(db, 'X', {
			companyId: psCompanyId,
			projectId: psProjectId,
			agentId: psCeoMemberId,
		});
		expect(result).toContain('### Tickets you created on prior runs');
		expect(result).toContain(subRes.rows[0].identifier);
		expect(result).toContain('Delegated to architect by CEO');
	});

	it('"Tickets you created" is empty for an agent that hasn\'t created any', async () => {
		const result = await resolveSystemPrompt(db, 'X', {
			companyId: psCompanyId,
			projectId: psProjectId,
			agentId: psArchitectMemberId,
		});
		expect(result).toContain('### Tickets you created on prior runs');
		expect(result).toContain('You have not created any tickets in this project on prior runs');
	});

	it('omits "Tickets you created" subsection when agentId is absent', async () => {
		const result = await resolveSystemPrompt(db, 'X', {
			companyId: psCompanyId,
			projectId: psProjectId,
		});
		expect(result).not.toContain('Tickets you created on prior runs');
	});
});
