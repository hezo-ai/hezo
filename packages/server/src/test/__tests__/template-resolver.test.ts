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
		body: JSON.stringify({ name: 'Template Co', issue_prefix: 'TMP' }),
	});
	companyId = (await companyRes.json()).data.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Template Project' }),
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
		expect(result).toBe('Working for Template Co.');
	});

	it('resolves {{kb_context}} with no docs', async () => {
		const result = await resolveSystemPrompt(db, 'KB: {{kb_context}}', {
			companyId,
		});
		expect(result).toContain('No knowledge base documents available');
	});

	it('resolves {{company_preferences_context}} with no prefs', async () => {
		const result = await resolveSystemPrompt(db, 'Prefs: {{company_preferences_context}}', {
			companyId,
		});
		expect(result).toContain('No preferences set');
	});

	it('resolves {{project_docs_context}} to filesystem reference', async () => {
		const result = await resolveSystemPrompt(db, 'Docs: {{project_docs_context}}', {
			companyId,
			projectId,
		});
		expect(result).toContain('.dev/ folder');
	});

	it('passes through text without template variables', async () => {
		const result = await resolveSystemPrompt(db, 'Hello world', { companyId });
		expect(result).toBe('Hello world');
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
});
