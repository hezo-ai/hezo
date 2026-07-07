// Coverage for components/github-section.tsx beyond the disconnected CTA that
// project-settings.test.tsx already hits: the connected state, the repo list
// (web link + designated lock + deletable rows), the reauth/needs-permissions
// banner, and the startConnect error path. Rendered through the project's Git
// settings page. The OAuth-connection / scope-status / repos / mcp-connections endpoints
// are fetch-mocked (matching agent-executions-project.test.tsx) because seeding a
// realistic GitHub OAuth connection + repos against the real backend is heavy and
// orthogonal to what this component renders. Component tier — no real layout/WS.

import { afterEach, expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

let restoreFetch: (() => void) | null = null;
afterEach(() => {
	restoreFetch?.();
	restoreFetch = null;
});

interface MockRepo {
	id: string;
	repo_identifier: string;
	host_type: string;
	is_designated: boolean;
	setup_status?: 'pending' | 'ready' | 'failed';
	setup_error?: string | null;
}

/**
 * Override the four endpoints GitHubSection reads. `connection` null → the
 * disconnected CTA; with a connection + sufficient scopes → connected/ready;
 * with `sufficient:false` → the reauth banner. `ensureFails` makes the
 * connectors/ensure POST 500 so the connect button surfaces its error.
 */
function installGitHubMock(opts: {
	connection?: { id: string; provider_account_label: string } | null;
	scopeSufficient?: boolean;
	scopeMissing?: string[];
	repos?: MockRepo[];
	ensureFails?: boolean;
	onRepoPost?: (body: Record<string, unknown>) => void;
}) {
	const original = globalThis.fetch;
	restoreFetch = () => {
		globalThis.fetch = original;
	};
	const conn = opts.connection ?? null;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : (input as Request).url;
		const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

		if (method === 'GET' && /\/api\/projects\/[^/]+\/oauth-connections$/.test(url)) {
			const data = conn
				? [
						{
							id: conn.id,
							provider: 'github',
							provider_account_id: 'gh-1',
							provider_account_label: conn.provider_account_label,
							scopes: ['repo'],
							expires_at: null,
							metadata: {},
							created_at: new Date().toISOString(),
							updated_at: new Date().toISOString(),
						},
					]
				: [];
			return jsonRes(data);
		}
		if (method === 'GET' && /\/api\/projects\/[^/]+\/mcp-connections/.test(url)) {
			return jsonRes([]);
		}
		if (
			method === 'GET' &&
			/\/api\/projects\/[^/]+\/oauth-connections\/[^/]+\/scope-status$/.test(url)
		) {
			return jsonRes({
				sufficient: opts.scopeSufficient ?? true,
				missing: opts.scopeMissing ?? [],
				required: ['repo', 'read:org'],
			});
		}
		if (method === 'GET' && /\/api\/projects\/[^/]+\/repos$/.test(url)) {
			return jsonRes(opts.repos ?? []);
		}
		if (method === 'POST' && /\/api\/projects\/[^/]+\/connectors\/ensure$/.test(url)) {
			if (opts.ensureFails) {
				return new Response(
					JSON.stringify({ error: { code: 'OAUTH_ERROR', message: 'connector setup failed' } }),
					{ status: 500, headers: { 'Content-Type': 'application/json' } },
				);
			}
			return jsonRes({ id: 'connector-1', name: 'github' });
		}
		if (method === 'DELETE' && /\/api\/projects\/[^/]+\/repos\/[^/]+$/.test(url)) {
			return jsonRes({ ok: true });
		}
		if (method === 'POST' && /\/api\/projects\/[^/]+\/repos$/.test(url)) {
			const body = init?.body ? JSON.parse(init.body as string) : {};
			opts.onRepoPost?.(body);
			return jsonRes({ id: 'r-new', setup_status: 'pending' }, 201);
		}
		return original(input as RequestInfo, init);
	}) as typeof globalThis.fetch;
}

function jsonRes(data: unknown, status = 200): Response {
	return new Response(JSON.stringify({ data }), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

async function renderSettings(mock: Parameters<typeof installGitHubMock>[0]) {
	const seeded = { projectSlug: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'GH Section Project' });
			seeded.projectSlug = project.slug;
			installGitHubMock(mock);
		},
	});
	await helpers.router.navigate({
		to: '/projects/$projectId/git',
		params: { projectId: seeded.projectSlug },
	});
	return { ...helpers, seeded };
}

test('connected with sufficient scopes shows the "Connected as" line', async () => {
	const r = await renderSettings({
		connection: { id: 'conn-1', provider_account_label: 'octocat' },
		scopeSufficient: true,
		repos: [],
	});

	// "Connected as octocat." renders once the scope check resolves sufficient.
	await r.findByText('octocat', undefined, { timeout: 20_000 });
	// With no repos yet, the ready empty-state card is shown.
	await r.findByTestId('github-state-ready');
});

test('connected with repos lists each repo with a web link; designated is locked, others deletable', async () => {
	const r = await renderSettings({
		connection: { id: 'conn-1', provider_account_label: 'octocat' },
		scopeSufficient: true,
		repos: [
			{ id: 'r1', repo_identifier: 'octocat/web-app', host_type: 'github', is_designated: true },
			{ id: 'r2', repo_identifier: 'octocat/lib', host_type: 'github', is_designated: false },
		],
	});

	// "Add repo" affordance (above the repo list) appears once ready + has repos.
	// The repos query can resolve before scope-status, so await this isReady-gated
	// element before asserting on the rest of the rendered state.
	const setupButtons = await r.findAllByTestId('repo-setup-add', undefined, { timeout: 20_000 });
	expect(setupButtons.length).toBeGreaterThan(0);

	// Web link for the designated repo points at github.com.
	const link = await r.findByTestId('repo-link-web-app');
	expect(link.getAttribute('href')).toBe('https://github.com/octocat/web-app');
	expect(link.getAttribute('target')).toBe('_blank');

	// Designated → lock affordance, no delete button.
	expect(r.queryByTestId('repo-locked-web-app')).not.toBeNull();
	expect(r.queryByTestId('repo-delete-web-app')).toBeNull();

	// Non-designated → delete button present, no lock.
	expect(r.queryByTestId('repo-delete-lib')).not.toBeNull();
	expect(r.queryByTestId('repo-locked-lib')).toBeNull();
});

test('a non-github host repo renders the identifier as plain text (no web link)', async () => {
	const r = await renderSettings({
		connection: { id: 'conn-1', provider_account_label: 'octocat' },
		scopeSufficient: true,
		repos: [
			{ id: 'r1', repo_identifier: 'gitlab-org/thing', host_type: 'gitlab', is_designated: false },
		],
	});

	// repoWebUrl returns null for non-github hosts → no anchor, plain text instead.
	await r.findByText('gitlab-org/thing', undefined, { timeout: 20_000 });
	expect(r.queryByTestId('repo-link-thing')).toBeNull();
});

test('insufficient scopes show the needs-permissions reauth banner with the missing scopes', async () => {
	const r = await renderSettings({
		connection: { id: 'conn-1', provider_account_label: 'octocat' },
		scopeSufficient: false,
		scopeMissing: ['read:org', 'write:public_key'],
		repos: [],
	});

	const banner = await r.findByTestId('github-state-reauth', undefined, { timeout: 20_000 });
	expect(banner.textContent).toContain('Permissions needed');
	expect(banner.textContent).toContain('read:org, write:public_key');
	// The re-authorize button is present.
	await r.findByTestId('github-reauth');
});

test('a pending repo shows the setting-up indicator instead of settling silently', async () => {
	const r = await renderSettings({
		connection: { id: 'conn-1', provider_account_label: 'octocat' },
		scopeSufficient: true,
		repos: [
			{
				id: 'r1',
				repo_identifier: 'octocat/cloning-now',
				host_type: 'github',
				is_designated: false,
				setup_status: 'pending',
			},
		],
	});

	const indicator = await r.findByTestId('repo-setup-pending-cloning-now', undefined, {
		timeout: 20_000,
	});
	expect(indicator.textContent).toContain('Setting up');
	// A pending repo is neither failed nor retryable yet.
	expect(r.queryByTestId('repo-setup-retry-cloning-now')).toBeNull();
	expect(r.queryByTestId('repo-setup-failed-cloning-now')).toBeNull();
});

test('a failed repo shows the setup error and Retry re-POSTs the same repo link', async () => {
	const posts: Record<string, unknown>[] = [];
	const r = await renderSettings({
		connection: { id: 'conn-1', provider_account_label: 'octocat' },
		scopeSufficient: true,
		repos: [
			{
				id: 'r1',
				repo_identifier: 'octocat/broken-clone',
				host_type: 'github',
				is_designated: false,
				setup_status: 'failed',
				setup_error: 'project container is not running',
			},
		],
		onRepoPost: (body) => posts.push(body),
	});

	const failedNote = await r.findByTestId('repo-setup-failed-broken-clone', undefined, {
		timeout: 20_000,
	});
	expect(failedNote.textContent).toContain('project container is not running');

	const retry = await r.findByTestId('repo-setup-retry-broken-clone');
	await r.user.click(retry);

	// Retry re-POSTs the same repo through the normal link flow, so the server
	// reclaims the failed row and re-runs setup.
	expect(posts).toHaveLength(1);
	expect(posts[0].mode).toBe('link');
	expect(posts[0].url).toBe('https://github.com/octocat/broken-clone');
	expect(posts[0].oauth_connection_id).toBe('conn-1');
});

test('a failing connector-ensure surfaces an inline error under the GitHub heading', async () => {
	const r = await renderSettings({
		connection: null,
		ensureFails: true,
	});

	// Disconnected CTA renders; clicking Connect kicks off ensureConnector, which
	// 500s here → the catch sets the inline error. The thrown ApiError is an Error
	// instance, so startConnect surfaces the server's own message.
	const connectBtn = await r.findByTestId('github-connect', undefined, { timeout: 20_000 });
	await r.user.click(connectBtn);
	await r.findByText('connector setup failed');
});
