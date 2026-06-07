import { type APIRequestContext, type Browser, test as base, expect } from '@playwright/test';
import {
	authenticate,
	createTeamLight,
	createTeamWithAgents,
	ensureAiProviderConfigured,
	getToken,
} from './helpers';

type Team = { id: string; slug: string; name: string };
type Agent = {
	id: string;
	slug: string;
	title: string;
	default_effort?: string;
	admin_status?: string;
};

type Workspace = {
	team: Team;
	token: string;
	agents: Agent[];
	projectSlug: string;
};

type LightWorkspace = {
	team: Team;
	token: string;
	projectSlug: string;
};

type WorkerFixtures = {
	apiToken: string;
	sharedWorkspace: Workspace;
};

type TestFixtures = {
	authedPage: import('@playwright/test').Page;
	sharedPage: import('@playwright/test').Page;
	freshWorkspace: Workspace;
	lightWorkspace: LightWorkspace;
};

async function getTokenFromBrowser(browser: Browser): Promise<string> {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	const token = await getToken(page);
	await ensureAiProviderConfigured(page, token);
	await ctx.close();
	return token;
}

async function listAgents(
	request: APIRequestContext,
	projectSlug: string,
	token: string,
): Promise<Agent[]> {
	const res = await request.get(`/api/projects/${projectSlug}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	return ((await res.json()) as { data: Agent[] }).data;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
	apiToken: [
		async ({ browser }, use) => {
			const token = await getTokenFromBrowser(browser);
			await use(token);
		},
		{ scope: 'worker' },
	],

	// Worker-scoped team-with-agents, created once per worker. Tests that don't
	// mutate team-level or global agent state can take this fixture and create
	// their own per-test project/task/comment under it. Captain's template-apply
	// drain runs once per worker (not per test), saving ~30-60s per test.
	sharedWorkspace: [
		async ({ browser }, use) => {
			const ctx = await browser.newContext();
			const page = await ctx.newPage();
			const { team, token, projectSlug } = await createTeamWithAgents(page);
			const agents = await listAgents(ctx.request, projectSlug, token);
			await ctx.close();
			await use({ team, token, agents, projectSlug });
		},
		{ scope: 'worker' },
	],

	authedPage: async ({ page, apiToken }, use) => {
		await page.addInitScript((t: string) => {
			localStorage.setItem('hezo_token', t);
		}, apiToken);
		await use(page);
		await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
	},

	// Authed page wired to the worker-scoped sharedWorkspace. The token in the
	// page's localStorage matches sharedWorkspace.token (both come from the
	// same master-key auth flow), so page.goto(`/projects/${projectSlug}/...`) just
	// works without any per-test seeding.
	sharedPage: async ({ page, sharedWorkspace }, use) => {
		await page.addInitScript((t: string) => {
			localStorage.setItem('hezo_token', t);
		}, sharedWorkspace.token);
		await use(page);
		await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
	},

	freshWorkspace: async ({ page }, use) => {
		await authenticate(page);
		const { team, token, projectSlug } = await createTeamWithAgents(page);
		const agents = await listAgents(page.request, projectSlug, token);
		await use({ team, token, agents, projectSlug });
		// Drain any page.route interceptors before Playwright tears down the page,
		// so in-flight route.fetch()/route.fulfill() calls don't reject with
		// "Target page has been closed" and turn a clean pass into a flaky retry.
		await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
	},

	lightWorkspace: async ({ page }, use) => {
		await authenticate(page);
		const { team, token, projectSlug } = await createTeamLight(page);
		await use({ team, token, projectSlug });
		await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
	},
});

export { expect };
