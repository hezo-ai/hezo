import { expect, type Page } from '@playwright/test';

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
 * Create a project and mark its auto-generated planning issue as done.
 * Tests that kick off agent runs on the Captain would otherwise race the
 * Captain's planning wakeup and see runs targeted at the planning issue.
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
			data: { id: string; slug: string; planning_issue_id: string };
		}
	).data;
	await page.request.patch(`/api/teams/${teamId}/issues/${project.planning_issue_id}`, {
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
 * Create a project, close its planning issue, and wait for the dev container — ready for agent runs.
 */
export async function createProjectReadyForAgents(
	page: Page,
	team: { id: string; slug: string },
	token: string,
	data: { name: string; description?: string },
) {
	const project = await createProjectAndClearPlanning(page, team.id, token, data);
	await confirmTeamExecutionStarted(page, team.slug, token);
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
 * Close requirements and hire-team intake tickets so Captain is not busy on onboarding work.
 * Safe to call when intake is already complete (404s are ignored).
 */
export async function completeOnboardingIntakes(
	page: Page,
	teamSlug: string,
	token: string,
): Promise<void> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const reqRes = await page.request.get(`/api/teams/${teamSlug}/requirements-intake`, { headers });
	if (reqRes.ok()) {
		const { issue_id } = ((await reqRes.json()) as { data: { issue_id: string } }).data;
		if (issue_id) {
			await page.request.patch(`/api/teams/${teamSlug}/issues/${issue_id}`, {
				headers,
				data: { status: 'done' },
			});
		}
	}

	// Hire intake is created when requirements intake closes — poll until it appears, then close it.
	for (let i = 0; i < 100; i++) {
		const hireRes = await page.request.get(`/api/teams/${teamSlug}/hire-team-intake`, { headers });
		if (hireRes.status() === 404) {
			await new Promise((r) => setTimeout(r, 200));
			continue;
		}
		if (hireRes.ok()) {
			const { issue_id } = ((await hireRes.json()) as { data: { issue_id: string } }).data;
			if (issue_id) {
				await page.request.patch(`/api/teams/${teamSlug}/issues/${issue_id}`, {
					headers,
					data: { status: 'done' },
				});
			}
		}
		break;
	}
}

/** Finish onboarding intakes and confirm the first user-facing project may execute (goal tickets, planning wakeup). */
export async function confirmTeamExecutionStarted(
	page: Page,
	teamSlug: string,
	token: string,
): Promise<void> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	await completeOnboardingIntakes(page, teamSlug, token);
	const startRes = await page.request.post(`/api/teams/${teamSlug}/onboarding/start-project`, {
		headers,
	});
	expect(startRes.ok()).toBe(true);
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

	await completeOnboardingIntakes(page, team.slug, token);
	// Intake close can queue Captain runs; wait before tests create projects and trigger wakeups.
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

/** Dismiss the AI provider setup gate by entering a test API key via the UI. */
export async function dismissAiProviderModal(page: Page) {
	const modal = page.getByText('Set up an AI provider');
	try {
		await modal.waitFor({ state: 'visible', timeout: 15000 });
	} catch {
		return;
	}

	await page.getByRole('button', { name: 'Enter API key' }).first().click();
	await page.locator('input[type="password"]').first().fill('sk-ant-e2e-test-key');
	await page.getByRole('button', { name: 'Save' }).first().click();

	await expect(modal).toBeHidden({ timeout: 20000 });
}

export async function waitForPageLoad(page: Page, timeout = 15000) {
	await expect(page.getByText('Loading...')).toBeHidden({ timeout });
}

export { TEST_MASTER_KEY };
