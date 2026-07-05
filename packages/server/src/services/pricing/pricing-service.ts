/**
 * Runtime model pricing: the in-memory source of truth for run cost.
 *
 * Loads the `model_pricing` table into a sync lookup map on boot, optionally
 * kicks a background refresh from the pricepertoken.com catalog, and answers
 * `costCents(model, tokens)` with no per-call DB or network. The table starts
 * populated — the `014` migration bakes in a catalog snapshot — and stays
 * current via the boot refresh plus the daily job-manager cron. Operator
 * (`manual`) rows win over feed (`pricepertoken`) rows; an unknown model
 * resolves to `$0` with a one-time warning.
 */

import { type CostTokens, costCentsFromRate, type ModelRate } from '@hezo/shared';
import type { Db } from '../../db/database';
import { trackBackground } from '../../lib/background';
import { logger } from '../../logger';
import { refreshPricingFromPricePerToken } from './refresher';
import { listModelPricing } from './repo';

const log = logger.child('pricing');

/**
 * Normalize a model id for fuzzy lookup. The CLI may emit a provider-prefixed,
 * dated, or context-tagged id (`openai/gpt-5`, `claude-opus-4-8-20260205`,
 * `deepseek-v4-pro[1m]`, `glm-4.7[200k]`) while the feed keys the bare base id —
 * strip those so they resolve to the same rate. The context tag is any bracketed
 * window size (`[1m]`, `[2m]`, `[200k]`, …), not only `[1m]`. Version dots
 * unify to dashes because the catalog and the runtimes disagree on the
 * separator (`claude-opus-4.8` in the catalog, `claude-opus-4-8` from Claude
 * Code) — both sides of the lookup normalize, so either spelling resolves.
 */
export function normalizeModelId(id: string): string {
	let s = id.toLowerCase().trim();
	const slash = s.lastIndexOf('/');
	if (slash >= 0) s = s.slice(slash + 1);
	s = s.replace(/\[[^\]]*\]/g, '');
	s = s.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
	s = s.replaceAll('.', '-');
	return s;
}

/** Model-id segment separators — ids break on dashes and version dots. */
const SEGMENT_SEPARATOR = /[-.]/;

/**
 * Length of the longest common prefix of two normalized model ids that ends on a
 * segment boundary in both — i.e. one id is a whole-segment prefix of the other.
 * `gpt-5` ↔ `gpt-5-codex` and `deepseek-v4-pro` ↔ `deepseek-v4-pro-0606` match
 * (returning the shorter length); siblings like `gpt-5.1` ↔ `gpt-5.2` and partial
 * tokens like `gpt-5` ↔ `gpt-50` return 0. A shared *vendor-only* prefix
 * (`deepseek-v4-pro` ↔ `deepseek-chat`) never matches, because the whole shorter
 * id — boundary included — has to prefix the longer one.
 */
function segmentPrefixLen(a: string, b: string): number {
	if (a === b) return a.length;
	const [short, long] = a.length <= b.length ? [a, b] : [b, a];
	if (short.length === 0 || !long.startsWith(short)) return 0;
	return SEGMENT_SEPARATOR.test(long[short.length]) ? short.length : 0;
}

/**
 * Tie-break equal-length prefix matches deterministically: prefer the key closest
 * in length to the query (fewest extra segments), then the lexically smaller one
 * so the choice never depends on map iteration order.
 */
function isCloserKey(candidate: string, current: string): boolean {
	if (candidate.length !== current.length) return candidate.length < current.length;
	return candidate < current;
}

export class PricingService {
	private byId = new Map<string, ModelRate>();
	private byNorm = new Map<string, ModelRate>();
	private warned = new Set<string>();
	private fuzzyMatched = new Set<string>();

	constructor(private readonly db: Db) {}

	/**
	 * Load into memory and (optionally) start the background refresh. `refresh`
	 * is opt-in so tests and offline boots don't hit the network; the table is
	 * never empty here — the `014` migration bakes in a catalog snapshot.
	 */
	async init(opts: { refresh?: boolean } = {}): Promise<void> {
		await this.reload();
		if (opts.refresh) {
			trackBackground(this.refresh().catch((e) => log.error('initial pricing refresh failed:', e)));
		}
	}

	/** Rebuild the in-memory maps from the table. Manual rows override feed rows. */
	async reload(): Promise<void> {
		const rows = await listModelPricing(this.db);
		const byId = new Map<string, ModelRate>();
		const byNorm = new Map<string, ModelRate>();
		// Apply feed rows first, then manual, so a manual override wins on collision.
		const ordered = [...rows].sort(
			(a, b) => Number(a.source === 'manual') - Number(b.source === 'manual'),
		);
		for (const row of ordered) {
			const rate: ModelRate = {
				inputPerToken: row.input_per_token,
				outputPerToken: row.output_per_token,
				cacheReadPerToken: row.cache_read_per_token,
				cacheCreationPerToken: row.cache_creation_per_token,
			};
			byId.set(row.model_id.toLowerCase(), rate);
			byNorm.set(normalizeModelId(row.model_id), rate);
		}
		this.byId = byId;
		this.byNorm = byNorm;
	}

	/** Refresh from the live catalog, then reload the in-memory maps. */
	async refresh(
		fetchImpl?: Parameters<typeof refreshPricingFromPricePerToken>[1],
	): Promise<number> {
		const count = await refreshPricingFromPricePerToken(this.db, fetchImpl);
		await this.reload();
		return count;
	}

	/** Cost in integer cents for a run's token buckets. Unknown model → 0 + warn. */
	costCents(model: string | undefined, tokens: CostTokens): number {
		const rate = this.resolve(model);
		if (!rate) {
			if (model && !this.warned.has(model)) {
				this.warned.add(model);
				log.warn(`No pricing for model "${model}"; recording run cost as $0`);
			}
			return 0;
		}
		return costCentsFromRate(rate, tokens);
	}

	private resolve(model: string | undefined): ModelRate | undefined {
		if (!model) return undefined;
		const norm = normalizeModelId(model);
		const exact = this.byId.get(model.toLowerCase()) ?? this.byNorm.get(norm);
		return exact ?? this.resolveByPrefix(model, norm);
	}

	/**
	 * Last-resort match for a model the feed doesn't list exactly: the entry whose
	 * normalized id shares the longest segment-aligned prefix with `norm` (so
	 * `deepseek-v4-pro[1m]` prices off a `deepseek-v4-pro-0606` feed row when only
	 * the dated variant is listed). Best-effort — an approximate rate beats
	 * recording the run at $0 — so it logs once per model instead of warning.
	 */
	private resolveByPrefix(model: string, norm: string): ModelRate | undefined {
		if (!norm) return undefined;
		let bestKey: string | undefined;
		let bestLen = 0;
		for (const key of this.byNorm.keys()) {
			const len = segmentPrefixLen(norm, key);
			if (len === 0) continue;
			if (
				len > bestLen ||
				(len === bestLen && bestKey !== undefined && isCloserKey(key, bestKey))
			) {
				bestKey = key;
				bestLen = len;
			}
		}
		if (bestKey === undefined) return undefined;
		if (!this.fuzzyMatched.has(model)) {
			this.fuzzyMatched.add(model);
			log.info(`No exact pricing for model "${model}"; using nearest match "${bestKey}"`);
		}
		return this.byNorm.get(bestKey);
	}
}
