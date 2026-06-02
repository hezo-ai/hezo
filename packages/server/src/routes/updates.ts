import { Hono } from 'hono';
import { logger } from '../logger';
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

export const updatesRoutes = new Hono();

updatesRoutes.get('/updates/latest', async (c) => {
	if (!cache || Date.now() - cache.at >= TTL_MS) {
		cache = { at: Date.now(), data: await fetchLatest() };
	}
	return c.json(cache.data);
});
