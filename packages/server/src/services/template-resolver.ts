import type { PGlite } from '@electric-sql/pglite';

interface ResolveContext {
	companyId: string;
	projectId?: string;
	agentId?: string;
}

export async function resolveSystemPrompt(
	db: PGlite,
	template: string,
	ctx: ResolveContext,
): Promise<string> {
	let resolved = template;

	if (resolved.includes('{{current_date}}')) {
		resolved = resolved.replace(/\{\{current_date\}\}/g, new Date().toISOString().slice(0, 10));
	}

	const needsCompany =
		resolved.includes('{{company_name}}') ||
		resolved.includes('{{company_description}}') ||
		resolved.includes('{{company_mission}}');

	if (needsCompany) {
		const result = await db.query<{ name: string; description: string }>(
			'SELECT name, description FROM companies WHERE id = $1',
			[ctx.companyId],
		);
		const row = result.rows[0];
		resolved = resolved.replace(/\{\{company_name\}\}/g, row?.name ?? '');
		resolved = resolved.replace(/\{\{company_description\}\}/g, row?.description ?? '');
		resolved = resolved.replace(/\{\{company_mission\}\}/g, row?.description ?? '');
	}

	if (resolved.includes('{{reports_to}}')) {
		let managerName = '';
		if (ctx.agentId) {
			const result = await db.query<{ display_name: string }>(
				`SELECT m.display_name FROM member_agents ma
				 JOIN members m ON m.id = ma.reports_to
				 WHERE ma.id = $1`,
				[ctx.agentId],
			);
			managerName = result.rows[0]?.display_name ?? '';
		}
		resolved = resolved.replace(/\{\{reports_to\}\}/g, managerName);
	}

	if (resolved.includes('{{kb_context}}')) {
		const docs = await db.query<{ title: string; content: string }>(
			'SELECT title, content FROM kb_docs WHERE company_id = $1 ORDER BY title',
			[ctx.companyId],
		);
		const kbText =
			docs.rows.length > 0
				? docs.rows.map((d) => `## ${d.title}\n${d.content}`).join('\n\n---\n\n')
				: 'No knowledge base documents available.';
		resolved = resolved.replace(/\{\{kb_context\}\}/g, kbText);
	}

	if (resolved.includes('{{company_preferences_context}}')) {
		const prefs = await db.query<{ content: string }>(
			'SELECT content FROM company_preferences WHERE company_id = $1',
			[ctx.companyId],
		);
		const prefsText =
			prefs.rows.length > 0 && prefs.rows[0].content
				? prefs.rows[0].content
				: 'No preferences set.';
		resolved = resolved.replace(/\{\{company_preferences_context\}\}/g, prefsText);
	}

	resolved = resolved.replace(
		/\{\{project_docs_context\}\}/g,
		'Project docs are in the .dev/ folder of the designated repo.',
	);

	resolved = resolved.replace(/\{\{requester_context\}\}/g, '');

	return resolved;
}
