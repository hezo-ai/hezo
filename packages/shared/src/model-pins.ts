/**
 * Which model a newly-added provider credential starts on, and how that choice
 * keeps up with the provider's catalog.
 *
 * **The problem this solves.** Every pinned model id in this repo is a constant
 * someone typed once. Providers retire ids without warning, and nothing here
 * notices: `gemini-1.5-flash` sat in the Stop-hook judge long after Google
 * withdrew it, so the judge call 404'd on every run and the hook failed open
 * with nothing looking wrong. A pin has to be able to move on its own.
 *
 * **What moves and what does not.** A pin is only ever the *default offered to a
 * new credential*. A provider config already in the database keeps the model the
 * operator chose, forever, until they change it - a refresh must never rewrite a
 * running instance's model selections out from under it.
 *
 * **Why a family and not "the newest model".** A provider's catalog mixes
 * tiers, modalities and vendors: Anthropic serves Opus and Haiku beside Sonnet,
 * OpenAI serves chat models beside Codex ones, OpenRouter serves several
 * thousand models from everyone. "Newest" across that set is meaningless and
 * would happily pin an image model or jump price tier. So a pin names the
 * *family* it tracks, and the refresh picks the highest version inside it. The
 * class of model an operator gets is stable; only its version moves.
 */

import { AiProvider } from './types/common.js';

export interface ModelPinSpec {
	/**
	 * The family this pin tracks, anchored. Only catalog ids matching it are
	 * candidates, which is what stops a refresh crossing tiers or modalities.
	 */
	family: RegExp;
	/**
	 * The id used until a refresh has seen this provider's live catalog - on a
	 * fresh instance, offline, or for a provider nobody has configured yet (there
	 * is no credential to read a catalog with until the first one is added).
	 */
	fallback: string;
}

/**
 * Per-provider families, chosen as the sensible default tier for agent work
 * rather than the cheapest or the most capable.
 *
 * A provider absent here gets no pin and no default model, which is correct for
 * the local runners: their catalog is whatever the operator has pulled, so there
 * is nothing to know here and the CLI's own default is the honest answer.
 */
export const MODEL_PIN_SPECS: Partial<Record<AiProvider, ModelPinSpec>> = {
	// The top tier, chosen deliberately: agent work is the case Opus is for, and a
	// team that wants to spend less moves individual agents down rather than
	// starting everyone on a weaker model.
	[AiProvider.Anthropic]: { family: /^claude-opus-[\d.-]+$/, fallback: 'claude-opus-5' },
	// A codex-family id, because this credential drives the Codex CLI - it warns
	// "model metadata not found" for a general chat model and guesses its limits.
	[AiProvider.OpenAI]: { family: /^gpt-[\d.]+-codex$/, fallback: 'gpt-5.3-codex' },
	[AiProvider.Google]: { family: /^gemini-[\d.]+-flash$/, fallback: 'gemini-3.6-flash' },
	[AiProvider.DeepSeek]: { family: /^deepseek-v[\d.]+-pro$/, fallback: 'deepseek-v4-pro' },
	// Case-insensitive: z.ai's catalog answers `glm-5.2` while its own docs and
	// this repo's static env use `GLM-4.7`, and the endpoint accepts either.
	[AiProvider.ZAi]: { family: /^glm-[\d.]+$/i, fallback: 'GLM-4.7' },
	// `-code` optional so both `kimi-k3` and `kimi-k2.7-code` are candidates; the
	// version comparison, not the suffix, decides between them.
	[AiProvider.Kimi]: { family: /^kimi-k[\d.]+(-code)?$/, fallback: 'kimi-k3' },
	[AiProvider.XAi]: { family: /^grok-[\d.]+$/, fallback: 'grok-4.5' },
	// OpenRouter is a router, not a vendor: "the latest model" across its whole
	// catalog is not a question with an answer. The family names one vendor line
	// known to serve tool use, which is what an agent run needs at all.
	[AiProvider.OpenRouter]: {
		family: /^anthropic\/claude-haiku-[\d.]+$/,
		fallback: 'anthropic/claude-haiku-4.5',
	},
};

/**
 * A dated snapshot suffix, which is a release date and not a version.
 *
 * Left in, `claude-haiku-4-5-20251001` would outrank every later model on the
 * strength of a number that is not a version at all. Matches both spellings
 * providers use: a bare 8-digit stamp and a hyphenated ISO date.
 */
const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * A model id's version, as the sequence of numbers in it.
 *
 * Both separators mean the same thing - `claude-sonnet-4-6` and `gemini-3.6-flash`
 * are the same shape - so `.` and `-` are read alike and the trailing words are
 * ignored. Ids in a family differ only in these numbers, which is exactly what
 * makes the family restriction load-bearing.
 */
export function parseModelVersion(id: string): number[] {
	const withoutDate = id.replace(DATE_SUFFIX, '');
	return (withoutDate.match(/\d+/g) ?? []).map(Number);
}

/**
 * Compare two ids by version, newest last. Element-wise, so `5` beats `4.6`; a
 * longer run of numbers breaks a tie, so `4.6` beats `4`.
 */
export function compareModelVersions(a: string, b: string): number {
	const va = parseModelVersion(a);
	const vb = parseModelVersion(b);
	for (let i = 0; i < Math.max(va.length, vb.length); i += 1) {
		const diff = (va[i] ?? -1) - (vb[i] ?? -1);
		if (diff !== 0) return diff;
	}
	// Stable and deterministic for two ids carrying identical numbers, so a
	// catalog's ordering cannot make the pin flap between refreshes.
	return a.localeCompare(b);
}

/**
 * The newest id in this provider's tracked family, or null when its catalog
 * offers none.
 *
 * Null rather than a guess: a catalog with no family match means the family has
 * been renamed or the credential sees a restricted catalog, and holding the
 * previous pin is safer than pinning something from a different tier.
 */
export function pickLatestModel(provider: AiProvider, ids: readonly string[]): string | null {
	const spec = MODEL_PIN_SPECS[provider];
	if (!spec) return null;
	const candidates = ids.filter((id) => spec.family.test(id));
	if (candidates.length === 0) return null;
	return candidates.reduce((best, id) => (compareModelVersions(id, best) > 0 ? id : best));
}

/** The compile-time default for a provider, before any refresh has run. */
export function fallbackPinnedModel(provider: AiProvider): string | null {
	return MODEL_PIN_SPECS[provider]?.fallback ?? null;
}
