/**
 * Keeps each provider's default model current in a **running** instance.
 *
 * The rule and the per-provider families live in `@hezo/shared`
 * (`model-pins.ts`); this is the half that needs a database and a network: read
 * each configured provider's live catalog, pick the newest id in its family, and
 * record it.
 *
 * **A pin only ever supplies a default to a NEW credential.** Nothing here
 * writes `ai_provider_configs.default_model` for a row that already exists - an
 * operator's model choice is theirs until they change it, and a refresh that
 * moved running agents onto a new model would be a silent, instance-wide
 * behaviour change nobody asked for.
 *
 * **Why the catalog and not a constant.** A hardcoded id cannot notice its own
 * retirement. an unsupported judge model stayed pinned long after
 * Google withdrew it: the judge call 404'd on every run and the hook failed
 * open, with nothing in the run looking wrong. Reading the provider's own
 * catalog is the only thing that keeps a pin true.
 *
 * Best-effort throughout, and deliberately so: this runs on a cron against
 * third-party endpoints, so an unreachable provider, a rejected key or a
 * renamed family leaves the previous pin in place rather than failing the tick
 * or clearing the pin.
 */

import {
	AiAuthMethod,
	type AiProvider,
	ALL_AI_PROVIDERS,
	fallbackPinnedModel,
	MODEL_PIN_SPECS,
	parseProviderModels,
	pickLatestModel,
} from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import { getSystemMeta, setSystemMeta } from '../lib/system-meta';
import { logger } from '../logger';
import { getProviderConfigCredential } from './ai-provider-keys';
import { fetchProviderCatalog } from './provider-catalog';

const log = logger.child('model-pins');

/** One row per provider, so a refresh touches only the provider it re-read. */
function pinKey(provider: AiProvider): string {
	return `model_pin:${provider}`;
}

/**
 * The model a newly-added credential for this provider should start on.
 *
 * The refreshed pin when there is one, else the compile-time fallback. Null for
 * a provider with no pin at all - the local runners, whose catalog is whatever
 * the operator has pulled, where the CLI's own default is the honest answer.
 */
export async function getPinnedModel(db: Db, provider: AiProvider): Promise<string | null> {
	const stored = (await getSystemMeta(db, pinKey(provider)))?.trim();
	return stored || fallbackPinnedModel(provider);
}

export interface ModelPinRefreshResult {
	/** Providers whose pin moved, as `<provider>: <old> → <new>`. */
	changed: string[];
	/** Providers read successfully whose pin was already current. */
	unchanged: number;
	/** Providers that could not be read, with why. */
	skipped: string[];
}

/**
 * Re-read every configured provider's catalog and move its pin to the newest
 * model in its family.
 *
 * Only providers with a stored credential are reachable - there is no catalog to
 * read without one - so a provider nobody has configured keeps its compile-time
 * fallback until the first credential for it is added.
 */
export async function refreshModelPins(
	db: Db,
	masterKeyManager: MasterKeyManager,
): Promise<ModelPinRefreshResult> {
	const result: ModelPinRefreshResult = { changed: [], unchanged: 0, skipped: [] };
	if (!masterKeyManager.getKey()) {
		result.skipped.push('instance locked');
		return result;
	}

	// One config per provider is enough to read a catalog with, and the newest
	// row is the likeliest to carry a working key. Providers with no pin spec are
	// excluded in SQL rather than fetched and discarded.
	const pinnable = ALL_AI_PROVIDERS.filter((p) => MODEL_PIN_SPECS[p]);
	if (pinnable.length === 0) return result;
	const configs = await db.query<{ id: string; provider: string }>(
		`SELECT DISTINCT ON (provider) id, provider
		   FROM ai_provider_configs
		  WHERE provider = ANY($1)
		  ORDER BY provider, created_at DESC`,
		[pinnable],
	);

	for (const row of configs.rows) {
		const provider = row.provider as AiProvider;
		try {
			const cred = await getProviderConfigCredential(db, masterKeyManager, row.id);
			if (!cred) {
				result.skipped.push(`${provider}: credential unreadable`);
				continue;
			}
			// A subscription blob is not an API key the catalog endpoint accepts, so
			// listing would only ever 401. The CLI picks the model in that case anyway.
			if (cred.authMethod === AiAuthMethod.Subscription) {
				result.skipped.push(`${provider}: subscription sign-in has no catalog`);
				continue;
			}
			const catalog = await fetchProviderCatalog(provider, cred.value, cred.baseUrl);
			if (!catalog.ok) {
				result.skipped.push(`${provider}: catalog ${catalog.reason}`);
				continue;
			}
			const ids = parseProviderModels(provider, catalog.json).map((m) => m.id);
			const latest = pickLatestModel(provider, ids);
			if (!latest) {
				// The family matched nothing. Renamed upstream, or this key sees a
				// restricted catalog - either way the previous pin is the better answer
				// than something from a different tier.
				result.skipped.push(`${provider}: no model matched the pinned family`);
				continue;
			}
			const current = await getPinnedModel(db, provider);
			if (current === latest) {
				result.unchanged += 1;
				continue;
			}
			await setSystemMeta(db, pinKey(provider), latest);
			result.changed.push(`${provider}: ${current ?? 'none'} → ${latest}`);
		} catch (e) {
			result.skipped.push(`${provider}: ${(e as Error).message}`);
		}
	}

	if (result.changed.length > 0) log.info(`Model pins moved — ${result.changed.join(', ')}`);
	return result;
}
