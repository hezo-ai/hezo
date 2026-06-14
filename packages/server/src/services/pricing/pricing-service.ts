/**
 * Runtime model pricing: the in-memory source of truth for run cost.
 *
 * Loads the `model_pricing` table into a sync lookup map on boot (seeding from
 * the bundled snapshot if the table is empty), optionally kicks a background
 * refresh from the live feed, and answers `costCents(model, tokens)` with no
 * per-call DB or network. Operator (`manual`) rows win over feed (`litellm`)
 * rows; an unknown model resolves to `$0` with a one-time warning.
 */
import type { PGlite } from '@electric-sql/pglite';
import { type CostTokens, costCentsFromRate, type ModelRate } from '@hezo/shared';
import { trackBackground } from '../../lib/background';
import { logger } from '../../logger';
import { loadSnapshotRates } from './feed';
import { refreshPricingFromFeed } from './refresher';
import { countModelPricing, listModelPricing, upsertFeedRates } from './repo';

const log = logger.child('pricing');

/**
 * Normalize a model id for fuzzy lookup. The CLI may emit a provider-prefixed,
 * dated, or 1M-context-tagged id (`openai/gpt-5`, `claude-opus-4-8-20260205`,
 * `deepseek-v4-pro[1m]`) while the feed keys the bare base id — strip those so
 * they resolve to the same rate.
 */
export function normalizeModelId(id: string): string {
	let s = id.toLowerCase().trim();
	const slash = s.lastIndexOf('/');
	if (slash >= 0) s = s.slice(slash + 1);
	s = s.replace(/\[1m\]/g, '');
	s = s.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
	return s;
}

export class PricingService {
	private byId = new Map<string, ModelRate>();
	private byNorm = new Map<string, ModelRate>();
	private warned = new Set<string>();

	constructor(private readonly db: PGlite) {}

	/**
	 * Seed-if-empty, load into memory, and (optionally) start the background
	 * refresh. `refresh` is opt-in so tests and offline boots don't hit the network.
	 */
	async init(opts: { refresh?: boolean } = {}): Promise<void> {
		if ((await countModelPricing(this.db)) === 0) {
			await upsertFeedRates(this.db, loadSnapshotRates());
		}
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

	/** Refresh from the live feed, then reload the in-memory maps. */
	async refresh(fetchImpl?: Parameters<typeof refreshPricingFromFeed>[1]): Promise<number> {
		const count = await refreshPricingFromFeed(this.db, fetchImpl);
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
		return this.byId.get(model.toLowerCase()) ?? this.byNorm.get(normalizeModelId(model));
	}
}
