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
 * Drive a project through the captain intake flow end-to-end:
 *   1. POST /projects to open the intake (creates pending approval + intake task).
 *   2. Resolve the approval as approved so the side-effect creates the project + planning task.
 *   3. Mark the auto-created planning task as done so it doesn't race agent runs.
 *
 * Tests that kick off agent runs on the Captain would otherwise race the
 * Captain's planning wakeup and see runs targeted at the planning task.
 */
export async function createProjectAndClearPlanning(
	page: Page,
	teamId: string,
	token: string,
	data: { name: string; description?: string; initial_prd?: string; task_prefix?: string },
) {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const intakeRes = await page.request.post(`/api/teams/${teamId}/projects`, {
		headers,
		data: { description: 'Created via e2e helper.', ...data },
	});
	const intake = (
		(await intakeRes.json()) as {
			data: { approval_id: string };
		}
	).data;

	await page.request.post(`/api/approvals/${intake.approval_id}/resolve`, {
		headers,
		data: { status: 'approved' },
	});

	const projectsRes = await page.request.get(`/api/teams/${teamId}/projects`, { headers });
	const allProjects = (
		(await projectsRes.json()) as {
			data: Array<{ id: string; slug: string; name: string }>;
		}
	).data;
	const project = allProjects.find((p) => p.name === data.name);
	if (!project) {
		throw new Error(
			`createProjectAndClearPlanning: project '${data.name}' not found after approval`,
		);
	}

	const tasksRes = await page.request.get(`/api/teams/${teamId}/tasks?project_id=${project.id}`, {
		headers,
	});
	const tasks = ((await tasksRes.json()) as { data: Array<{ id: string; labels: string[] }> }).data;
	const planningTask = tasks.find((t) => (t.labels ?? []).includes('planning'));
	if (!planningTask) {
		throw new Error('createProjectAndClearPlanning: planning task not found after approval');
	}
	await page.request.patch(`/api/teams/${teamId}/tasks/${planningTask.id}`, {
		headers,
		data: { status: 'done' },
	});
	const merged = { ...project, planning_task_id: planningTask.id };
	// Also expose a Response-like .json() / .ok() / .status so callers that hold
	// the result as `projRes` can still do `(await projRes.json()).data` without
	// changing every call site.
	return Object.assign(merged, {
		ok: () => true,
		status: () => 201,
		json: async () => ({ data: merged }),
	});
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
}

export type HttpMethod = 'GET' | 'PATCH' | 'POST' | 'DELETE' | 'PUT';

export type ResponseMatcher = (url: URL, method: string) => boolean;

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matcher for `/api/teams/<teamId>/tasks[/<taskId>[/<subResource>...]]`.
 * `teamId` is the team slug, `taskId` is the lowercase task identifier
 * (e.g. `rp-1`) — the value the route param holds, not the UUID. Captain's
 * background planning-task PATCHes hit the same URL shape, so always pass
 * `taskId` to keep the matcher to *this* test's task.
 */
export function taskMatcher(opts: {
	teamId: string;
	taskId?: string;
	subResource?: string;
	method?: HttpMethod;
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
 * Matcher for `/api/teams/<teamId>[/<resource>[/...]]`. Use for non-task
 * team-scoped resources (projects, comments, etc.).
 */
export function teamMatcher(opts: {
	teamId: string;
	resource?: string;
	method?: HttpMethod;
}): ResponseMatcher {
	const teamSeg = escapeRegex(opts.teamId);
	const pattern = opts.resource
		? new RegExp(`^/api/teams/${teamSeg}/${escapeRegex(opts.resource)}(?:/.*)?$`)
		: new RegExp(`^/api/teams/${teamSeg}(?:/.*)?$`);
	return (url, m) => (!opts.method || m === opts.method) && pattern.test(url.pathname);
}

/**
 * Matcher for `/api/teams/<teamId>/agents[/<agentId>]`. `agentId` is the
 * agent UUID (the agent route doesn't slugify).
 */
export function agentMatcher(opts: {
	teamId: string;
	agentId?: string;
	method?: HttpMethod;
}): ResponseMatcher {
	const teamSeg = escapeRegex(opts.teamId);
	const pattern = opts.agentId
		? new RegExp(`^/api/teams/${teamSeg}/agents/${escapeRegex(opts.agentId)}$`)
		: new RegExp(`^/api/teams/${teamSeg}/agents(?:\\?.*)?$`);
	return (url, m) => (!opts.method || m === opts.method) && pattern.test(url.pathname);
}

/**
 * Click a save/confirm button and wait for both the mutation and the
 * follow-up refetch GET that React Query's onSuccess invalidation triggers.
 * Returns only when the UI is guaranteed to have refreshed with the new data
 * — clicking and waiting only for the mutation leaves a window where the
 * PATCH has landed but the component hasn't re-rendered yet, and the next
 * `expect(text).toBeVisible()` races that window.
 *
 * Both matchers should be scoped to the test's exact slug+id+method so
 * Captain's background traffic can't satisfy either.
 */
export async function saveAndWaitForRefetch(
	page: Page,
	locator: Locator,
	options: {
		mutation: ResponseMatcher;
		refetch: ResponseMatcher;
		timeout?: number;
	},
): Promise<{ mutation: Response; refetch: Response }> {
	const timeout = options.timeout ?? 30_000;
	const wait = (match: ResponseMatcher) =>
		page.waitForResponse(
			(r) => {
				try {
					return match(new URL(r.url()), r.request().method());
				} catch {
					return false;
				}
			},
			{ timeout },
		);
	const mutationPromise = wait(options.mutation);
	const refetchPromise = wait(options.refetch);
	await locator.click();
	const [mutation, refetch] = await Promise.all([mutationPromise, refetchPromise]);
	return { mutation, refetch };
}

/**
 * @deprecated Prefer `saveAndWaitForRefetch` with `taskMatcher` / `teamMatcher` /
 * `agentMatcher` — the loose-regex pattern matches background traffic and
 * the mutation-only wait races React Query's refetch.
 */
export async function clickAndWaitForResponse(
	page: Page,
	locator: Locator,
	match: ResponseMatcher,
	options: { timeout?: number } = {},
): Promise<Response> {
	const timeout = options.timeout ?? 30_000;
	const [response] = await Promise.all([
		page.waitForResponse(
			(r) => {
				try {
					return match(new URL(r.url()), r.request().method());
				} catch {
					return false;
				}
			},
			{ timeout },
		),
		locator.click(),
	]);
	return response;
}

export { TEST_MASTER_KEY };
