/**
 * Server-side half of the prompt-style validation.
 *
 * The register's mechanical rules live once in `@hezo/shared`
 * (`checkPromptStyle`) so the web authoring UI and the commit hook run exactly
 * the same checks. One rule cannot live there: "this restates something
 * SHARED_INSTRUCTIONS already says", because that text is here. So this module
 * adds that check and exposes the combined result to every authoring surface.
 *
 * The reach rule it enforces is AGENTS.md § Layout: state a rule once, in the
 * highest-reaching surface that covers its audience. Every agent already
 * receives SHARED_INSTRUCTIONS on every run, so a role prompt repeating one of
 * its bullets is pure duplication - and the copy is what goes stale.
 */
import {
	type CheckPromptStyleOptions,
	checkPromptStyle,
	formatPromptStyleFindings,
	isComparableBullet,
	normalizeBullet,
	type PromptStyleFinding,
} from '@hezo/shared';
import { SHARED_INSTRUCTIONS_TEXT } from './template-resolver';

/**
 * Normalized SHARED_INSTRUCTIONS bullets, built once. Bounded by the size of
 * that constant (a few hundred lines) and invalidated only by a redeploy, since
 * the source is a compile-time constant.
 */
let sharedBullets: Set<string> | null = null;

function sharedInstructionBullets(): Set<string> {
	if (sharedBullets) return sharedBullets;
	const set = new Set<string>();
	for (const line of SHARED_INSTRUCTIONS_TEXT.split('\n')) {
		if (!/^\s*[-+]\s+/.test(line)) continue;
		const norm = normalizeBullet(line);
		if (isComparableBullet(norm)) set.add(norm);
	}
	sharedBullets = set;
	return set;
}

/** Test-only: drop the memoized bullet set. */
export function resetSharedInstructionBullets(): void {
	sharedBullets = null;
}

/**
 * Bullets in `text` that are byte-identical, after normalization, to a bullet
 * every agent already receives. Whole-bullet matching only - never substrings -
 * so a paraphrase that genuinely adds a role-specific exception is not flagged.
 */
export function findSharedInstructionDuplicates(text: string): PromptStyleFinding[] {
	const shared = sharedInstructionBullets();
	const findings: PromptStyleFinding[] = [];
	text.split('\n').forEach((line, i) => {
		if (!/^\s*[-+]\s+/.test(line)) return;
		const norm = normalizeBullet(line);
		if (!isComparableBullet(norm) || !shared.has(norm)) return;
		findings.push({
			rule: 'duplicates_shared',
			severity: 'error',
			line: i + 1,
			excerpt: norm.length <= 80 ? norm : `${norm.slice(0, 77)}...`,
			message:
				'This bullet already reaches every agent through the shared instructions on every run. Delete it here rather than keeping a second copy that can go stale.',
		});
	});
	return findings;
}

/** Every finding for an authored prompt: the shared register plus the reach check. */
export function checkAuthoredPrompt(
	text: string,
	options: CheckPromptStyleOptions = {},
): PromptStyleFinding[] {
	return [...checkPromptStyle(text, options), ...findSharedInstructionDuplicates(text)].sort(
		(a, b) => a.line - b.line,
	);
}

/**
 * Rejection message for the error-severity findings, or null when there are
 * none. Same shape as `requiredSystemPromptVarsError` so a route can chain the
 * two checks and return whichever fails.
 */
export function authoredPromptError(
	text: string,
	options?: CheckPromptStyleOptions,
): string | null {
	const errors = checkAuthoredPrompt(text, options).filter((f) => f.severity === 'error');
	if (errors.length === 0) return null;
	return `Prompt style violations that must be fixed:\n${formatPromptStyleFindings(errors)}`;
}

/**
 * Advisory warnings for a write that succeeded, phrased for an agent to fix in
 * place. Returns null when clean, so a caller can spread it onto a tool result
 * without an empty key. This is the same channel as the backticked-entity
 * warning: a defect to correct with the matching update tool, not noise.
 */
export function authoredPromptWarning(
	text: string,
	options?: CheckPromptStyleOptions,
): string | null {
	const warnings = checkAuthoredPrompt(text, options).filter((f) => f.severity === 'warning');
	if (warnings.length === 0) return null;
	return `The prompt was saved, but it departs from the house register in ${warnings.length} place(s). Fix these in place with the matching update tool:\n${formatPromptStyleFindings(warnings)}`;
}
