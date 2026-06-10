import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	type SeededTask,
	type SeededWorkspace,
	seedProject,
	seedTask,
	seedWorkspace,
} from './helpers/seed';

// credential_request comments are created by the request_credential MCP tool, not
// the comments API, so seed them with a direct insert (same approach seedComment
// uses for agent-authored comments).
async function seedCredentialRequest(
	ws: SeededWorkspace,
	task: SeededTask,
	input: { name: string; kind: string; allowedHosts: string[] },
): Promise<void> {
	const { db } = getTestContext();
	const content = {
		name: input.name,
		kind: input.kind,
		instructions: `Need a token to deploy.`,
		input_type: 'text',
		confirmation_text: null,
		allowed_hosts: input.allowedHosts,
		scope: 'team',
		project_id: null,
		placeholder: `__HEZO_SECRET_${input.name}__`,
	};
	await db.query(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'credential_request'::comment_content_type, $3::jsonb)`,
		[task.id, ws.agents[0].id, JSON.stringify(content)],
	);
}

async function renderTaskWithCredentialRequest(allowedHosts: string[]) {
	const seeded = { projectSlug: '', taskId: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Cred UI Project' });
			const task = await seedTask(ws, project, { title: 'Deploy Task' });
			await seedCredentialRequest(ws, task, {
				name: 'NETLIFY_AUTH_TOKEN',
				kind: 'api_key',
				allowedHosts,
			});
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});
	await helpers.router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});
	return helpers;
}

test('credential request without allowed_hosts shows a not-scoped warning', async () => {
	const { findByTestId } = await renderTaskWithCredentialRequest([]);
	await findByTestId('credential-request', undefined, { timeout: 15_000 });
	const warning = await findByTestId('credential-no-hosts-warning');
	expect(warning.textContent).toContain('Not scoped to any host');
});

test('credential request with allowed_hosts shows the scoped-hosts line', async () => {
	const { findByTestId, findByText, queryByTestId } = await renderTaskWithCredentialRequest([
		'api.netlify.com',
	]);
	await findByTestId('credential-request', undefined, { timeout: 15_000 });
	await findByText(/Substituted only into requests to/);
	await findByText(/api\.netlify\.com/);
	// The not-scoped warning must NOT appear when the request is host-scoped.
	expect(queryByTestId('credential-no-hosts-warning')).toBeNull();
});
