import { createTestApp } from '@hezo/server/test/helpers/app';
import { api } from '@hezo/web/lib/api';
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
import { render } from '@testing-library/react';
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
	/** The 12-word master key phrase the test app was enrolled with. */
	mnemonic: string;
	apiBase: (path: string, init?: RequestInit) => Promise<Response>;
	// Source the PGlite type from the server helper so it stays in lockstep with
	// the version server-side seeders (createTestProject) expect — the web tree
	// resolves a newer @electric-sql/pglite whose nominal type is incompatible.
	db: Awaited<ReturnType<typeof createTestApp>>['db'];
	masterKeyManager: Awaited<ReturnType<typeof createTestApp>>['masterKeyManager'];
	// Per-test temp dir backing the server's workspace/worktree layout. Lets
	// specs pre-create `workspace/<repo name>/.git` so repo-sync treats a repo
	// as already cloned instead of attempting a real SSH clone.
	dataDir: string;
}

let activeContext: TestAppContext | null = null;
let realFetch: typeof globalThis.fetch | null = null;
let activeQueryClient: QueryClient | null = null;

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
	// (Hono<Env>, its pglite copy); the web test boundary treats them opaquely.
	activeContext = {
		app: test.app,
		token: test.token,
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

	// Reroute fetch through the in-process Hono app. Bypasses the real network
	// entirely; matches the way the dev Vite proxy forwards /api, /oauth, /mcp,
	// /health, /SKILL.md, and /llms.txt to the server.
	realFetch = globalThis.fetch;
	// Close over the captured fetch rather than reading `realFetch` at call
	// time: a debounced/in-flight request can land after afterEach nulls the
	// module variable, and the late call would then throw inside the server
	// route ("realFetch is not a function") instead of completing quietly.
	const passthroughFetch = realFetch;
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
	if (realFetch) globalThis.fetch = realFetch;
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
	realFetch = null;
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
			<ThemeProvider>
				<RouterProvider router={router} />
			</ThemeProvider>
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
