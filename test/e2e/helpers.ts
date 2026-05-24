import { expect, type Locator, type Page, type Response } from '@playwright/test';

const TEST_MASTER_KEY = 'e2e-test-master-key-0123456789abcdef0123456789abcdef';

// Bun's webserver starts listening before Hono routes are mounted, so the very
// first request during cold start can hit the default 404 ("404 Not Found"
// plain text) and crash res.json(). Retry until we get a real JSON body.
async function requestToken(page: Page): Promise<string> {
	const deadline = Date.now() + 30_000;
	let lastError: unknown = null;
	while (Date.now() < deadline) {
		try {
			const res = await page.request.post('/api/auth/token', {
				data: { master_key: TEST_MASTER_KEY },
			});
			if (res.ok()) {
				const json = (await res.json()) as { data?: { token: string }; token?: string };
				const token = json.data?.token ?? json.token;
				if (token) return token;
			}
			lastError = new Error(`Unexpected ${res.status()} from /api/auth/token`);
		} catch (err) {
			lastError = err;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw lastError ?? new Error('Timed out waiting for /api/auth/token');
}

export async function authenticate(page: Page) {
	const token = await requestToken(page);

	await page.addInitScript((t: string) => {
		localStorage.setItem('hezo_token', t);
	}, token);

	// Ensure at least one AI provider is configured so the instance-level gate
	// never blocks tests that don't specifically exercise it.
	await ensureAiProviderConfigured(page, token);

	await page.reload();
}

export async function getToken(page: Page): Promise<string> {
	return requestToken(page);
}

/** Ensure at least one instance-level AI provider is configured. Idempotent. */
export async function ensureAiProviderConfigured(page: Page, token: string) {
	const headers = { Authorization: `Bearer ${token}` };
	const statusRes = await page.request.get('/api/ai-providers/status', { headers });
	const { data } = await statusRes.json();
	if (data.configured) return;

	await page.request.post('/api/ai-providers', {
		headers: { ...headers, 'Content-Type': 'application/json' },
		data: {
			provider: 'anthropic',
			api_key: 'sk-ant-e2e-test-key',
			label: 'e2e-default',
		},
	});
}

/** Remove every instance-level AI provider config. Used by tests that exercise the gate. */
export async function clearAiProviders(page: Page, token: string) {
	const headers = { Authorization: `Bearer ${token}` };
	const listRes = await page.request.get('/api/ai-providers', { headers });
	const { data } = await listRes.json();
	for (const config of data as Array<{ id: string }>) {
		await page.request.delete(`/api/ai-providers/${config.id}`, { headers });
	}
}

/**
 * Create a project and mark its auto-generated planning task as done.
 * Tests that kick off agent runs on the Captain would otherwise race the
 * Captain's planning wakeup and see runs targeted at the planning task.
 */
export async function createProjectAndClearPlanning(
	page: Page,
	teamId: string,
	token: string,
	data: { name: string; description?: string },
) {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const res = await page.request.post(`/api/teams/${teamId}/projects`, {
		headers,
		data,
	});
	const project = (
		(await res.json()) as {
			data: { id: string; slug: string; planning_task_id: string };
		}
	).data;
	await page.request.patch(`/api/teams/${teamId}/tasks/${project.planning_task_id}`, {
		headers,
		data: { status: 'done' },
	});
	return project;
}

/** Poll until the project container is provisioned (required before agent wakeups run). */
export async function waitForProjectContainer(
	page: Page,
	teamId: string,
	projectId: string,
	token: string,
	timeoutMs = 90_000,
): Promise<void> {
	const headers = { Authorization: `Bearer ${token}` };
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await page.request.get(`/api/teams/${teamId}/projects/${projectId}`, { headers });
		const body = (await res.json()) as {
			data: { container_status?: string; container_id?: string | null };
		};
		if (body.data?.container_status === 'running' && body.data?.container_id) return;
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`Project container did not reach running state within ${timeoutMs}ms`);
}

/**
 * Create a project, close its planning task, and wait for the dev container — ready for agent runs.
 */
export async function createProjectReadyForAgents(
	page: Page,
	team: { id: string; slug: string },
	token: string,
	data: { name: string; description?: string },
) {
	const project = await createProjectAndClearPlanning(page, team.id, token, data);
	await waitForProjectContainer(page, team.id, project.id, token);
	await waitForCaptainIdle(page, team.id, token);
	return project;
}

/** Pin home/rail onboarding to a specific team (avoids stale sessionStorage from other tests). */
export async function setActiveTeamSlug(page: Page, teamSlug: string) {
	await page.evaluate((slug) => {
		sessionStorage.setItem('hezo:activeTeamSlug', slug);
	}, teamSlug);
}

/**
 * Close the single onboarding-intake ticket if one is open. Safe to call when no
 * intake exists (returns silently). In the new flow the ticket is only opened
 * on demand from the wizard chat path, so most tests never need this.
 */
export async function closeOnboardingIntakeIfOpen(
	page: Page,
	teamSlug: string,
	token: string,
): Promise<void> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const res = await page.request.get(`/api/teams/${teamSlug}/onboarding-intake`, { headers });
	if (!res.ok()) return;
	const { task_id } = ((await res.json()) as { data: { task_id: string } }).data;
	if (!task_id) return;
	await page.request.patch(`/api/teams/${teamSlug}/tasks/${task_id}`, {
		headers,
		data: { status: 'done' },
	});
}

/** Wait until a specific agent is idle (no active heartbeat run). */
export async function waitForAgentIdle(
	page: Page,
	teamId: string,
	agentId: string,
	token: string,
	timeoutMs = 180_000,
): Promise<void> {
	const headers = { Authorization: `Bearer ${token}` };
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await page.request.get(`/api/teams/${teamId}/agents/${agentId}`, { headers });
		const agent = ((await res.json()) as { data: { runtime_status: string } }).data;
		if (agent?.runtime_status === 'idle') return;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`Agent ${agentId} did not return to idle within ${timeoutMs}ms`);
}

/** Wait until Captain is idle (e.g. after onboarding intake wakeups finish). */
export async function waitForCaptainIdle(
	page: Page,
	teamId: string,
	token: string,
	timeoutMs = 180_000,
): Promise<void> {
	const headers = { Authorization: `Bearer ${token}` };
	const res = await page.request.get(`/api/teams/${teamId}/agents`, { headers });
	const agents = ((await res.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const captain = agents.find((a) => a.slug === 'captain');
	if (!captain) throw new Error('Captain agent not found');
	await waitForAgentIdle(page, teamId, captain.id, token, timeoutMs);
}

export async function createTeamWithAgents(page: Page) {
	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	await ensureAiProviderConfigured(page, token);

	const typesRes = await page.request.get('/api/team-templates', { headers });
	const types = await typesRes.json();
	const typeId = (types as any).data.find((t: any) => t.name === 'Startup')?.id;

	const uid = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
	const teamRes = await page.request.post('/api/teams', {
		headers,
		data: {
			name: `Test Co ${uid}`,
			template_id: typeId,
		},
	});
	const team = ((await teamRes.json()) as any).data;

	// Template apply queues team_context regeneration + a coherence review for Captain;
	// wait for Captain to drain those before tests start their own work.
	await waitForCaptainIdle(page, team.id, token);

	return { team, token };
}

/**
 * Bare team without seeded agents or AI provider. Use for UI-only tests
 * that don't exercise agent or AI-provider behaviour — skips ~11-agent seeding.
 */
export async function createTeamLight(page: Page) {
	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	await ensureAiProviderConfigured(page, token);

	const uid = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
	const teamRes = await page.request.post('/api/teams', {
		headers,
		data: { name: `Test Co Light ${uid}` },
	});
	const team = ((await teamRes.json()) as any).data;

	return { team, token };
}

/** Drive the wizard's AI-provider step by entering a test API key. */
export async function dismissAiProviderModal(page: Page) {
	const aiStep = page.getByTestId('setup-step-ai-provider');
	try {
		await aiStep.waitFor({ state: 'visible', timeout: 15000 });
	} catch {
		return;
	}

	await page.getByRole('button', { name: 'Enter API key' }).first().click();
	await page.locator('input[type="password"]').first().fill('sk-ant-e2e-test-key');
	await page.getByRole('button', { name: 'Save' }).first().click();

	await expect(aiStep).toBeHidden({ timeout: 20000 });
}

export async function waitForPageLoad(page: Page, timeout = 15000) {
	await expect(page.getByText('Loading...')).toBeHidden({ timeout });
	// Also drain any explicit `data-testid$="-loading"` placeholders so callers
	// can rely on this helper for "the page's initial queries have resolved",
	// not just "the literal Loading... text is gone".
	await expect(page.locator('[data-testid$="-loading"]')).toHaveCount(0, { timeout });
}

// ===========================================================================
// Deterministic network-driven helpers
// ===========================================================================
//
// Two race classes have been the source of every recurring CI flake on this
// suite:
//
//   A. navigate → assert-on-data: `goto + waitForPageLoad + expect(testid)`
//      passes locally but races React Query's initial fetch under CI load.
//   B. save → assert-on-UI-refresh: a click fires a mutation PATCH; the UI
//      doesn't update until the follow-up refetch GET (via React Query's
//      `invalidateQueries` in onSuccess) lands and the component re-renders.
//      Waiting only for the mutation is not enough.
//
// The helpers below close those races by waiting for *specific* API responses
// (scoped to the test's own team/task IDs so background wakeups can't satisfy
// the matcher). Prefer them over bare `goto`/`click` + visibility assertions.

export type ResponseMatcher = (url: URL, method: string) => boolean;

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matcher for `/api/teams/<teamId>/tasks[/<taskId>[/<subResource>]]` requests.
 * Always scope the matcher to the test's own team (and task when known) so a
 * background wakeup PATCH on the planning task cannot satisfy the matcher.
 */
export function taskMatcher(opts: {
	teamId: string;
	taskId?: string;
	subResource?: string;
	method?: 'GET' | 'PATCH' | 'POST' | 'DELETE' | 'PUT';
}): ResponseMatcher {
	const teamSeg = escapeRegex(opts.teamId);
	const taskSeg = opts.taskId ? escapeRegex(opts.taskId) : '[^/]+';
	let pattern: RegExp;
	if (opts.subResource) {
		const sub = escapeRegex(opts.subResource);
		pattern = new RegExp(`^/api/teams/${teamSeg}/tasks/${taskSeg}/${sub}(?:/[^/]+)*$`);
	} else if (opts.taskId) {
		pattern = new RegExp(`^/api/teams/${teamSeg}/tasks/${taskSeg}$`);
	} else {
		pattern = new RegExp(`^/api/teams/${teamSeg}/tasks(?:\\?.*)?$`);
	}
	return (url, m) => (!opts.method || m === opts.method) && pattern.test(url.pathname);
}

/**
 * Matcher for `/api/teams/<teamId>[/<resource>[/...]]` requests.
 * Use for non-task resources (projects, agents, comments, etc.).
 */
export function teamMatcher(opts: {
	teamId: string;
	resource?: string;
	method?: 'GET' | 'PATCH' | 'POST' | 'DELETE' | 'PUT';
}): ResponseMatcher {
	const teamSeg = escapeRegex(opts.teamId);
	const pattern = opts.resource
		? new RegExp(`^/api/teams/${teamSeg}/${escapeRegex(opts.resource)}(?:/.*)?$`)
		: new RegExp(`^/api/teams/${teamSeg}(?:/.*)?$`);
	return (url, m) => (!opts.method || m === opts.method) && pattern.test(url.pathname);
}

/** Matcher for any GET to `/api/teams` (the global teams list). */
export function teamsListMatcher(): ResponseMatcher {
	return (url, m) => m === 'GET' && url.pathname === '/api/teams';
}

/** Matcher for `/api/teams/<teamId>/agents[/<agentId>]` requests. */
export function agentMatcher(opts: {
	teamId: string;
	agentId?: string;
	method?: 'GET' | 'PATCH' | 'POST' | 'DELETE' | 'PUT';
}): ResponseMatcher {
	const teamSeg = escapeRegex(opts.teamId);
	const pattern = opts.agentId
		? new RegExp(`^/api/teams/${teamSeg}/agents/${escapeRegex(opts.agentId)}$`)
		: new RegExp(`^/api/teams/${teamSeg}/agents(?:\\?.*)?$`);
	return (url, m) => (!opts.method || m === opts.method) && pattern.test(url.pathname);
}

/**
 * Navigate to `url` and wait for the listed API responses to land successfully
 * before returning. Replaces the `goto + waitForPageLoad + expect(testid)`
 * pattern that races React Query's initial fetch under CI load.
 *
 * Response waiters are registered BEFORE `goto` so they catch the queries
 * fired during initial render, not just any later activity. Matchers should be
 * scoped to the test's own IDs to avoid matching background traffic.
 */
export async function gotoAndWaitForData(
	page: Page,
	url: string,
	options: {
		waitFor: ResponseMatcher[];
		timeout?: number;
	},
): Promise<void> {
	const timeout = options.timeout ?? 30_000;
	const responsePromises = options.waitFor.map((match) =>
		page.waitForResponse(
			(r) => {
				try {
					return match(new URL(r.url()), r.request().method()) && r.ok();
				} catch {
					return false;
				}
			},
			{ timeout },
		),
	);
	await Promise.all([page.goto(url), ...responsePromises]);
	await waitForPageLoad(page, timeout);
}

/**
 * Click `locator` (a Save / Confirm / toggle button) and wait for both:
 *   1. the mutation response (PATCH/POST/DELETE/PUT) — required
 *   2. the follow-up refetch GET that React Query's onSuccess invalidation
 *      triggers — optional but strongly recommended
 *
 * Returns only when the UI is guaranteed to have refreshed with the new data.
 * Both matchers are registered before the click so the refetch waiter cannot
 * be raced by a background GET that lands between the mutation response and
 * the refetch.
 */
export async function saveAndWaitForRefetch(
	page: Page,
	locator: Locator,
	options: {
		mutation: ResponseMatcher;
		refetch?: ResponseMatcher;
		timeout?: number;
	},
): Promise<{ mutation: Response; refetch?: Response }> {
	const timeout = options.timeout ?? 30_000;

	const mutationPromise = page.waitForResponse(
		(r) => {
			try {
				return options.mutation(new URL(r.url()), r.request().method()) && r.ok();
			} catch {
				return false;
			}
		},
		{ timeout },
	);

	const refetchMatcher = options.refetch;
	const refetchPromise = refetchMatcher
		? page.waitForResponse(
				(r) => {
					try {
						return refetchMatcher(new URL(r.url()), r.request().method()) && r.ok();
					} catch {
						return false;
					}
				},
				{ timeout },
			)
		: undefined;

	await locator.click();
	const mutation = await mutationPromise;
	const refetch = refetchPromise ? await refetchPromise : undefined;
	return { mutation, refetch };
}

/**
 * @deprecated Prefer `saveAndWaitForRefetch` so the assertion runs after the
 * UI has refreshed, not just after the mutation has returned. Kept as a thin
 * wrapper so existing call sites continue to compile during the migration.
 */
export async function clickAndWaitForResponse(
	page: Page,
	locator: Locator,
	match: (url: URL, method: string) => boolean,
	options: { timeout?: number } = {},
): Promise<Response> {
	const { mutation } = await saveAndWaitForRefetch(page, locator, {
		mutation: match,
		timeout: options.timeout,
	});
	return mutation;
}

/**
 * Delete every reaction on a comment, regardless of kind. Used in spec setup
 * to guarantee a clean slate across Playwright retries — without this, a
 * partially-applied reaction from a previous attempt can survive into the
 * next run because the server-side comment row is reused.
 */
export async function clearReactionsForComment(
	page: Page,
	opts: { teamId: string; taskId: string; commentId: string; token: string },
): Promise<void> {
	const headers = { Authorization: `Bearer ${opts.token}` };
	const res = await page.request.get(`/api/teams/${opts.teamId}/tasks/${opts.taskId}/comments`, {
		headers,
	});
	if (!res.ok()) return;
	const body = (await res.json()) as {
		data: Array<{ id: string; reactions?: Array<{ kind: string }> }>;
	};
	const comment = body.data.find((c) => c.id === opts.commentId);
	const kinds = new Set((comment?.reactions ?? []).map((r) => r.kind));
	for (const kind of kinds) {
		await page.request.delete(
			`/api/teams/${opts.teamId}/tasks/${opts.taskId}/comments/${opts.commentId}/reactions/${kind}`,
			{ headers },
		);
	}
}

export { TEST_MASTER_KEY };
