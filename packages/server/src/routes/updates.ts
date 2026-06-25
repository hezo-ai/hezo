import { UPDATE_RESTART_EXIT_CODE, UpdateState } from '@hezo/shared';
import { Hono } from 'hono';
import { trackBackground } from '../lib/background';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireSuperuser } from '../middleware/auth';
import { getActiveRuntime, shutdownRuntime } from '../runtime-control';
import {
	downloadAndStage,
	ensureUpdateStaged,
	isSupervisedWorker,
	readUpdateState,
} from '../services/updater';
import { HEZO_VERSION } from '../version';

const log = logger.child('updates');

/** The repo whose GitHub Releases this build checks for updates. */
const REPO = 'hezo-ai/hezo';
/** Cache the upstream check for an hour — GitHub rate-limits anonymous calls. */
const TTL_MS = 60 * 60 * 1000;

export interface UpdateInfo {
	current: string;
	latest: string | null;
	updateAvailable: boolean;
	url: string | null;
}

let cache: { at: number; data: UpdateInfo } | null = null;

/** Parse a plain `MAJOR.MINOR.PATCH` tag (no `v` prefix, matching our releases). */
function parseSemver(v: string): [number, number, number] | null {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `latest` is strictly greater than `current`. */
export function isNewer(latest: string, current: string): boolean {
	const a = parseSemver(latest);
	const b = parseSemver(current);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] > b[i];
	}
	return false;
}

async function fetchLatest(): Promise<UpdateInfo> {
	const base: UpdateInfo = {
		current: HEZO_VERSION,
		latest: null,
		updateAvailable: false,
		url: null,
	};
	try {
		const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
			headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hezo' },
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return base;
		const body = (await res.json()) as { tag_name?: string; html_url?: string };
		const latest = body.tag_name ?? null;
		return {
			...base,
			latest,
			url: body.html_url ?? null,
			updateAvailable: latest ? isNewer(latest, HEZO_VERSION) : false,
		};
	} catch (err) {
		// Fail soft: no network / egress / rate limit → report "no update".
		log.warn('update check failed', err);
		return base;
	}
}

/** Cached latest-release info (1h TTL), shared by the route and the update-check cron. */
export async function getLatestInfo(): Promise<UpdateInfo> {
	if (!cache || Date.now() - cache.at >= TTL_MS) {
		cache = { at: Date.now(), data: await fetchLatest() };
	}
	return cache.data;
}

/**
 * Build the updates router. `autoUnlock` reflects whether a master key is
 * configured at startup (env/CLI) — when true the instance auto-unlocks after a
 * restart, so the UI can soften the "you'll need your master key" warning.
 */
export function buildUpdatesRoutes(opts: { autoUnlock: boolean }): Hono<Env> {
	const routes = new Hono<Env>();

	// Any authed user: passive "is an update available" check (banner + settings).
	routes.get('/updates/latest', async (c) => c.json(await getLatestInfo()));

	// Any authed user: latest info + staged-update lifecycle + auto-unlock hint.
	routes.get('/updates/status', async (c) => {
		const dataDir = c.get('dataDir');
		const [latest, state] = await Promise.all([getLatestInfo(), readUpdateState(dataDir)]);
		// Kick a background download as soon as the UI knows an update exists, so the
		// banner's "Install & restart" is instant. Idempotent — repeated polls no-op.
		if (isSupervisedWorker()) {
			trackBackground(
				ensureUpdateStaged(dataDir, getLatestInfo).catch((e) =>
					log.error('auto-stage trigger failed', e),
				),
			);
		}
		return c.json({
			...latest,
			state: state.state,
			targetVersion: state.targetVersion ?? null,
			error: state.error ?? null,
			autoUnlock: opts.autoUnlock,
			canApply: isSupervisedWorker(),
		});
	});

	// Superuser: kick a background download+verify+stage of the latest release.
	routes.post('/updates/download', async (c) => {
		const denied = requireSuperuser(c);
		if (denied) return denied;
		if (!isSupervisedWorker()) {
			return err(c, 'UPDATE_UNAVAILABLE', 'Auto-update is not available in this environment', 409);
		}
		const latest = await getLatestInfo();
		if (!latest.updateAvailable || !latest.latest) {
			return err(c, 'NO_UPDATE', 'No newer release is available', 409);
		}
		const dataDir = c.get('dataDir');
		const version = latest.latest;
		trackBackground(
			downloadAndStage(version, dataDir).catch((e) => log.error('download/stage failed', e)),
		);
		return c.json({ data: { state: UpdateState.Downloading, targetVersion: version } }, 202);
	});

	// Superuser: shut down gracefully and exit with the restart sentinel so the
	// supervisor applies the staged binary and relaunches. Responds *before*
	// exiting so the HTTP response flushes.
	routes.post('/updates/apply', async (c) => {
		const denied = requireSuperuser(c);
		if (denied) return denied;
		if (!isSupervisedWorker()) {
			return err(c, 'UPDATE_UNAVAILABLE', 'Auto-update is not available in this environment', 409);
		}
		const dataDir = c.get('dataDir');
		const state = await readUpdateState(dataDir);
		if (state.state !== UpdateState.Staged) {
			return err(c, 'NO_STAGED_UPDATE', 'No staged update to apply', 409);
		}
		setTimeout(() => {
			void (async () => {
				const runtime = getActiveRuntime();
				try {
					if (runtime) await shutdownRuntime(runtime);
				} catch (e) {
					log.error('shutdown before update-apply failed', e);
				}
				log.info('Exiting with restart sentinel to apply staged update');
				process.exit(UPDATE_RESTART_EXIT_CODE);
			})();
		}, 100);
		return ok(c, { state: UpdateState.Applying, targetVersion: state.targetVersion ?? null });
	});

	return routes;
}
