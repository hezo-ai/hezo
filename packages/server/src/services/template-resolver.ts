import type { PGlite } from '@electric-sql/pglite';

interface ResolveContext {
	companyId: string;
	projectId?: string;
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

	if (resolved.includes('{{company_name}}')) {
		const result = await db.query<{ name: string }>('SELECT name FROM companies WHERE id = $1', [
			ctx.companyId,
		]);
		resolved = resolved.replace(/\{\{company_name\}\}/g, result.rows[0]?.name ?? '');
	}

	if (resolved.includes('{{company_description}}')) {
		const result = await db.query<{ description: string }>(
			'SELECT description FROM companies WHERE id = $1',
			[ctx.companyId],
		);
		resolved = resolved.replace(/\{\{company_description\}\}/g, result.rows[0]?.description ?? '');
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

	// Project docs live in the git repo (.dev/ folder), not in the DB.
	// The agent accesses them from the filesystem inside the container.
	resolved = resolved.replace(
		/\{\{project_docs_context\}\}/g,
		'Project docs are in the .dev/ folder of the designated repo.',
	);

	return resolved;
}
