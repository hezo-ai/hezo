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

	it('renders {{kb_context}} with bare-slug link tokens when docs exist', async () => {
		const kbRes = await app.request(`/api/companies/${companyId}/kb-docs`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Coding Standards',
				slug: 'coding-standards',
				content: 'Prefer early returns.',
			}),
		});
		expect(kbRes.status).toBe(201);

		const result = await resolveSystemPrompt(db, '{{kb_context}}', { companyId });
		expect(result).toContain('## Coding Standards (link: coding-standards)');
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

	it('agents created from company type have system prompts', async () => {
		const agentsRes = await app.request(`/api/companies/${agentCompanyId}/agents`, {
			method: 'GET',
			headers: authHeader(token),
		});
		const agents = ((await agentsRes.json()) as any).data;

		for (const agent of agents) {
			expect(agent.system_prompt).toBeTruthy();
			expect(agent.system_prompt.length).toBeGreaterThan(100);
			expect(agent.system_prompt).toContain('{{company_name}}');
			expect(agent.system_prompt).toContain('{{company_mission}}');
			expect(agent.system_prompt).toContain('{{current_date}}');
			expect(agent.system_prompt).toContain('{{kb_context}}');
			expect(agent.system_prompt).toMatch(/##\s*Rules/);
		}
	});

	it('each agent has role-specific system prompt content', async () => {
		const agentsRes = await app.request(`/api/companies/${agentCompanyId}/agents`, {
			method: 'GET',
			headers: authHeader(token),
		});
		const agents = ((await agentsRes.json()) as any).data;

		const bySlug = new Map<string, any>(agents.map((a: any) => [a.slug, a]));

		expect(bySlug.get('ceo').system_prompt).toContain('You are the CEO of');
		expect(bySlug.get('architect').system_prompt).toContain('You are the Architect at');
		expect(bySlug.get('product-lead').system_prompt).toContain('You are the Product Lead at');
		expect(bySlug.get('engineer').system_prompt).toContain('You are an Engineer at');
		expect(bySlug.get('qa-engineer').system_prompt).toContain('You are the QA Engineer at');
		expect(bySlug.get('ui-designer').system_prompt).toContain('You are the UI Designer at');
		expect(bySlug.get('devops-engineer').system_prompt).toContain('You are the DevOps Engineer at');
		expect(bySlug.get('marketing-lead').system_prompt).toContain('You are the Marketing Lead at');
		expect(bySlug.get('researcher').system_prompt).toContain('You are the Researcher at');
	});

	it('CEO system prompt does not use {{reports_to}}', async () => {
		const agentsRes = await app.request(`/api/companies/${agentCompanyId}/agents`, {
			method: 'GET',
			headers: authHeader(token),
		});
		const agents = ((await agentsRes.json()) as any).data;
		const ceo = agents.find((a: any) => a.slug === 'ceo');
		expect(ceo.system_prompt).not.toContain('{{reports_to}}');
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
			expect(agent.system_prompt).toContain('{{reports_to}}');
		}
	});
});
