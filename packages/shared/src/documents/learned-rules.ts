/**
 * The Learned Rules section the Coach keeps at the end of an agent's prompt.
 * A rule is a top-level bullet under the heading. The prompt-writing tools hold
 * the section to a fixed number of rules, so the Coach merges or removes a rule
 * before it adds one.
 */

/** The heading agents append their learned rules under. */
export const LEARNED_RULES_HEADING = '## Learned Rules';

/** The most rules a role's Learned Rules section may hold. */
export const MAX_LEARNED_RULES = 20;

/** A prompt split at its Learned Rules heading; `rules` is empty when it has none. */
export function splitLearnedRules(prompt: string): { body: string; rules: string } {
	const at = prompt.indexOf(LEARNED_RULES_HEADING);
	if (at === -1) return { body: prompt.trimEnd(), rules: '' };
	return { body: prompt.slice(0, at).trimEnd(), rules: prompt.slice(at) };
}

/** How many rules a prompt's Learned Rules section holds: its top-level bullets. */
export function countLearnedRules(prompt: string): number {
	return (splitLearnedRules(prompt).rules.match(/^[-*] /gm) ?? []).length;
}

/** Whether an edit changed only the Learned Rules section, leaving the role's own text alone. */
export function learnedRulesOnlyChange(before: string, after: string): boolean {
	return before !== after && splitLearnedRules(before).body === splitLearnedRules(after).body;
}

/**
 * Why a prompt write cannot be stored, or null when it can: it would leave more
 * than {@link MAX_LEARNED_RULES} rules, and more than the prompt had before. A
 * prompt already over the cap can always be written down towards it.
 */
export function learnedRulesCapError(before: string | null, after: string): string | null {
	const next = countLearnedRules(after);
	if (next <= MAX_LEARNED_RULES || next <= countLearnedRules(before ?? '')) return null;
	return `A role's Learned Rules may hold at most ${MAX_LEARNED_RULES} rules, and this prompt has ${next}. Merge rules that overlap, or remove one that has not caught a defect, before you add another.`;
}
