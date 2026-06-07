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
 * Resolve the single project slug backing a team (1:1 teams↔projects). Agent,
 * task, and heartbeat-run endpoints are project-scoped, and a team's
 * coordination lives entirely in its single project, so callers that only hold
 * a team slug use this to reach the project-scoped routes.
 */
export async function resolveProjectSlugForTeam(
	page: Page,
	teamSlug: string,
	token: string,
): Promise<string> {
	const res = await page.request.get('/api/projects', {
		headers: { Authorization: `Bearer ${token}` },
	});
	const projects = ((await res.json()) as { data: Array<{ slug: string; team_slug: string }> })
		.data;
	const project = projects.find((p) => p.team_slug === teamSlug);
	if (!project) throw new Error(`No project found for team '${teamSlug}'`);
	return project.slug;
}

/**
 * Force-close a planning task by terminating any active Captain run, then
 * marking the task done. Retries because the wakeup cron can spin up a new
 * run between the terminate and the close.
 */
async function closePlanningTask(
	page: Page,
	projectSlug: string,
	taskId: string,
	headers: Record<string, string>,
): Promise<void> {
	const deadline = Date.now() + 15_000;
	let lastError = '';
	while (Date.now() < deadline) {
		const taskRes = await page.request.get(`/api/projects/${projectSlug}/tasks/${taskId}`, {
			headers,
		});
		const task = (
			(await taskRes.json()) as { data?: { status: string; assignee_id: string | null } }
		).data;
		if (!task) throw new Error('closePlanningTask: task not found');
		if (task.status === 'done' || task.status === 'closed' || task.status === 'cancelled') return;

		if (task.assignee_id) {
			const runsRes = await page.request.get(
				`/api/projects/${projectSlug}/agents/${task.assignee_id}/heartbeat-runs`,
				{ headers },
			);
			const runs =
				(
					(await runsRes.json()) as {
						data?: Array<{ id: string; status: string; task_id: string | null }>;
					}
				).data ?? [];
			for (const run of runs) {
				if (run.task_id !== taskId) continue;
				if (run.status === 'queued' || run.status === 'running') {
					await page.request.post(
						`/api/projects/${projectSlug}/agents/${task.assignee_id}/heartbeat-runs/${run.id}/terminate`,
						{ headers },
					);
				}
			}
		}

		const patchRes = await page.request.patch(`/api/projects/${projectSlug}/tasks/${taskId}`, {
			headers,
			data: { status: 'done' },
		});
		if (patchRes.ok()) return;
		lastError = `${patchRes.status()} ${await patchRes.text()}`;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`closePlanningTask: failed to close ${taskId} within 15s — ${lastError}`);
}

/**
 * Create a project directly and clear its auto-created planning task.
 *
 * Under the 1:1 teams↔projects model `POST /api/projects` stands up a *fresh
 * team* plus its single project, a Captain planning task, and an initial CEO
 * coherence task that blocks the planning task. The new project is therefore
 * its OWN team — not a second project under any passed-in team. The leading
 * `teamSlug` argument is retained for call-site compatibility but ignored; the
 * returned project carries its own `team_slug`.
 *
 * The auto-created planning task is closed so tests that kick off their own
 * agent runs don't race the Captain's planning wakeup.
 */
export async function createProjectAndClearPlanning(
	page: Page,
	_teamSlug: string,
	token: string,
	data: {
		name: string;
		description?: string;
		initial_prd?: string;
		task_prefix?: string;
		template_id?: string;
	},
) {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const projRes = await page.request.post(`/api/projects`, {
		headers,
		data: { description: 'Created via e2e helper.', ...data },
	});
	if (!projRes.ok()) {
		throw new Error(
			`createProjectAndClearPlanning: POST /api/projects failed — ${projRes.status()} ${await projRes.text()}`,
		);
	}
	const project = (
		(await projRes.json()) as {
			data: {
				id: string;
				slug: string;
				name: string;
				team_id: string;
				team_slug: string;
				planning_task_id: string;
			};
		}
	).data;

	await closePlanningTask(page, project.slug, project.planning_task_id, headers);
	const merged = { ...project };
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
	projectId: string,
	token: string,
	timeoutMs = 90_000,
): Promise<void> {
	const headers = { Authorization: `Bearer ${token}` };
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await page.request.get(`/api/projects/${projectId}`, { headers });
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
	data: { name: string; description?: string; template_id?: string },
) {
	const project = await createProjectAndClearPlanning(page, team.slug, token, data);
	await waitForProjectContainer(page, project.id, token);
	await waitForCaptainIdle(page, project.team_slug, token);
	return project;
}

/** Resolve a team-type template id by display name (e.g. 'Startup', 'Blank'). */
export async function getTemplateIdByName(
	page: Page,
	token: string,
	name: string,
): Promise<string | undefined> {
	const res = await page.request.get('/api/team-templates', {
		headers: { Authorization: `Bearer ${token}` },
	});
	const data = ((await res.json()) as { data: Array<{ id: string; name: string }> }).data;
	return data.find((t) => t.name === name)?.id;
}

/**
 * Wait until a specific agent is idle (no active heartbeat run). Gives the
 * fire-and-forget `trackBackground(createWakeup(...))` from the task POST or
 * comment POST a brief grace period to land in the wakeup table before the
 * first check, so we don't observe a stale idle state right before the cron
 * fires the next run.
 */
export async function waitForAgentIdle(
	page: Page,
	teamSlug: string,
	agentId: string,
	token: string,
	timeoutMs = 180_000,
): Promise<void> {
	// Let any background wakeup-create promise from a preceding task/comment
	// POST settle into the queue before we start polling.
	await new Promise((r) => setTimeout(r, 1200));
	const headers = { Authorization: `Bearer ${token}` };
	const projectSlug = await resolveProjectSlugForTeam(page, teamSlug, token);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await page.request.get(`/api/projects/${projectSlug}/agents/${agentId}`, {
			headers,
		});
		const agent = ((await res.json()) as { data: { runtime_status: string } }).data;
		if (agent?.runtime_status === 'idle') return;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`Agent ${agentId} did not return to idle within ${timeoutMs}ms`);
}

/** Wait until Captain is idle (e.g. after onboarding intake wakeups finish). */
export async function waitForCaptainIdle(
	page: Page,
	teamSlug: string,
	token: string,
	timeoutMs = 180_000,
): Promise<void> {
	const headers = { Authorization: `Bearer ${token}` };
	const projectSlug = await resolveProjectSlugForTeam(page, teamSlug, token);
	const res = await page.request.get(`/api/projects/${projectSlug}/agents`, { headers });
	const agents = ((await res.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const captain = agents.find((a) => a.slug === 'captain');
	if (!captain) throw new Error('Captain agent not found');
	await waitForAgentIdle(page, teamSlug, captain.id, token, timeoutMs);
}

type CreatedProject = {
	id: string;
	slug: string;
	name: string;
	team_id: string;
	team_slug: string;
	planning_task_id: string;
};

/**
 * Create a workspace: under 1:1 teams↔projects a "workspace" is a team WITH its
 * single project. We provision both in one shot via `POST /api/projects` (which
 * stands up a fresh team from the chosen template, plus its project + planning
 * task), then close the planning task so it doesn't race agent runs. The Startup
 * template seeds the full agent roster.
 */
async function createWorkspaceProject(
	page: Page,
	token: string,
	opts: { templateName: string; namePrefix: string },
): Promise<CreatedProject> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const templateId = await getTemplateIdByName(page, token, opts.templateName);
	const uid = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
	const res = await page.request.post('/api/projects', {
		headers,
		data: {
			name: `${opts.namePrefix} ${uid}`,
			description: 'Created via e2e workspace helper.',
			template_id: templateId,
		},
	});
	if (!res.ok()) {
		throw new Error(`createWorkspaceProject failed — ${res.status()} ${await res.text()}`);
	}
	const project = ((await res.json()) as { data: CreatedProject }).data;
	await closePlanningTask(page, project.slug, project.planning_task_id, headers);
	return project;
}

export async function createTeamWithAgents(page: Page) {
	const token = await getToken(page);

	await ensureAiProviderConfigured(page, token);

	const project = await createWorkspaceProject(page, token, {
		templateName: 'Startup',
		namePrefix: 'Test Co',
	});

	const team = { id: project.team_id, slug: project.team_slug, name: project.name };
	return { team, token, projectSlug: project.slug };
}

/**
 * Lightweight workspace for UI-only tests: a team + project seeded from the
 * Blank template (Captain only), skipping the full agent roster. Still a real
 * 1:1 team↔project so project-scoped routes resolve.
 */
export async function createTeamLight(page: Page) {
	const token = await getToken(page);

	await ensureAiProviderConfigured(page, token);

	const project = await createWorkspaceProject(page, token, {
		templateName: 'Blank',
		namePrefix: 'Test Co Light',
	});

	const team = { id: project.team_id, slug: project.team_slug, name: project.name };
	return { team, token, projectSlug: project.slug };
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

/**
 * Suffix a base string with a short random uid so per-test resources created
 * under the worker-scoped sharedWorkspace don't collide with prior tests or
 * retries that re-enter the same worker. Use for project / task / doc names
 * that the test later looks up by name.
 */
export function uniqueName(base: string): string {
	return `${base} ${Math.random().toString(36).slice(2, 8)}`;
}

export type HttpMethod = 'GET' | 'PATCH' | 'POST' | 'DELETE' | 'PUT';

export type ResponseMatcher = (url: URL, method: string) => boolean;

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matcher for `/api/projects/<projectSlug>/tasks[/<taskId>[/<subResource>...]]`.
 * `projectSlug` is the project slug, `taskId` is the lowercase task identifier
 * (e.g. `rp-1`) — the value the route param holds, not the UUID. Captain's
 * background planning-task PATCHes hit the same URL shape, so always pass
 * `taskId` to keep the matcher to *this* test's task.
 */
export function taskMatcher(opts: {
	projectSlug: string;
	taskId?: string;
	subResource?: string;
	method?: HttpMethod;
}): ResponseMatcher {
	const projectSeg = escapeRegex(opts.projectSlug);
	const taskSeg = opts.taskId ? escapeRegex(opts.taskId) : '[^/]+';
	let pattern: RegExp;
	if (opts.subResource) {
		const sub = escapeRegex(opts.subResource);
		pattern = new RegExp(`^/api/projects/${projectSeg}/tasks/${taskSeg}/${sub}(?:/[^/]+)*$`);
	} else if (opts.taskId) {
		pattern = new RegExp(`^/api/projects/${projectSeg}/tasks/${taskSeg}$`);
	} else {
		pattern = new RegExp(`^/api/projects/${projectSeg}/tasks(?:\\?.*)?$`);
	}
	return (url, m) => (!opts.method || m === opts.method) && pattern.test(url.pathname);
}

/**
 * Matcher for `/api/projects/<projectSlug>[/<resource>[/...]]`. Use for non-task
 * project-scoped resources (comments, etc.).
 */
export function teamMatcher(opts: {
	projectSlug: string;
	resource?: string;
	method?: HttpMethod;
}): ResponseMatcher {
	const projectSeg = escapeRegex(opts.projectSlug);
	const pattern = opts.resource
		? new RegExp(`^/api/projects/${projectSeg}/${escapeRegex(opts.resource)}(?:/.*)?$`)
		: new RegExp(`^/api/projects/${projectSeg}(?:/.*)?$`);
	return (url, m) => (!opts.method || m === opts.method) && pattern.test(url.pathname);
}

/**
 * Matcher for `/api/projects/<projectSlug>/agents[/<agentId>]`. `agentId` is the
 * agent UUID (the agent route doesn't slugify).
 */
export function agentMatcher(opts: {
	projectSlug: string;
	agentId?: string;
	method?: HttpMethod;
}): ResponseMatcher {
	const projectSeg = escapeRegex(opts.projectSlug);
	const pattern = opts.agentId
		? new RegExp(`^/api/projects/${projectSeg}/agents/${escapeRegex(opts.agentId)}$`)
		: new RegExp(`^/api/projects/${projectSeg}/agents(?:\\?.*)?$`);
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
