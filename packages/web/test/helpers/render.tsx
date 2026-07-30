import { createTestApp } from '@hezo/server/test/helpers/app';
import { Toaster } from '@hezo/web/components/ui/toast';
import { api } from '@hezo/web/lib/api';
import { I18nProvider } from '@hezo/web/lib/i18n';
import { queryClient as singletonQueryClient } from '@hezo/web/lib/query-client';
import { ThemeProvider } from '@hezo/web/lib/theme';
// __root.tsx re-wraps the React tree with the singleton query client, so any
// hooks that read via useQuery actually pull from that singleton (not the one
// renderApp creates). To stop one test's cache (ui-state, projects, …) from
// leaking into the next, drop entries for the cache keys whose stale data
// flips component branches between tests — the renderApp QueryClient handles
// the rest.
import { routeTree } from '@hezo/web/routeTree.gen';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
	createMemoryHistory,
	createRouter,
	Navigate,
	RouterProvider,
} from '@tanstack/react-router';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Hono } from 'hono';
import { StrictMode } from 'react';
import { afterEach, beforeEach } from 'vitest';

interface RenderOptions {
	initialPath: string;
	// Caller can seed the test DB before the app mounts — runs after the test
	// app boots and gets the auth token, so seeders can hit the API or DB.
	seed?: (ctx: TestAppContext) => Promise<unknown> | unknown;
	// Wrap the tree in <StrictMode> to exercise React's mount→cleanup→mount
	// double-invoke (the real app runs under StrictMode via main.tsx). Off by
	// default to keep existing specs unchanged; opt in where effect resilience
	// across remount matters (e.g. the deep-link scroll).
	strictMode?: boolean;
}

interface TestAppContext {
	app: Hono;
	token: string;
	/** The seeded admin's plaintext password (verifier enrolled in createTestApp). */
	password: string;
	/** The 12-word master key phrase the test app was enrolled with. */
	mnemonic: string;
	apiBase: (path: string, init?: RequestInit) => Promise<Response>;
	// Source the Db type from the server helper so it stays in lockstep with
	// what server-side seeders (createTestProject) expect.
	db: Awaited<ReturnType<typeof createTestApp>>['db'];
	masterKeyManager: Awaited<ReturnType<typeof createTestApp>>['masterKeyManager'];
	// Per-test temp dir backing the server's workspace/worktree layout. Lets
	// specs pre-create `workspace/<repo name>/.git` so repo-sync treats a repo
	// as already cloned instead of attempting a real SSH clone.
	dataDir: string;
}

let activeContext: TestAppContext | null = null;
let activeQueryClient: QueryClient | null = null;

// Captured once, before any test installs its override, so each test's
// passthrough is the environment's own fetch rather than the previous test's
// teardown stub.
const pristineFetch = globalThis.fetch;

/**
 * The fetch a torn-down test is left with. The React tree is unmounted by then,
 * but debounced and in-flight requests from it can still fire; handing those the
 * real fetch dials happy-dom's default origin, and the connection error arrives
 * as an unhandled rejection that can fail a run in which every test passed.
 * Answering locally keeps the failure contained to the caller that is no longer
 * listening.
 */
function tornDownFetch(): Promise<Response> {
	return Promise.resolve(
		new Response(JSON.stringify({ error: 'test context torn down' }), {
			status: 503,
			headers: { 'Content-Type': 'application/json' },
		}),
	);
}

// One test app per test. Vitest runs in pool=forks with isolate=true so the
// server module state (logger, etc.) doesn't leak; the only thing that lives
// across tests in the same file is the singleton api client, which we reset.
beforeEach(async () => {
	const test = await createTestApp();
	const apiBase = (path: string, init?: RequestInit) => {
		const url = path.startsWith('http') ? path : `http://localhost${path}`;
		return test.app.fetch(new Request(url, init));
	};
	// The server app/db come from the server package's own type instances
	// (Hono<Env>, its Db driver); the web test boundary treats them opaquely.
	activeContext = {
		app: test.app,
		token: test.token,
		password: test.password,
		mnemonic: test.mnemonic,
		apiBase,
		db: test.db,
		masterKeyManager: test.masterKeyManager,
		dataDir: test.dataDir,
	} as unknown as TestAppContext;

	// Auth: drop the token into localStorage AND push it into the api singleton
	// (the latter snapshotted localStorage at module-load time, so a later
	// localStorage.setItem alone wouldn't update it).
	localStorage.setItem('hezo_token', test.token);
	api.setToken(test.token);

	// Seed an AI-provider config so the SetupGate doesn't park the tree on the
	// onboarding wizard. Mirrors the e2e ensureAiProviderConfigured helper.
	await apiBase('/api/ai-providers', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${test.token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			provider: 'anthropic',
			api_key: 'sk-ant-test-key',
			label: 'test-default',
		}),
	});

	// A booted instance has its HQ container running; the harness skips real
	// container provisioning, so reflect the healthy steady state by default.
	// Specs exercising the container-down/rebuilding gates set the status
	// explicitly (via DB or a fetch override of the projects index).
	await test.db.query(
		`UPDATE projects SET container_status = 'running',
		        container_id = COALESCE(container_id, 'test-hq-container')
		 WHERE is_internal = true`,
	);

	// Reroute fetch through the in-process Hono app. Bypasses the real network
	// entirely; matches the way the dev Vite proxy forwards /api, /oauth, /mcp,
	// /health, /SKILL.md, and /llms.txt to the server.
	const passthroughFetch = pristineFetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		let req: Request;
		if (input instanceof Request) {
			req = input;
		} else {
			const urlStr = typeof input === 'string' ? input : input.toString();
			const absolute = urlStr.startsWith('http') ? urlStr : `http://localhost${urlStr}`;
			req = new Request(absolute, init);
		}
		const path = new URL(req.url).pathname;
		// Short-circuit the update-check endpoints so no component test reaches the
		// real GitHub Releases API. Otherwise every mounted <UpdateBanner> fires a
		// fetch that 403-rate-limits and is aborted at teardown — spamming
		// `<updates> update check failed` warnings and "Response is not defined"
		// route errors. Both routes return their payload raw (api.request passes it
		// through), so a static "no update available" body keeps the banner inert.
		// Tests that need a specific version/update seed the query cache directly
		// (see settings-version.test.tsx), so `current` here is cosmetic.
		if (
			path === '/api/updates/latest' ||
			path === '/api/updates/status' ||
			path === '/api/updates/check'
		) {
			const base = { current: '0.0.0-test', latest: null, updateAvailable: false, url: null };
			const body =
				path === '/api/updates/status'
					? {
							...base,
							state: 'idle',
							targetVersion: null,
							error: null,
							autoUnlock: false,
							canApply: false,
						}
					: base;
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		if (
			path.startsWith('/api') ||
			path.startsWith('/oauth') ||
			path.startsWith('/mcp') ||
			path.startsWith('/health') ||
			path === '/SKILL.md' ||
			path === '/llms.txt'
		) {
			return test.app.fetch(req);
		}
		// Unknown path — fall back to the real fetch (which will likely fail in
		// happy-dom, which is what we want: it should surface as a test bug).
		return passthroughFetch(req);
	}) as typeof globalThis.fetch;
});

afterEach(async () => {
	// Let work the just-unmounted tree started settle while its token and app are
	// still valid. A request that lands after `api.clearToken()` below comes back
	// 401 with nobody listening, and one unhandled rejection fails the whole run
	// even when every test passed. Mutations are dropped outright — an in-flight
	// save has no one left to report to.
	activeQueryClient?.getMutationCache().clear();
	singletonQueryClient.getMutationCache().clear();
	await Promise.all([activeQueryClient?.cancelQueries(), singletonQueryClient.cancelQueries()]);
	await new Promise((resolve) => setTimeout(resolve, 0));

	globalThis.fetch = tornDownFetch as typeof globalThis.fetch;
	if (activeQueryClient) {
		activeQueryClient.clear();
		activeQueryClient = null;
	}
	// __root.tsx wraps the tree with the singleton query client, so its cache
	// outlives the per-test activeQueryClient created above and survives the
	// PGlite swap that beforeEach does. Flush it between tests so the next
	// test doesn't read a stale team / project / settings response from the
	// previous PGlite instance.
	singletonQueryClient.clear();
	localStorage.clear();
	api.clearToken();
	if (activeContext?.db) {
		try {
			await activeContext.db.close();
		} catch {
			// PGlite close races with in-flight queries from the just-unmounted
			// React tree; swallow the resulting "PGlite is closing" so the test
			// outcome isn't marked failed for cleanup noise.
		}
	}
	activeContext = null;
});

export function getTestContext(): TestAppContext {
	if (!activeContext) {
		throw new Error('No active test context — call inside a test/beforeEach hook');
	}
	return activeContext;
}

export async function renderApp(options: RenderOptions) {
	const ctx = getTestContext();
	if (options.seed) await options.seed(ctx);

	// Fresh QueryClient per test so cached responses from one test don't bleed
	// into the next (Vitest's per-test isolation handles modules but not the
	// queryClient singleton imported by __root.tsx).
	activeQueryClient = new QueryClient({
		defaultOptions: {
			queries: { staleTime: 0, retry: false, refetchOnWindowFocus: false },
		},
	});

	const history = createMemoryHistory({ initialEntries: [options.initialPath] });
	const router = createRouter({
		routeTree,
		history,
		defaultNotFoundComponent: () => <Navigate to="/home" replace />,
	});

	const tree = (
		<QueryClientProvider client={activeQueryClient}>
			{/* Mirrors main.tsx, where I18nProvider wraps ThemeProvider so it also
			    covers the Toaster. */}
			<I18nProvider>
				<ThemeProvider>
					<RouterProvider router={router} />
					{/* Mirrors main.tsx: the Toaster mounts beside (not inside) the
					    router, so toast assertions work like production. */}
					<Toaster />
				</ThemeProvider>
			</I18nProvider>
		</QueryClientProvider>
	);
	const utils = render(options.strictMode ? <StrictMode>{tree}</StrictMode> : tree);

	return {
		...utils,
		user: userEvent.setup({ delay: null }),
		ctx,
		router,
	};
}

type UserLike = {
	click: (element: Element) => Promise<void>;
	hover: (element: Element) => Promise<void>;
};

interface ClickUntilOptions {
	timeout?: number;
	/** Name used in the timeout message. */
	label?: string;
}

/**
 * Click a target whose DOM node a background refetch may replace, and keep
 * clicking a freshly located node until the effect is observable.
 *
 * A query hands back a node reference, but a React Query refetch can re-render
 * that subtree before the click dispatches — leaving the test holding a
 * detached node whose handler never fires. The click silently does nothing and
 * the assertion that follows fails on a timeout that looks like slowness rather
 * than a lost event. Re-locating on every attempt removes the window entirely.
 *
 * `locate` must return the current node (never a captured one) and `settled`
 * must report the click's observable effect. The trigger has to be idempotent,
 * since a replaced node can be clicked more than once — this is for "open this
 * panel" affordances, not toggles.
 */
export async function clickUntil(
	user: UserLike,
	locate: () => Element | null,
	settled: () => boolean,
	options: ClickUntilOptions = {},
): Promise<void> {
	await interactUntil((el) => user.click(el), 'clicking', locate, settled, options);
}

/** `clickUntil` for hover-driven affordances (tooltips, hover cards). */
export async function hoverUntil(
	user: UserLike,
	locate: () => Element | null,
	settled: () => boolean,
	options: ClickUntilOptions = {},
): Promise<void> {
	await interactUntil((el) => user.hover(el), 'hovering', locate, settled, options);
}

async function interactUntil(
	act: (element: Element) => Promise<void>,
	verb: string,
	locate: () => Element | null,
	settled: () => boolean,
	options: ClickUntilOptions,
): Promise<void> {
	const label = options.label ?? 'the target';
	await waitFor(
		async () => {
			if (settled()) return;
			const target = locate();
			if (!target?.isConnected) throw new Error(`${label} is not mounted yet`);
			await act(target);
			if (!settled()) throw new Error(`${verb} ${label} has not taken effect yet`);
		},
		{ timeout: options.timeout ?? 15_000 },
	);
}
