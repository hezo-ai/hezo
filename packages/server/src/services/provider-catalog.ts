/**
 * Reading a provider's own model catalog.
 *
 * One home because there are now three callers with the same need and different
 * reporting: the models route (which maps each failure to its own HTTP code),
 * credential verification (which only cares whether the key was accepted), and
 * the model-pin refresh (which runs on a cron and treats every failure the
 * same). The endpoint resolution in particular must not be restated - a hosted
 * provider's is a fixed table entry while a local runner's is built from the
 * operator's own base URL, and getting that split wrong is silent.
 */

import { AI_PROVIDER_INFO, type AiProvider } from '@hezo/shared';

export interface CatalogEndpoint {
	url: string;
	headers: Record<string, string>;
}

/**
 * Resolve the catalog endpoint used both to verify a credential and to list a
 * provider's models. Hosted providers use their fixed `verifyEndpoint`; a
 * locally-hosted one (Ollama, LM Studio) has no fixed endpoint, so the URL is
 * built from the operator's configured base URL, falling back to the runner's
 * documented default port. Both runners expose the OpenAI-shaped `/v1/models`,
 * which `parseProviderModels` already handles via its generic `data[]` branch.
 */
export function resolveCatalogEndpoint(
	provider: AiProvider,
	apiKey: string,
	baseUrl?: string | null,
): CatalogEndpoint | null {
	const info = AI_PROVIDER_INFO[provider];
	if (!info) return null;

	if (info.local) {
		const root = (baseUrl?.trim() || info.local.defaultBaseUrl).replace(/\/+$/, '');
		return {
			url: `${root}/v1/models`,
			headers: { Authorization: `Bearer ${apiKey}` },
		};
	}

	const endpoint = info.verifyEndpoint;
	if (!endpoint) return null;
	return {
		url: typeof endpoint.url === 'function' ? endpoint.url(apiKey) : endpoint.url,
		headers: typeof endpoint.headers === 'function' ? endpoint.headers(apiKey) : endpoint.headers,
	};
}

/**
 * Why a catalog read failed, at the granularity callers actually branch on.
 *
 * `rejected` is separated from `error` because it is the one an operator can act
 * on - the credential is wrong - and the route turns it into a 401 rather than a
 * 503. Everything else is the provider's problem or the network's.
 */
export type CatalogFailure = 'unsupported' | 'unreachable' | 'rejected' | 'error';

export type CatalogResult =
	| { ok: true; json: unknown }
	| { ok: false; reason: CatalogFailure; status?: number };

const CATALOG_TIMEOUT_MS = 10_000;

export type CatalogProbe =
	| { ok: true; res: Response }
	| { ok: false; reason: CatalogFailure; status?: number };

/**
 * Call the catalog endpoint and classify the outcome, **without reading the
 * body**.
 *
 * Separate from {@link fetchProviderCatalog} because verifying a credential only
 * asks whether the provider accepted it. Parsing there would be work nobody
 * needs, and it would make verification fail on a provider that answers 200 with
 * a body shape we do not recognise - a stricter bar than "the key works".
 */
export async function probeProviderCatalog(
	provider: AiProvider,
	apiKey: string,
	baseUrl?: string | null,
): Promise<CatalogProbe> {
	const endpoint = resolveCatalogEndpoint(provider, apiKey, baseUrl);
	if (!endpoint) return { ok: false, reason: 'unsupported' };

	let res: Response;
	try {
		res = await fetch(endpoint.url, {
			method: 'GET',
			headers: endpoint.headers,
			signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
		});
	} catch {
		// For a local provider this is the expected error when the operator's server
		// simply is not running, which is exactly what `unreachable` conveys.
		return { ok: false, reason: 'unreachable' };
	}

	if (!res.ok) {
		if (res.status === 401 || res.status === 403) {
			return { ok: false, reason: 'rejected', status: res.status };
		}
		return { ok: false, reason: 'error', status: res.status };
	}
	return { ok: true, res };
}

/** GET and parse the provider's catalog. Never throws - every failure is a result. */
export async function fetchProviderCatalog(
	provider: AiProvider,
	apiKey: string,
	baseUrl?: string | null,
): Promise<CatalogResult> {
	const probe = await probeProviderCatalog(provider, apiKey, baseUrl);
	if (!probe.ok) return probe;
	try {
		return { ok: true, json: await probe.res.json() };
	} catch {
		return { ok: false, reason: 'error' };
	}
}
