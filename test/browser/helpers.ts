import {
	buildLoginMessage,
	buildPasswordSetupMessage,
	buildSetupMessage,
	buildUnlockMessage,
	deriveAuthKeyPair,
	derivePasswordKeyPair,
	deriveUnlockKey,
	generatePasswordSalt,
	signAuthMessage,
} from '@hezo/shared';
import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { TEST_MNEMONIC, TEST_PASSWORD } from './constants';

// The phrase never goes over the wire: the Node test process derives the same
// keys the browser would and runs the challenge-response dance over HTTP.
const TEST_AUTH_KEYS = deriveAuthKeyPair(TEST_MNEMONIC);
const TEST_UNLOCK_KEY = deriveUnlockKey(TEST_MNEMONIC);

// Bun's webserver starts listening before Hono routes are mounted, so the very
// first request during cold start can hit the default 404 ("404 Not Found"
// plain text) and crash res.json(). Retry until we get a real JSON body.
// Returns the master-key *setup* token (password-setup-scoped, not a session).
async function requestSetupToken(page: Page): Promise<string> {
	const deadline = Date.now() + 30_000;
	let lastError: unknown = null;
	while (Date.now() < deadline) {
		try {
			const statusRes = await page.request.get('/api/status');
			if (statusRes.ok()) {
				const { masterKeyState } = (await statusRes.json()) as { masterKeyState: string };
				// The shared e2e server boots enrolled via HEZO_MASTER_KEY, so the
				// setup branch only fires against a fresh/unset server (and a 409
				// race between workers just loops into the login branch).
				const token =
					masterKeyState === 'unset'
						? await setupViaApi(page)
						: await loginViaApi(page, masterKeyState === 'locked');
				if (token) return token;
			}
			lastError = new Error(`Unexpected ${statusRes.status()} from /api/status`);
		} catch (err) {
			lastError = err;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw lastError ?? new Error('Timed out authenticating via /api/auth');
}

// Exchange the master-key setup token for a real session by enrolling the test
// password's verifier — the mnemonic only unlocks; a session is minted only by
// the password. The password never goes over the wire (only salt + public key +
// signature). Enrolling is last-write-wins on the verifier but each call returns
// its own signed session, so parallel workers don't race for a usable token.
async function requestToken(page: Page): Promise<string> {
	const setupToken = await requestSetupToken(page);
	const salt = generatePasswordSalt();
	const { publicKeyHex, privateKey } = await derivePasswordKeyPair(TEST_PASSWORD, salt);
	const res = await page.request.post('/api/auth/password', {
		headers: { Authorization: `Bearer ${setupToken}` },
		data: {
			salt,
			public_key: publicKeyHex,
			signature: signAuthMessage(privateKey, buildPasswordSetupMessage(publicKeyHex, salt)),
		},
	});
	if (!res.ok()) throw new Error(`Unexpected ${res.status()} from /api/auth/password`);
	const json = (await res.json()) as { data?: { token: string } };
	if (!json.data?.token) throw new Error('No session token from /api/auth/password');
	return json.data.token;
}

async function setupViaApi(page: Page): Promise<string | null> {
	const res = await page.request.post('/api/auth/setup', {
		data: {
			public_key: TEST_AUTH_KEYS.publicKeyHex,
			unlock_key: TEST_UNLOCK_KEY,
			signature: signAuthMessage(
				TEST_AUTH_KEYS.privateKey,
				buildSetupMessage(TEST_AUTH_KEYS.publicKeyHex, TEST_UNLOCK_KEY),
			),
		},
	});
	if (!res.ok()) throw new Error(`Unexpected ${res.status()} from /api/auth/setup`);
	const json = (await res.json()) as { data?: { token: string } };
	return json.data?.token ?? null;
}

async function loginViaApi(page: Page, includeUnlockKey: boolean): Promise<string | null> {
	const challengeRes = await page.request.post('/api/auth/challenge');
	if (!challengeRes.ok()) {
		throw new Error(`Unexpected ${challengeRes.status()} from /api/auth/challenge`);
	}
	const challenge = (
		(await challengeRes.json()) as { data: { challenge_id: string; nonce: string } }
	).data;
	const body: Record<string, string> = { challenge_id: challenge.challenge_id };
	if (includeUnlockKey) {
		body.unlock_key = TEST_UNLOCK_KEY;
		body.signature = signAuthMessage(
			TEST_AUTH_KEYS.privateKey,
			buildUnlockMessage(challenge.nonce, TEST_UNLOCK_KEY),
		);
	} else {
		body.signature = signAuthMessage(TEST_AUTH_KEYS.privateKey, buildLoginMessage(challenge.nonce));
	}
	const res = await page.request.post('/api/auth/verify', { data: body });
	if (!res.ok()) throw new Error(`Unexpected ${res.status()} from /api/auth/verify`);
	const json = (await res.json()) as { data?: { token: string } };
	return json.data?.token ?? null;
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
 * Force-close a planning task to clear the board for a test.
 *
 * Marking it `done` is guarded by `assertNoOutstandingActivity` — it 400s while
 * the Captain has an active run on the task, and the 1Hz e2e wakeup cron
 * re-dispatches that run faster than a terminate-then-close loop can win on a
 * loaded CI runner (the source of the shard flake). `cancelled` is **not**
 * guarded and is terminal, so it closes the task and, being terminal, stops the
 * cron from spawning any further runs on it — deterministic, no race. Any run
 * still active is then terminated best-effort to free the CI worker promptly
 * (no new one can replace it now that the task is terminal).
 */
async function closePlanningTask(
	page: Page,
	projectSlug: string,
	taskId: string,
	headers: Record<string, string>,
): Promise<void> {
	const cancelRes = await page.request.patch(`/api/projects/${projectSlug}/tasks/${taskId}`, {
		headers,
		data: { status: 'cancelled' },
	});
	if (!cancelRes.ok()) {
		throw new Error(
			`closePlanningTask: failed to cancel ${taskId} — ${cancelRes.status()} ${await cancelRes.text()}`,
		);
	}

	// Drain any run still active on the now-terminal task so it can't linger in the
	// agent queue or hold a worker. Because the task is terminal the cron won't
	// dispatch a replacement, so this converges quickly: terminate, then poll until
	// no queued/running run remains for this task.
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const taskRes = await page.request.get(`/api/projects/${projectSlug}/tasks/${taskId}`, {
			headers,
		});
		const task = ((await taskRes.json()) as { data?: { assignee_id: string | null } }).data;
		if (!task?.assignee_id) return;

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
		const active = runs.filter(
			(r) => r.task_id === taskId && (r.status === 'queued' || r.status === 'running'),
		);
		if (active.length === 0) return;
		for (const run of active) {
			await page.request.post(
				`/api/projects/${projectSlug}/agents/${task.assignee_id}/heartbeat-runs/${run.id}/terminate`,
				{ headers },
			);
		}
		await new Promise((r) => setTimeout(r, 200));
	}
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
		initial_project_plan?: string;
		task_prefix?: string;
		template_id?: string;
		marketplace_slug?: string;
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
	data: { name: string; description?: string; template_id?: string; marketplace_slug?: string },
) {
	const project = await createProjectAndClearPlanning(page, team.slug, token, data);
	await waitForProjectContainer(page, project.id, token);
	await waitForCaptainIdle(page, project.team_slug, token);
	return project;
}

/** Resolve a team-type template id by display name (e.g. 'App Team', 'Blank'). */
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
 * stands up a fresh team, plus its project + planning task), then close the
 * planning task so it doesn't race agent runs. The full "App Team" roster now
 * comes from the marketplace (`software-development`); "Blank" is still a seeded
 * template resolved by name.
 */
async function createWorkspaceProject(
	page: Page,
	token: string,
	opts: { templateName: string; namePrefix: string },
): Promise<CreatedProject> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const uid = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
	const source =
		opts.templateName === 'App Team'
			? { marketplace_slug: 'software-development' }
			: { template_id: await getTemplateIdByName(page, token, opts.templateName) };
	const res = await page.request.post('/api/projects', {
		headers,
		data: {
			name: `${opts.namePrefix} ${uid}`,
			description: 'Created via e2e workspace helper.',
			...source,
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
		templateName: 'App Team',
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

	// Pick the Anthropic card from the grid, then fill its API-key form.
	await page.getByRole('button', { name: 'Anthropic' }).first().click();
	await page.locator('input[type="password"]').first().fill('sk-ant-e2e-test-key');
	await page.getByRole('button', { name: 'Save' }).first().click();

	await expect(aiStep).toBeHidden({ timeout: 20000 });
}

export async function waitForPageLoad(page: Page, timeout = 15000) {
	// The app shell renders the route outlet inside `<main>` (see __root.tsx), and
	// a route shows its own "Loading..." placeholder there while its data resolves.
	// `toBeHidden()` is *also* satisfied by an absent element, so checking the
	// loader before React has mounted passes immediately — leaving the caller
	// asserting against an unrendered page (the flaky "element(s) not found" right
	// after navigation). Gate on the shell mounting first: once <main> is visible
	// the route has committed either its loader or its content, so the loader
	// check below waits for data to land instead of racing the initial mount.
	await expect(page.locator('main').first()).toBeVisible({ timeout });
	// A route renders its own "Loading..." placeholder while its data resolves —
	// and some pages render more than one (the documents page has a loader in both
	// its sidebar `complementary` and its main `section`). A bare
	// `getByText('Loading...').toBeHidden()` is a *strict* locator and throws a
	// "resolved to 2 elements" error the moment two loaders are on screen at once
	// (which the fast preview build renders reliably). `toHaveCount(0)` waits for
	// every loader to clear and is strict-mode safe; an absent loader is count 0,
	// so the pre-mount fast-pass it guards against still can't happen (the <main>
	// visibility gate above already ensures the route has committed).
	await expect(page.getByText('Loading...')).toHaveCount(0, { timeout });
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

/**
 * Serve a deterministic `/api/projects` index for project-rail layout specs.
 *
 * The e2e server is shared across parallel workers, each creating teams and
 * projects of its own, so the real index length is unpredictable. This keeps
 * only the internal (HQ) entries plus `keepSlug`'s project, then appends
 * `clones` synthetic copies of it — enough to force (or rule out) rail
 * overflow regardless of what the other workers are doing. The clone slugs
 * don't exist server-side, so their per-avatar inbox-count queries are
 * answered with zero instead of 404ing against the backend.
 */
export async function mockRailProjects(
	page: Page,
	options: { keepSlug: string; clones: number },
): Promise<void> {
	await page.route('**/api/projects', async (route) => {
		const res = await route.fetch();
		const json = (await res.json()) as { data: Array<Record<string, unknown>> };
		const kept = json.data.filter((p) => p.is_internal === true || p.slug === options.keepSlug);
		const base = kept.find((p) => p.slug === options.keepSlug);
		if (!base) {
			throw new Error(`mockRailProjects: project "${options.keepSlug}" not in the live index`);
		}
		const clones = Array.from({ length: options.clones }, (_, i) => ({
			...base,
			id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
			slug: `rail-fill-${i + 1}`,
			name: `Rail Fill ${i + 1}`,
		}));
		await route.fulfill({
			response: res,
			body: JSON.stringify({ ...json, data: [...kept, ...clones] }),
		});
	});
	await page.route('**/api/projects/rail-fill-*/inbox/count', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: { unread: 0 } }),
		}),
	);
}

/**
 * Inflate the marketplace catalog to `count` teams so the New Project dialog's team
 * list is guaranteed to overflow, whatever the committed `marketplace/` folder ships.
 * The extra entries are clones of a real one, so every field the dialog reads is
 * present and the per-team detail fetch still resolves for the original slugs.
 */
export async function mockMarketplaceCatalog(page: Page, count: number): Promise<void> {
	await page.route('**/api/marketplace/teams', async (route) => {
		const res = await route.fetch();
		const json = (await res.json()) as { data: Array<Record<string, unknown>> };
		const base = json.data[0];
		if (!base) throw new Error('mockMarketplaceCatalog: the live catalog is empty');
		const filler = Array.from({ length: Math.max(0, count - json.data.length) }, (_, i) => ({
			...base,
			slug: `catalog-fill-${i + 1}`,
			name: `Catalog Fill ${i + 1}`,
		}));
		await route.fulfill({
			response: res,
			body: JSON.stringify({ ...json, data: [...json.data, ...filler] }),
		});
	});
	// The clones have no def behind them; serve the real one so opening their detail
	// renders a roster instead of the fetch-failed state.
	await page.route('**/api/marketplace/teams/catalog-fill-*', async (route) => {
		const url = new URL(route.request().url());
		const real = `${url.origin}/api/marketplace/teams/software-development`;
		await route.fulfill({ response: await route.fetch({ url: real }) });
	});
}

/**
 * Open the New Project dialog from the home page and step into its full team
 * catalog ("View all teams"), waiting until the list is interactive.
 */
export async function openTeamCatalog(page: Page): Promise<void> {
	await page.getByTestId('home-new-project').first().click();
	await expect(page.getByPlaceholder('e.g. Marketing Site')).toBeVisible({ timeout: 15_000 });
	await page.getByTestId('view-all-teams').click();
	await expect(page.getByTestId('team-search')).toBeVisible({ timeout: 15_000 });
}
