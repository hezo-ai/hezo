import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedWorkspace } from './helpers/seed';

const COMPLIANT_PROMPT =
	'You are the Analyst. {{team_name}} {{reports_to}} {{skills_context}} {{project_docs_context}} {{team_preferences_context}}';

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

// Branch: ?approvalId set but no matching pending approval → the "no longer
// pending" message (the `if (!approval)` branch in HireAgentPage).
test('shows the resolved-proposal message when the approval id has no match', async () => {
	let ws!: SeededWorkspace;
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/hire',
		params: { projectId: ws.internalSlug },
		search: { approvalId: '00000000-0000-0000-0000-000000000000' },
	});

	await findByText(/no longer pending/i);
});

// Branch: EditHireProposal Deny path resolves the approval as Denied and routes
// back to the agents list (handleDeny → resolveApproval + backToAgents).
test('denying a pending hire proposal resolves it and returns to agents', async () => {
	let ws!: SeededWorkspace;
	let approvalId!: string;
	const { findByLabelText, findByRole, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			approvalId = await seedHireApproval(ws, {
				title: 'Analyst',
				slug: 'analyst',
				role_description: 'Reporting',
				system_prompt: COMPLIANT_PROMPT,
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

	const titleInput = (await findByLabelText('Role title')) as HTMLInputElement;
	await waitFor(() => expect(titleInput.value).toBe('Analyst'));

	await user.click(await findByRole('button', { name: /deny/i }));

	// Navigates back to the agents list.
	await waitFor(() =>
		expect(router.state.location.pathname).toBe(`/projects/${ws.internalSlug}/agents`),
	);
	// The approval was resolved (denied) — it leaves the pending set.
	const { apiBase, token } = getTestContext();
	await waitFor(async () => {
		const res = await apiBase(`/api/projects/${ws.internalSlug}/approvals`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const list = ((await res.json()) as { data: Array<{ id: string }> }).data;
		expect(list.some((a) => a.id === approvalId)).toBe(false);
	});
}, 60_000);

// Branch: in EditHireProposal, Save is disabled when not dirty and re-enables
// after an edit; Approve is gated on a non-empty title.
test('edit-proposal Save is gated on the dirty branch', async () => {
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
				system_prompt: COMPLIANT_PROMPT,
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

	const titleInput = (await findByLabelText('Role title')) as HTMLInputElement;
	await waitFor(() => expect(titleInput.value).toBe('Analyst'));

	// Not dirty yet → Save disabled.
	const save = (await findByRole('button', { name: /save changes/i })) as HTMLButtonElement;
	expect(save.disabled).toBe(true);

	// Edit makes it dirty → Save enables.
	const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
	await user.type(textarea, ' More detail.');
	await waitFor(() => expect(save.disabled).toBe(false));

	// Clearing the title disables Approve (the !values.title.trim() branch).
	const approve = (await findByRole('button', {
		name: /approve hire/i,
	})) as HTMLButtonElement;
	await user.clear(titleInput);
	await waitFor(() => expect(approve.disabled).toBe(true));
}, 60_000);

// Branch: EditHireProposal with a payload missing optional fields exercises the
// valuesFromPayload `?? ''`/`?? 0` fallbacks; an empty system_prompt flags the
// prompt-invalid guard so Save/Approve stay disabled.
test('a sparse proposal payload falls back to defaults and flags the missing prompt', async () => {
	let ws!: SeededWorkspace;
	let approvalId!: string;
	const { findByLabelText, findByRole, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			// Minimal payload: no role_description, no system_prompt, no budgets.
			approvalId = await seedHireApproval(ws, { title: 'Sparse', slug: 'sparse' });
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/hire',
		params: { projectId: ws.internalSlug },
		search: { approvalId },
	});

	const titleInput = (await findByLabelText('Role title')) as HTMLInputElement;
	await waitFor(() => expect(titleInput.value).toBe('Sparse'));

	// Empty system prompt → missingRequiredVars flags it and Approve is disabled.
	await findByText(/missing required variable/i);
	const approve = (await findByRole('button', {
		name: /approve hire/i,
	})) as HTMLButtonElement;
	expect(approve.disabled).toBe(true);
}, 60_000);
