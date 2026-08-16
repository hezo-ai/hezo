import { fireEvent, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedWorkspace } from './helpers/seed';

function uniqueName(base: string): string {
	return `${base} ${Math.random().toString(36).slice(2, 8)}`;
}

// The hire flow files the onboard ticket in the team's own project (no per-team
// internal project under the 1:1 model). Wait for that task to land via the API,
// then surface it through the team project's task list so the assertion reads it
// from the rendered DOM.
async function findOnboardTask(ws: SeededWorkspace, role: string): Promise<void> {
	const { apiBase, token } = getTestContext();
	const title = `Onboard new agent: ${role}`;
	await waitFor(
		async () => {
			const res = await apiBase(`/api/projects/${ws.internalSlug}/tasks`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			const body = (await res.json()) as {
				data: { tasks?: Array<{ title: string }> } | Array<{ title: string }>;
			};
			const tasks = Array.isArray(body.data) ? body.data : (body.data.tasks ?? []);
			expect(tasks.some((t) => t.title === title)).toBe(true);
		},
		{ timeout: 20_000 },
	);
}

test('can hire an agent with minimal fields', async () => {
	let ws!: SeededWorkspace;
	const { findByLabelText, findByRole, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/hire',
		params: { projectId: ws.internalSlug },
	});

	// The minimum a hire needs is a title and a deliberately chosen heartbeat -
	// the cadence has no prefill, so submit stays gated until it is picked.
	const role = uniqueName('Data Scientist');
	const titleInput = (await findByLabelText('Role title')) as HTMLInputElement;
	await user.type(titleInput, role);
	fireEvent.change(await findByLabelText('Heartbeat'), { target: { value: '720' } });

	const hireBtn = (await findByRole('button', { name: /hire agent/i })) as HTMLButtonElement;
	await waitFor(() => expect(hireBtn.disabled).toBe(false));
	const form = titleInput.closest('form') as HTMLFormElement;
	fireEvent.submit(form);

	await findOnboardTask(ws, role);
	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: ws.internalSlug },
	});
	await findByText(`Onboard new agent: ${role}`, undefined, { timeout: 20_000 });
}, 60_000);

async function seedHireApproval(
	ws: SeededWorkspace,
	payload: Record<string, unknown>,
): Promise<string> {
	const { apiBase, token } = getTestContext();
	const res = await apiBase(`/api/projects/${ws.internalSlug}/approvals`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ type: 'hire', requested_by_member_id: null, payload }),
	});
	return ((await res.json()) as { data: { id: string } }).data.id;
}

test('admin modifies a pending hire proposal then approves it', async () => {
	let ws!: SeededWorkspace;
	let approvalId!: string;
	const { findByLabelText, findByRole, container, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			approvalId = await seedHireApproval(ws, {
				title: 'Analyst',
				slug: 'analyst',
				role_description: 'Reporting',
				// Must carry the required substitution vars or Save/Approve stay disabled.
				system_prompt:
					'You are the Analyst. {{team_name}} {{reports_to}} {{skills_context}} {{project_docs_context}} {{team_preferences_context}}',
				heartbeat_interval_min: 60,
				daily_budget_cents: 0,
				weekly_budget_cents: 0,
				monthly_budget_cents: 2000,
				touches_code: false,
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/hire',
		params: { projectId: ws.internalSlug },
		search: { approvalId },
	});

	// The form pre-fills from the proposal payload.
	const titleInput = (await findByLabelText('Role title')) as HTMLInputElement;
	await waitFor(() => expect(titleInput.value).toBe('Analyst'));

	// Edit the system prompt — this makes the proposal dirty and enables Save.
	const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
	await user.type(textarea, ' Own all reporting.');

	const saveBtn = await findByRole('button', { name: /save changes/i });
	await user.click(saveBtn);

	const { apiBase, token } = getTestContext();
	await waitFor(async () => {
		const res = await apiBase(`/api/projects/${ws.internalSlug}/approvals`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const list = (
			(await res.json()) as { data: Array<{ id: string; payload: { system_prompt: string } }> }
		).data;
		const row = list.find((a) => a.id === approvalId);
		expect(row?.payload.system_prompt).toContain('Own all reporting');
	});

	// Approving materializes the agent on the team roster.
	await user.click(await findByRole('button', { name: /approve hire/i }));
	await waitFor(async () => {
		const res = await apiBase(`/api/projects/${ws.internalSlug}/agents`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const agents = ((await res.json()) as { data: Array<{ slug: string }> }).data;
		expect(agents.some((a) => a.slug === 'analyst')).toBe(true);
	});
}, 60_000);

test('an agent-filed cadence outside the presets survives a round trip through the form', async () => {
	let ws!: SeededWorkspace;
	let approvalId!: string;
	const { findByLabelText, findByRole, container, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			// 90 is not one of the dropdown's presets. The Captain chose it after
			// asking the admin, so the form must show it rather than rendering blank
			// and silently rewriting it on the next save.
			approvalId = await seedHireApproval(ws, {
				title: 'Auditor',
				slug: 'auditor',
				role_description: 'Audits',
				system_prompt:
					'You are the Auditor. {{team_name}} {{reports_to}} {{skills_context}} {{project_docs_context}} {{team_preferences_context}}',
				heartbeat_interval_min: 90,
				daily_budget_cents: 0,
				weekly_budget_cents: 0,
				monthly_budget_cents: 2000,
				touches_code: false,
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/hire',
		params: { projectId: ws.internalSlug },
		search: { approvalId },
	});

	const heartbeat = (await findByLabelText('Heartbeat')) as HTMLSelectElement;
	await waitFor(() => expect(heartbeat.value).toBe('90'));
	expect([...heartbeat.options].map((o) => o.value)).toContain('90');

	// Save an unrelated edit; the untouched cadence must come back as 90.
	const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
	await user.type(textarea, ' Report quarterly.');
	await user.click(await findByRole('button', { name: /save changes/i }));

	const { apiBase, token } = getTestContext();
	await waitFor(async () => {
		const res = await apiBase(`/api/projects/${ws.internalSlug}/approvals`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const list = (
			(await res.json()) as {
				data: Array<{ id: string; payload: { heartbeat_interval_min: number } }>;
			}
		).data;
		expect(list.find((a) => a.id === approvalId)?.payload.heartbeat_interval_min).toBe(90);
	});
}, 60_000);

test('hire form reports-to dropdown defaults to Captain and posts the chosen manager', async () => {
	let ws!: SeededWorkspace;
	const { findByLabelText, findByRole, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/hire',
		params: { projectId: ws.internalSlug },
	});

	const select = (await findByLabelText('Reports to')) as HTMLSelectElement;
	// Options populate once the team roster loads; default selection is the Captain.
	// Asserted against the select's own options rather than by finding the text
	// anywhere on the page: a role name can also appear in a roster list left in
	// `document.body` by an earlier spec, which makes a bare text query ambiguous
	// under a full run while passing in isolation.
	await waitFor(() => expect([...select.options].map((o) => o.value)).toContain('architect'));
	await waitFor(() => expect(select.value).toBe('captain'));

	await user.selectOptions(select, 'architect');
	expect(select.value).toBe('architect');

	const role = uniqueName('Data Scientist');
	await user.type((await findByLabelText('Role title')) as HTMLInputElement, role);
	fireEvent.submit(
		(await findByRole('button', { name: /hire agent/i })).closest('form') as HTMLFormElement,
	);

	// The filed hire proposal carries the chosen manager slug.
	const { apiBase, token } = getTestContext();
	await waitFor(async () => {
		const res = await apiBase(`/api/projects/${ws.internalSlug}/approvals`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const list = (await res.json()) as {
			data: Array<{ payload: { title: string; reports_to: string } }>;
		};
		const row = list.data.find((a) => a.payload.title === role);
		expect(row?.payload.reports_to).toBe('architect');
	});
}, 60_000);

test('template variable chips insert into system prompt', async () => {
	let ws!: SeededWorkspace;
	const { findByRole, container, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/hire',
		params: { projectId: ws.internalSlug },
	});

	// Chips now carry a tooltip description in their accessible name, so match by
	// the token substring rather than an exact name.
	await user.click(await findByRole('button', { name: /\{\{team_name\}\}/ }));
	await user.click(await findByRole('button', { name: /\{\{skills_context\}\}/ }));

	const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
	expect(textarea.value).toContain('{{team_name}}');
	expect(textarea.value).toContain('{{skills_context}}');
});

test('hire form blocks submit until all required vars are present', async () => {
	let ws!: SeededWorkspace;
	const { findByLabelText, findByRole, findByText, container, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/hire',
		params: { projectId: ws.internalSlug },
	});

	const titleInput = (await findByLabelText('Role title')) as HTMLInputElement;
	await user.type(titleInput, 'Gap Role');

	// The heartbeat starts unpicked, so the button is gated on it even though the
	// starter prompt is compliant. Choosing a cadence is what releases it.
	const hireBtn = (await findByRole('button', { name: /hire agent/i })) as HTMLButtonElement;
	expect(hireBtn.disabled).toBe(true);
	const heartbeat = (await findByLabelText('Heartbeat')) as HTMLSelectElement;
	expect(heartbeat.value).toBe('');
	fireEvent.change(heartbeat, { target: { value: '720' } });
	await waitFor(() => expect(hireBtn.disabled).toBe(false));

	// Clear the prompt → all required vars missing → guidance flags them and the
	// button disables.
	const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
	await user.clear(textarea);
	await findByText(/missing required variable/i);
	expect(hireBtn.disabled).toBe(true);

	// Re-add a compliant prompt → button re-enables. Set the value directly:
	// userEvent treats `{`/`}` as special key syntax, so typing the tokens is awkward.
	fireEvent.change(textarea, {
		target: {
			value:
				'Role. {{team_name}} {{reports_to}} {{skills_context}} {{project_docs_context}} {{team_preferences_context}}',
		},
	});
	await waitFor(() => expect(hireBtn.disabled).toBe(false));
});

test('can hire agent with full fields', async () => {
	let ws!: SeededWorkspace;
	const { findByLabelText, findByRole, findByText, container, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/hire',
		params: { projectId: ws.internalSlug },
	});

	const role = uniqueName('Security Auditor');
	const titleInput = (await findByLabelText('Role title')) as HTMLInputElement;
	await user.type(titleInput, role);
	await user.type(
		await findByLabelText('Role description'),
		'Audits code for security vulnerabilities',
	);

	const heartbeatSelect = (await findByLabelText('Heartbeat')) as HTMLSelectElement;
	fireEvent.change(heartbeatSelect, { target: { value: '120' } });

	const budgetInput = (await findByLabelText('Monthly budget')) as HTMLInputElement;
	await user.clear(budgetInput);
	await user.type(budgetInput, '50');

	// The budget editor renders its own enable toggles first, so the touches-code
	// checkbox is the last one in the form.
	const checkboxes = container.querySelectorAll(
		'input[type="checkbox"]',
	) as NodeListOf<HTMLInputElement>;
	const touchesCode = checkboxes[checkboxes.length - 1];
	await user.click(touchesCode);

	const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
	await user.type(textarea, 'You are the Security Auditor.');

	const form = titleInput.closest('form') as HTMLFormElement;
	fireEvent.submit(form);

	await findOnboardTask(ws, role);
	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: ws.internalSlug },
	});
	await findByText(`Onboard new agent: ${role}`, undefined, { timeout: 20_000 });
}, 60_000);
