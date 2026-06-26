import { waitFor } from '@testing-library/react';
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
	input: { name: string; kind: string; allowedHosts: string[]; allowBodySubstitution?: boolean },
): Promise<void> {
	const { db } = getTestContext();
	const content = {
		name: input.name,
		kind: input.kind,
		instructions: `Need a token to deploy.`,
		input_type: 'text',
		confirmation_text: null,
		allowed_hosts: input.allowedHosts,
		allow_body_substitution: input.allowBodySubstitution ?? false,
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

test('human can set allowed_hosts when fulfilling an unscoped request', async () => {
	const { findByTestId, user } = await renderTaskWithCredentialRequest([]);
	await findByTestId('credential-request', undefined, { timeout: 15_000 });

	await user.type(await findByTestId('credential-input'), 'tok-123');
	// The field prefills with an inferred suggestion (NETLIFY_* → api.netlify.com);
	// clear it before typing the exact allowlist this test asserts on.
	const hostsField = await findByTestId('credential-hosts-input');
	await user.clear(hostsField);
	await user.type(hostsField, 'api.netlify.com, *.netlify.com');
	await user.click(await findByTestId('credential-submit'));

	// Fulfillment swaps the form for the confirmation block.
	await findByTestId('credential-fulfilled', undefined, { timeout: 15_000 });

	const { db } = getTestContext();
	const secret = await db.query<{ allowed_hosts: string[] }>(
		"SELECT allowed_hosts FROM secrets WHERE name = 'NETLIFY_AUTH_TOKEN'",
	);
	expect(secret.rows[0]?.allowed_hosts).toEqual(['api.netlify.com', '*.netlify.com']);
});

test('body-substitution checkbox is pre-checked from the request and can be declined', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Cred Body Project' });
			const task = await seedTask(ws, project, { title: 'Login Task' });
			await seedCredentialRequest(ws, task, {
				name: 'UMAMI_LOGIN_PW',
				kind: 'other',
				allowedHosts: ['umami.example'],
				allowBodySubstitution: true,
			});
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});
	await helpers.router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const checkbox = (await helpers.findByTestId('credential-body-substitution', undefined, {
		timeout: 15_000,
	})) as HTMLInputElement;
	expect(checkbox.checked).toBe(true);

	// Decline body substitution, then provide the value.
	await helpers.user.click(checkbox);
	expect(checkbox.checked).toBe(false);
	await helpers.user.type(await helpers.findByTestId('credential-input'), 'pw-123');
	await helpers.user.click(await helpers.findByTestId('credential-submit'));
	await helpers.findByTestId('credential-fulfilled', undefined, { timeout: 15_000 });

	const { db } = getTestContext();
	const secret = await db.query<{ allow_body_substitution: boolean }>(
		"SELECT allow_body_substitution FROM secrets WHERE name = 'UMAMI_LOGIN_PW'",
	);
	expect(secret.rows[0]?.allow_body_substitution).toBe(false);
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

// --- Additional branches: kind badge / instructions, input types, confirmation,
// --- already-fulfilled, and the inline server-validation error path. ---

interface CredentialContent {
	name: string;
	kind: string;
	instructions?: string;
	input_type?: string;
	confirmation_text?: string | null;
	allowed_hosts?: string[];
	placeholder?: string;
}

/** Insert a credential_request comment with full control over content + fulfillment. */
async function seedCredentialRequestFull(
	ws: SeededWorkspace,
	task: SeededTask,
	content: CredentialContent,
	opts?: { fulfilledSecretId?: string },
): Promise<void> {
	const { db } = getTestContext();
	const chosen = opts?.fulfilledSecretId
		? JSON.stringify({ secret_id: opts.fulfilledSecretId, fulfilled_at: new Date().toISOString() })
		: null;
	await db.query(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content, chosen_option)
		 VALUES ($1, $2, 'credential_request'::comment_content_type, $3::jsonb, $4::jsonb)`,
		[task.id, ws.agents[0].id, JSON.stringify(content), chosen],
	);
}

async function renderTaskWithCredentialContent(
	content: CredentialContent,
	opts?: { fulfilledSecretName?: string },
) {
	const seeded = { projectSlug: '', taskId: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Cred Branch Project' });
			const task = await seedTask(ws, project, { title: 'Cred Branch Task' });
			let fulfilledSecretId: string | undefined;
			if (opts?.fulfilledSecretName) {
				const { db } = getTestContext();
				const r = await db.query<{ id: string }>(
					`INSERT INTO secrets (name, encrypted_value, category)
					 VALUES ($1, 'enc', 'credential'::secret_category) RETURNING id`,
					[opts.fulfilledSecretName],
				);
				fulfilledSecretId = r.rows[0].id;
			}
			await seedCredentialRequestFull(ws, task, content, { fulfilledSecretId });
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

test('renders the kind badge and markdown instructions', async () => {
	const { findByTestId } = await renderTaskWithCredentialContent({
		name: 'DEPLOY_KEY',
		kind: 'api_key',
		instructions: '## How to get it\n\nOpen the dashboard.',
		input_type: 'text',
		allowed_hosts: ['api.example.com'],
	});

	const card = await findByTestId('credential-request', undefined, { timeout: 15_000 });
	expect(card.textContent).toContain('DEPLOY_KEY');
	expect(card.textContent).toContain('api_key');
	expect(card.querySelector('h2')?.textContent).toBe('How to get it');
});

test('submit is disabled until a value is typed, then stores and shows the fulfilled state', async () => {
	const { findByTestId, user } = await renderTaskWithCredentialContent({
		name: 'OPENAI_TOKEN',
		kind: 'other',
		input_type: 'text',
		allowed_hosts: ['api.openai.com'],
	});

	const submit = (await findByTestId('credential-submit', undefined, {
		timeout: 15_000,
	})) as HTMLButtonElement;
	expect(submit.disabled).toBe(true);

	await user.type(await findByTestId('credential-input'), 'super-secret-value');
	expect(submit.disabled).toBe(false);

	await user.click(submit);

	const fulfilled = await findByTestId('credential-fulfilled', undefined, { timeout: 15_000 });
	expect(fulfilled.textContent).toContain('OPENAI_TOKEN provided');
	expect(fulfilled.textContent).toContain('__HEZO_SECRET_OPENAI_TOKEN__');
});

test('an invalid github_pat value triggers the rejected-submission error branch inline', async () => {
	const { findByTestId, findByText, queryByTestId, user } = await renderTaskWithCredentialContent({
		name: 'GH_PAT',
		kind: 'github_pat',
		input_type: 'text',
		allowed_hosts: ['api.github.com'],
	});

	await user.type(
		await findByTestId('credential-input', undefined, { timeout: 15_000 }),
		'not-a-real-pat',
	);
	await user.click(await findByTestId('credential-submit'));

	// The route rejects a value that doesn't look like a GitHub PAT (400). The
	// renderer's onError surfaces the inline error and the card stays un-fulfilled
	// (the api client throws a plain ApiError, so the renderer shows its fallback
	// "Failed to submit" copy — the load-bearing thing is the error branch + that
	// no fulfilled state is shown).
	await findByText('Failed to submit');
	expect(queryByTestId('credential-fulfilled')).toBeNull();
	expect((await findByTestId('credential-request')).getAttribute('data-credential-name')).toBe(
		'GH_PAT',
	);
});

test('confirmation-style request renders a Confirm button (no value input) and confirms', async () => {
	const { findByTestId, findByText, queryByTestId, user } = await renderTaskWithCredentialContent({
		name: 'ACK_DEPLOY',
		kind: 'other',
		confirmation_text: 'Do you approve the production deploy?',
	});

	await findByText('Do you approve the production deploy?', undefined, { timeout: 15_000 });
	// No value input and no host warning in the confirmation flow.
	expect(queryByTestId('credential-input')).toBeNull();
	expect(queryByTestId('credential-no-hosts-warning')).toBeNull();

	const confirm = (await findByTestId('credential-confirm')) as HTMLButtonElement;
	expect(confirm.disabled).toBe(false);
	await user.click(confirm);

	const fulfilled = await findByTestId('credential-fulfilled', undefined, { timeout: 15_000 });
	expect(fulfilled.textContent).toContain('ACK_DEPLOY provided');
});

test('an already-fulfilled request renders the fulfilled state directly', async () => {
	const { findByTestId } = await renderTaskWithCredentialContent(
		{
			name: 'PREFILLED_TOKEN',
			kind: 'api_key',
			placeholder: '__HEZO_SECRET_PREFILLED_TOKEN__',
		},
		{ fulfilledSecretName: 'PREFILLED_TOKEN' },
	);

	const fulfilled = await findByTestId('credential-fulfilled', undefined, { timeout: 15_000 });
	expect(fulfilled.textContent).toContain('PREFILLED_TOKEN provided');
	expect(fulfilled.textContent).toContain('__HEZO_SECRET_PREFILLED_TOKEN__');
});

test('prefills allowed_hosts from a known service in the name when the agent left it unscoped', async () => {
	const { findByTestId } = await renderTaskWithCredentialContent({
		name: 'NETLIFY_AUTH_TOKEN',
		kind: 'other',
		input_type: 'text',
		instructions: 'Create a personal access token from the dashboard.',
		// no allowed_hosts — the agent did not scope the request
	});

	const hosts = (await findByTestId('credential-hosts-input', undefined, {
		timeout: 15_000,
	})) as HTMLInputElement;
	await waitFor(() => expect(hosts.value).toBe('api.netlify.com'));
	// The suggestion hint is shown until the human edits the field.
	await findByTestId('credential-hosts-suggested');
});

test('prefills allowed_hosts from a URL named in the instructions (self-hosted service)', async () => {
	const { findByTestId } = await renderTaskWithCredentialContent({
		name: 'UMAMI_INSTANCE_URL',
		kind: 'other',
		input_type: 'text',
		instructions: 'Use the self-hosted instance at https://umami.hezo.ai or similar.',
	});

	const hosts = (await findByTestId('credential-hosts-input', undefined, {
		timeout: 15_000,
	})) as HTMLInputElement;
	await waitFor(() => expect(hosts.value).toBe('umami.hezo.ai'));
});

test('editing the prefilled hosts clears the suggestion hint', async () => {
	const { findByTestId, queryByTestId, user } = await renderTaskWithCredentialContent({
		name: 'STRIPE_SECRET_KEY',
		kind: 'other',
		input_type: 'text',
	});

	const hosts = (await findByTestId('credential-hosts-input', undefined, {
		timeout: 15_000,
	})) as HTMLInputElement;
	await waitFor(() => expect(hosts.value).toBe('api.stripe.com'));
	await findByTestId('credential-hosts-suggested');

	await user.type(hosts, ', api.override.com');
	expect(queryByTestId('credential-hosts-suggested')).toBeNull();
});

test('does not prefill or hint when the credential name is generic and no URL is given', async () => {
	const { findByTestId, queryByTestId } = await renderTaskWithCredentialContent({
		name: 'GENERIC_SECRET',
		kind: 'other',
		input_type: 'text',
		instructions: 'Paste the value here.',
	});

	const hosts = (await findByTestId('credential-hosts-input', undefined, {
		timeout: 15_000,
	})) as HTMLInputElement;
	expect(hosts.value).toBe('');
	expect(queryByTestId('credential-hosts-suggested')).toBeNull();
});

test('textarea input_type renders a multi-line value field; host override seeds from the request', async () => {
	const { findByTestId, user } = await renderTaskWithCredentialContent({
		name: 'PRIVATE_BLOB',
		kind: 'other',
		input_type: 'textarea',
		allowed_hosts: ['api.example.com'],
	});

	const input = await findByTestId('credential-input', undefined, { timeout: 15_000 });
	expect(input.tagName).toBe('TEXTAREA');

	const hosts = (await findByTestId('credential-hosts-input')) as HTMLInputElement;
	await waitFor(() => expect(hosts.value).toBe('api.example.com'));
	await user.clear(hosts);
	await user.type(hosts, 'api.override.com');
	expect(hosts.value).toBe('api.override.com');
});
