/**
 * The models a stored credential can run, read live from its provider each time
 * someone looks.
 *
 * An API key lists through its provider's catalog endpoint. A subscription is the
 * case this module exists for: the list a person picks a default model from must
 * be the list that sign-in can actually run, and a CLI upgrade can change it.
 * Leaving a subscription with no model let its CLI choose, and one upgrade moved
 * a whole fleet onto a model that spends an allowance about twice as fast.
 *
 * How a subscription lists is the provider's own, so it is a row in
 * {@link SUBSCRIPTION_MODEL_LISTERS}:
 *
 * - **Anthropic** answers its catalog endpoint for a subscription token on the
 *   header shape its table row already names, so it lists like an API key.
 * - **OpenAI (Codex)** lists through the endpoint the Codex CLI itself uses, on
 *   the ChatGPT backend, with the stored sign-in's access token and the pinned
 *   CLI version - so the list is exactly what the pinned CLI supports. The access
 *   token is short-lived and the stored sign-in may have sat idle past it, so an
 *   expired one is renewed the way the CLI renews it and written back through the
 *   same compare-and-set a run's rotated sign-in uses.
 *
 * Kept apart from `provider-catalog.ts`, which asks providers and must not know
 * there is a database: renewing a sign-in writes one.
 */

import { AiAuthMethod, AiProvider, type AiProviderModel, parseProviderModels } from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import { logger } from '../logger';
import { casUpdateAiProviderCredential, getProviderConfigCredential } from './ai-provider-keys';
import { type CatalogFailure, fetchProviderCatalog } from './provider-catalog';
import { CODEX_CLI_VERSION } from './runtime-adapters/codex';
import type { CodexAuthBlob } from './subscription-auth';

const log = logger.child('credential-models');

export type CredentialModels =
	| { ok: true; models: AiProviderModel[] }
	| { ok: false; reason: CatalogFailure; status?: number; detail?: string };

/** A stored credential, as a lister reads it. */
interface StoredCredential {
	configId: string;
	provider: AiProvider;
	authMethod: AiAuthMethod;
	value: string;
	baseUrl: string | null;
}

type SubscriptionModelLister = (
	deps: { db: Db; masterKeyManager: MasterKeyManager },
	credential: StoredCredential,
) => Promise<CredentialModels>;

/** How long a model-list request may take before it reads as unreachable. */
const LIST_TIMEOUT_MS = 10_000;

/** The Codex CLI's ChatGPT backend, where it lists and runs models on a subscription. */
const CODEX_BACKEND_URL = 'https://chatgpt.com/backend-api/codex';

/** Where the Codex CLI renews a ChatGPT sign-in, and the public client id it renews as. */
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** An access token this close to expiry is renewed before use, as the CLI does. */
const ACCESS_TOKEN_SKEW_MS = 60_000;

/** List through the provider's catalog endpoint, the way an API key does. */
const catalogLister: SubscriptionModelLister = async (_deps, credential) => {
	const catalog = await fetchProviderCatalog(
		credential.provider,
		credential.value,
		credential.baseUrl,
		credential.authMethod,
	);
	if (!catalog.ok) return catalog;
	return { ok: true, models: parseProviderModels(credential.provider, catalog.json) };
};

/** When a JWT expires, from its unverified payload; null when it states none. */
function jwtExpiresAt(token: string): number | null {
	const part = token.split('.')[1];
	if (!part) return null;
	try {
		const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as {
			exp?: unknown;
		};
		return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
	} catch {
		return null;
	}
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response | null> {
	try {
		return await fetch(url, { ...init, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
	} catch {
		return null;
	}
}

/**
 * A Codex sign-in with a usable access token: the stored one while it is valid,
 * else a renewed one, written back. Null with a reason when neither is possible.
 */
async function freshCodexSignIn(
	deps: { db: Db; masterKeyManager: MasterKeyManager },
	credential: StoredCredential,
): Promise<
	{ ok: true; blob: CodexAuthBlob } | { ok: false; reason: CatalogFailure; detail: string }
> {
	let blob: CodexAuthBlob;
	try {
		blob = JSON.parse(credential.value) as CodexAuthBlob;
	} catch {
		return { ok: false, reason: 'rejected', detail: 'the stored sign-in is not valid JSON' };
	}
	const access = blob.tokens?.access_token;
	const expiresAt = access ? jwtExpiresAt(access) : null;
	if (access && (expiresAt === null || expiresAt - ACCESS_TOKEN_SKEW_MS > Date.now())) {
		return { ok: true, blob };
	}

	const res = await fetchWithTimeout(CODEX_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			client_id: CODEX_CLIENT_ID,
			grant_type: 'refresh_token',
			refresh_token: blob.tokens.refresh_token,
		}),
	});
	if (!res)
		return { ok: false, reason: 'unreachable', detail: 'could not reach the sign-in service' };
	if (res.status === 400 || res.status === 401) {
		return {
			ok: false,
			reason: 'rejected',
			detail: 'the sign-in has expired or been revoked; sign in again',
		};
	}
	if (!res.ok)
		return { ok: false, reason: 'error', detail: `sign-in renewal answered ${res.status}` };

	const renewed = (await res.json().catch(() => null)) as {
		access_token?: string;
		id_token?: string;
		refresh_token?: string;
	} | null;
	if (!renewed?.access_token) {
		return { ok: false, reason: 'error', detail: 'sign-in renewal returned no access token' };
	}
	const next: CodexAuthBlob = {
		...blob,
		tokens: {
			...blob.tokens,
			access_token: renewed.access_token,
			...(renewed.id_token ? { id_token: renewed.id_token } : {}),
			...(renewed.refresh_token ? { refresh_token: renewed.refresh_token } : {}),
		},
		last_refresh: new Date().toISOString(),
	};
	const stored = await casUpdateAiProviderCredential(
		deps.db,
		deps.masterKeyManager,
		credential.configId,
		credential.value,
		JSON.stringify(next),
	);
	if (!stored) {
		// A run rotated the sign-in while this renewed it. Both successors are valid;
		// the store keeps the run's, and this request uses its own.
		log.debug(`Codex sign-in ${credential.configId} moved during renewal; keeping the stored one`);
	}
	return { ok: true, blob: next };
}

/** The models a Codex sign-in can run, from the backend the Codex CLI lists from. */
const codexSubscriptionLister: SubscriptionModelLister = async (deps, credential) => {
	const signIn = await freshCodexSignIn(deps, credential);
	if (!signIn.ok) return signIn;
	const { access_token: access, account_id: accountId } = signIn.blob.tokens;
	const res = await fetchWithTimeout(
		`${CODEX_BACKEND_URL}/models?client_version=${encodeURIComponent(CODEX_CLI_VERSION)}`,
		{
			headers: {
				Authorization: `Bearer ${access}`,
				...(accountId ? { 'ChatGPT-Account-ID': accountId } : {}),
			},
		},
	);
	if (!res) return { ok: false, reason: 'unreachable' };
	if (res.status === 401 || res.status === 403) {
		return { ok: false, reason: 'rejected', status: res.status };
	}
	if (!res.ok) return { ok: false, reason: 'error', status: res.status };
	const body = (await res.json().catch(() => null)) as { models?: unknown } | null;
	return { ok: true, models: parseCodexBackendModels(body) };
};

/**
 * The models a Codex backend listing offers a person to pick: those it marks
 * `list`, in its own priority order. `hide` and `none` are models the CLI's own
 * picker leaves out.
 */
export function parseCodexBackendModels(body: unknown): AiProviderModel[] {
	const models = (body as { models?: unknown } | null)?.models;
	if (!Array.isArray(models)) return [];
	return models
		.filter(
			(
				m,
			): m is { slug: string; display_name?: unknown; visibility?: unknown; priority?: unknown } =>
				!!m && typeof m === 'object' && typeof (m as { slug?: unknown }).slug === 'string',
		)
		.filter((m) => m.visibility === undefined || m.visibility === 'list')
		.sort(
			(a, b) =>
				(typeof a.priority === 'number' ? a.priority : 0) -
				(typeof b.priority === 'number' ? b.priority : 0),
		)
		.map((m) => ({
			id: m.slug,
			label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.slug,
		}));
}

/**
 * How each provider with a subscription lists that subscription's models. A
 * provider with a subscription must have a row: listing is how its default model
 * is chosen, and a subscription with no way to list it could not be given one.
 */
const SUBSCRIPTION_MODEL_LISTERS: Partial<Record<AiProvider, SubscriptionModelLister>> = {
	[AiProvider.Anthropic]: catalogLister,
	[AiProvider.OpenAI]: codexSubscriptionLister,
};

/**
 * The models a stored credential can run, or why they could not be read. Null
 * when no credential has that id.
 */
export async function listCredentialModels(
	deps: { db: Db; masterKeyManager: MasterKeyManager },
	configId: string,
): Promise<CredentialModels | null> {
	const stored = await getProviderConfigCredential(deps.db, deps.masterKeyManager, configId);
	if (!stored) return null;
	const credential: StoredCredential = {
		configId,
		provider: stored.provider as AiProvider,
		authMethod: stored.authMethod,
		value: stored.value,
		baseUrl: stored.baseUrl,
	};
	const lister =
		credential.authMethod === AiAuthMethod.Subscription
			? SUBSCRIPTION_MODEL_LISTERS[credential.provider]
			: catalogLister;
	if (!lister) return { ok: false, reason: 'unsupported' };
	return lister(deps, credential);
}
