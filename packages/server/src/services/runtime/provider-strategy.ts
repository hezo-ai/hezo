/**
 * Per-provider runtime behavior, keyed by `AiProvider`.
 *
 * Several providers share a single agent runtime (e.g. Anthropic, DeepSeek and
 * Z.ai all run on Claude Code), so behavior that varies by *provider* rather
 * than by *runtime* can't live in the per-runtime MCP adapters. The judge model
 * for the completeness Stop hook is the canonical case: the judge call is made
 * through the team's own provider upstream, so the model has to be one that
 * upstream can actually serve.
 *
 * The `Record<AiProvider, ProviderStrategy>` typing makes adding a provider to
 * the `AiProvider` enum without a strategy here a compile error.
 */
import { AiProvider } from '@hezo/shared';
import {
	STOP_HOOK_JUDGE_MODEL_ANTHROPIC,
	STOP_HOOK_JUDGE_MODEL_GOOGLE,
	STOP_HOOK_JUDGE_MODEL_OPENAI,
} from '../stop-hook-prompt';

export interface ProviderStrategy {
	/**
	 * Model the completeness Stop hook asks to judge the run, reachable through
	 * THIS provider's upstream. `null` means no reachable judge model: the gate
	 * fails open (the hook is omitted entirely), which matches the pre-existing
	 * effective behavior for providers whose upstream can't serve a judge model
	 * (the hook would fire, the judge call would fail, and it would fail open).
	 * Wiring a real judge model for those providers is a deliberate follow-up.
	 */
	judgeModel: string | null;
}

export const PROVIDER_STRATEGIES: Record<AiProvider, ProviderStrategy> = {
	[AiProvider.Anthropic]: { judgeModel: STOP_HOOK_JUDGE_MODEL_ANTHROPIC },
	[AiProvider.OpenAI]: { judgeModel: STOP_HOOK_JUDGE_MODEL_OPENAI },
	[AiProvider.Google]: { judgeModel: STOP_HOOK_JUDGE_MODEL_GOOGLE },
	// Run on the Claude Code runtime against a non-Anthropic upstream that can't
	// serve an Anthropic judge model — fail open until a reachable model is wired.
	[AiProvider.DeepSeek]: { judgeModel: null },
	[AiProvider.ZAi]: { judgeModel: null },
};

/** Judge model for a provider's completeness Stop hook, or null to fail open. */
export function getJudgeModel(provider: AiProvider): string | null {
	return PROVIDER_STRATEGIES[provider].judgeModel;
}
