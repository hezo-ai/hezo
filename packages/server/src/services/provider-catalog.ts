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

import { AI_PROVIDER_INFO, AiAuthMethod, type AiProvider } from '@hezo/shared';

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
 *
 * `authMethod` picks which header shape the credential goes on, because a
 * subscription token is not an API key and the two are not interchangeable on
 * the same header. Which shape a provider has is a row in its own table entry
 * (`subscriptionHeaders`), never a provider name tested here; a provider with no
 * such row returns null for a subscription, which reads as `unsupported`.
 */
export function resolveCatalogEndpoint(
	provider: AiProvider,
	credentialValue: string,
	baseUrl: string | null | undefined,
	authMethod: AiAuthMethod,
): CatalogEndpoint | null {
	const info = AI_PROVIDER_INFO[provider];
	if (!info) return null;

	if (info.local) {
		// The local runners are api-key only (no `supportsSubscription`), so there is
		// no second header shape to pick between here.
		if (authMethod !== AiAuthMethod.ApiKey) return null;
		const root = (baseUrl?.trim() || info.local.defaultBaseUrl).replace(/\/+$/, '');
		return {
			url: `${root}/v1/models`,
			headers: { Authorization: `Bearer ${credentialValue}` },
		};
	}

	const endpoint = info.verifyEndpoint;
	if (!endpoint) return null;
	const url = typeof endpoint.url === 'function' ? endpoint.url(credentialValue) : endpoint.url;

	if (authMethod === AiAuthMethod.Subscription) {
		const headers = endpoint.subscriptionHeaders?.(credentialValue);
		if (!headers) return null;
		return { url, headers };
	}

	return {
		url,
		headers:
			typeof endpoint.headers === 'function' ? endpoint.headers(credentialValue) : endpoint.headers,
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
	credentialValue: string,
	baseUrl: string | null | undefined,
	authMethod: AiAuthMethod,
): Promise<CatalogProbe> {
	const endpoint = resolveCatalogEndpoint(provider, credentialValue, baseUrl, authMethod);
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

/**
 * Whether a probe is **proof the credential itself is dead**, as opposed to
 * anything else that can go wrong between here and the provider.
 *
 * One home because three callers act on it and must agree: the create route, the
 * Verify button and the runner's re-check after a run died on a rejected
 * credential. Only a provider that answered and refused (401/403) counts.
 *
 * **The asymmetry is the point, and it is not a fallback.** There is one
 * mechanism - ask the provider - and exactly one answer it is allowed to act on.
 * A rejection is authoritative; acceptance is not, because what a *valid*
 * subscription token does on a catalog endpoint is not something Hezo can assert
 * for every provider: it may answer 200, or refuse that endpoint on scope while
 * remaining perfectly good for a run. So a `false` here means "not disproven",
 * never "confirmed working", and no caller may read it as the latter. Built this
 * way round so the probe can only ever catch a dead credential and can never
 * condemn a live one.
 */
export function probeProvesCredentialDead(probe: CatalogProbe): boolean {
	return !probe.ok && probe.reason === 'rejected';
}

/** GET and parse the provider's catalog. Never throws - every failure is a result. */
export async function fetchProviderCatalog(
	provider: AiProvider,
	credentialValue: string,
	baseUrl: string | null | undefined,
	authMethod: AiAuthMethod,
): Promise<CatalogResult> {
	const probe = await probeProviderCatalog(provider, credentialValue, baseUrl, authMethod);
	if (!probe.ok) return probe;
	try {
		return { ok: true, json: await probe.res.json() };
	} catch {
		return { ok: false, reason: 'error' };
	}
}
