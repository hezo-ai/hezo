/**
 * Pre-ready request handling.
 *
 * Until `startup()` finishes, the Bun fetch entry in `index.ts` can't serve the
 * real Hono app. Rather than answer every request with a raw JSON 503 (which a
 * browser renders as bare error text), we serve the SPA shell to browsers and a
 * live `/api/status` so the web UI shows a loading screen naming the current
 * boot phase. Machine surfaces (`/api/*`, `/mcp*`, `/ws`, agent manifests) still
 * get a JSON 503 STARTING so they retry.
 */

import type { StartupProgress } from './startup-progress';
import type { StaticAsset } from './static-assets';
import { HEZO_VERSION } from './version';

/** JSON 503 for machine clients — they should retry until the server is ready. */
export function startingResponse(): Response {
	return Response.json(
		{ error: { code: 'STARTING', message: 'Server is starting — retry in a moment' } },
		{ status: 503 },
	);
}

export interface StartupServingDeps {
	progress: StartupProgress;
	/** Loads the embedded SPA bundle; `null` in dev where Vite serves the SPA. */
	loadBundle: () => Promise<Map<string, StaticAsset> | null>;
}

/** Paths that must keep machine-readable JSON semantics while booting. */
function isMachinePath(path: string): boolean {
	return (
		path.startsWith('/api/') ||
		path === '/mcp' ||
		path.startsWith('/mcp/') ||
		path === '/ws' ||
		path === '/SKILL.md' ||
		path === '/llms.txt'
	);
}

/**
 * Build the response for a request that arrives before the server is ready.
 * Pure and dependency-injected so it can be unit-tested without booting Bun.
 */
export async function serveStartupRequest(
	req: Request,
	deps: StartupServingDeps,
): Promise<Response> {
	const path = new URL(req.url).pathname;

	// Always answer health so liveness probes don't flap during boot.
	if (path === '/health') {
		return Response.json({ ok: true });
	}

	// The web UI polls this while booting; answer 200 with the live phase so it
	// renders a progress screen instead of treating it as an error.
	//
	// Deliberately carries no `locale`: the database isn't open yet, so there is
	// nothing to read it from. The client treats locale as optional here and
	// renders the boot screen from its stored render hint until the real status
	// handler takes over.
	if (path === '/api/status') {
		const { phase, message, detail } = deps.progress;
		return Response.json({ starting: true, phase, message, detail, version: HEZO_VERSION });
	}

	// Other API/MCP/WebSocket surfaces stay machine-readable so clients retry.
	if (isMachinePath(path)) {
		return startingResponse();
	}

	// Everything else is a browser navigation or static asset. Serve the SPA shell
	// from the embedded bundle so the web UI loads (and then polls /api/status).
	// In dev the bundle is absent — Vite serves the SPA on another port — so fall
	// back to the JSON 503.
	const bundle = await deps.loadBundle();
	if (!bundle) return startingResponse();
	const asset = bundle.get(path) ?? bundle.get('/index.html');
	if (!asset) return startingResponse();
	return new Response(asset.body, { headers: { 'Content-Type': asset.type } });
}
