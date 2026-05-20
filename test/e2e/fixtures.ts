import { type APIRequestContext, type Browser, test as base, expect } from '@playwright/test';
import {
	authenticate,
	createCompanyLight,
	createCompanyWithAgents,
	ensureAiProviderConfigured,
	getToken,
} from './helpers';

type Company = { id: string; slug: string; name: string };
type Agent = { id: string; slug: string };

type Workspace = {
	company: Company;
	token: string;
	agents: Agent[];
};

type LightWorkspace = {
	company: Company;
	token: string;
};

type WorkerFixtures = {
	apiToken: string;
	sharedWorkspace: Workspace;
};

type TestFixtures = {
	authedPage: import('@playwright/test').Page;
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
	companyId: string,
	token: string,
): Promise<Agent[]> {
	const res = await request.get(`/api/companies/${companyId}/agents`, {
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

	sharedWorkspace: [
		async ({ browser }, use) => {
			const ctx = await browser.newContext();
			const page = await ctx.newPage();
			const { company, token } = await createCompanyWithAgents(page);
			const agents = await listAgents(ctx.request, company.id, token);
			await ctx.close();
			await use({ company, token, agents });
		},
		{ scope: 'worker' },
	],

	authedPage: async ({ page, apiToken }, use) => {
		await page.addInitScript((t: string) => {
			localStorage.setItem('hezo_token', t);
		}, apiToken);
		await use(page);
	},

	freshWorkspace: async ({ page }, use) => {
		await authenticate(page);
		const { company, token } = await createCompanyWithAgents(page);
		const agents = await listAgents(page.request, company.id, token);
		await use({ company, token, agents });
	},

	lightWorkspace: async ({ page }, use) => {
		await authenticate(page);
		const { company, token } = await createCompanyLight(page);
		await use({ company, token });
	},
});

export { expect };
