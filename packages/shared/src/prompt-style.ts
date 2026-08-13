/**
 * The machine-checkable half of the agent-prompt writing register
 * (`.dev/writing-agent-prompts.md`, summarized in AGENTS.md § Layout).
 *
 * "Validation lives once and runs twice": these pure functions are the single
 * home for the rules, and three callers share them —
 *   1. the server's prompt-authoring surfaces (update_agent_system_prompt, the
 *      project Custom Prompt, team contexts, summaries),
 *   2. the web authoring UI, for inline feedback before submit,
 *   3. `scripts/check-prompt-style.ts`, the commit hook.
 *
 * Severity is deliberately split. `error` covers the unambiguous, mechanical
 * violations, and rejects the write. `warning` covers the judgement calls
 * (length, vocabulary) and is returned to the author as an advisory to fix in
 * place - the same shape as the existing backticked-entity warning. A heuristic
 * hard-reject would trap an agent retrying against a rule it cannot satisfy.
 *
 * The one rule that cannot live here is "duplicates something
 * SHARED_INSTRUCTIONS already says", because that text lives in the server.
 * It sits in `services/prompt-style-guard.ts` and reuses `normalizeBullet`.
 */

export type PromptStyleSeverity = 'error' | 'warning';

export interface PromptStyleFinding {
	/** Stable rule id, e.g. `long_sentence`. */
	rule: string;
	severity: PromptStyleSeverity;
	/** 1-indexed line the finding anchors to. */
	line: number;
	/** Short excerpt of the offending text, for the author to locate it. */
	excerpt: string;
	/** What is wrong and what to do instead. */
	message: string;
}

export interface CheckPromptStyleOptions {
	/**
	 * True when the prompt ships through the marketplace into other people's
	 * repositories (`agents/<team>/**` and any partial reaching one). Enables the
	 * Hezo-internal-symbol check, which is meaningless for an instance-local
	 * prompt an operator writes about their own codebase.
	 */
	marketplaceReaching?: boolean;
}

/** Max words in one sentence. STE says 20; tool names and `{{placeholders}}` inflate the count. */
export const MAX_SENTENCE_WORDS = 25;
/** Max words in one bullet. Longer means a rule is hiding inside prose. */
export const MAX_BULLET_WORDS = 60;

/** Hedges: they weaken a rule without narrowing it. */
const HEDGES = [
	'generally',
	'usually',
	'typically',
	'tends to',
	'it is worth noting',
	"it's worth noting",
	'arguably',
	'more or less',
	'for the most part',
];

/** Intensifiers that carry no constraint - state the observable behaviour instead. */
const INTENSIFIERS = [
	'aggressively',
	'genuinely important',
	'very important',
	'really important',
	'extremely important',
	'thoroughly',
	'non-negotiable',
	'hard musts, not aspirations',
	'at all costs',
];

/**
 * Hezo's own symbols and paths. Naming one inside a marketplace-reaching prompt
 * is an instruction to look for something that does not exist in the reader's
 * repository. `AGENTS.md` and `hezo/<TASK>` are deliberately absent: the first
 * is real in any repo, the second is Hezo runtime behaviour.
 */
const HEZO_INTERNAL_SYMBOLS = [
	'packages/server',
	'packages/web',
	'packages/shared',
	'@hezo/shared',
	'PGlite',
	'trackBackground',
	'createStubDocker',
	'withTransaction',
	'requireTeamAccess',
	'useOptimisticMutation',
	'isFkViolation',
	'buildJudgeScript',
	'renderApp(',
	'createTestContext',
];

/** A project-doc filename in backticks renders inert and models it as a repo path. */
const BACKTICKED_DOC = /`([A-Za-z0-9._-]+\.md)`/g;
/** Genuine repo files, where backticks are correct. */
const REPO_FILES = new Set(['AGENTS.md', 'README.md', 'CHANGELOG.md', 'CLAUDE.md']);

/** Author-facing summary of every rule, rendered into prompts at `{{prompt_style_rules}}`. */
export const PROMPT_STYLE_RULES: readonly {
	id: string;
	severity: PromptStyleSeverity;
	summary: string;
}[] = [
	{
		id: 'one_rule_per_bullet',
		severity: 'warning',
		summary: `One rule per bullet, and at most ${MAX_BULLET_WORDS} words in it. A longer bullet is hiding a second rule.`,
	},
	{
		id: 'long_sentence',
		severity: 'warning',
		summary: `One idea per sentence, at most ${MAX_SENTENCE_WORDS} words.`,
	},
	{
		id: 'imperative',
		severity: 'warning',
		summary:
			'Imperative, second person, active voice. A bare imperative means must; `Never` marks a prohibition. Drop `should`, `mandatory` and `non-negotiable`.',
	},
	{
		id: 'hedge',
		severity: 'warning',
		summary: 'No hedges - `generally`, `usually`, `typically`, `tends to`.',
	},
	{
		id: 'intensifier',
		severity: 'warning',
		summary:
			'No intensifier that carries no constraint. State the observable behaviour instead of `aggressively` or `thoroughly`.',
	},
	{
		id: 'rationale',
		severity: 'warning',
		summary:
			'No rationale unless the rule cannot be applied without it, and one consequence clause per rule.',
	},
	{
		id: 'backticked_doc',
		severity: 'error',
		summary:
			'Write a project-doc filename bare (prd.md) so it links. Backticks make it inert and model it as a repo path.',
	},
	{
		id: 'hezo_internal',
		severity: 'error',
		summary:
			"Never name Hezo's own paths or helpers in a prompt that ships to other people's repositories. Describe the shape instead.",
	},
	{
		id: 'duplicates_shared',
		severity: 'error',
		summary:
			'State a rule once, in the highest-reaching surface that covers its audience. A role prompt never restates the shared instructions.',
	},
];

/** The rule list as prompt-ready markdown, for the `{{prompt_style_rules}}` substitution. */
export function renderPromptStyleRules(): string {
	return PROMPT_STYLE_RULES.map((r) => `- ${r.summary}`).join('\n');
}

/**
 * Split into checkable segments, skipping the regions where the rules do not
 * apply: fenced code, markdown tables, and the trailing `{{...}}` context block
 * every role doc ends with.
 */
function checkableLines(text: string): { line: number; content: string }[] {
	const out: { line: number; content: string }[] = [];
	let inFence = false;
	// A skill's YAML frontmatter is metadata, not prose: its `description` has its
	// own length rule (<=300 chars, enforced by default-skills.test.ts) and is one
	// deliberate sentence, so the register's ceilings do not apply to it.
	const lines = text.split('\n');
	let start = 0;
	if (lines[0]?.trim() === '---') {
		const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
		if (close > 0) start = close + 1;
	}
	lines.forEach((raw, i) => {
		if (i < start) return;
		const trimmed = raw.trim();
		if (trimmed.startsWith('```')) {
			inFence = !inFence;
			return;
		}
		if (inFence) return;
		if (trimmed.startsWith('|')) return; // table row
		if (trimmed.startsWith('<!--')) return; // marker comment
		if (/^\{\{[a-z_]+\}\}$/.test(trimmed)) return; // a bare substitution line
		if (/^\{\{>\s*partials\//.test(trimmed)) return; // a partial directive
		if (trimmed.length === 0) return;
		out.push({ line: i + 1, content: raw });
	});
	return out;
}

/** Strip markdown decoration and inline code so word counts measure prose. */
function toProse(line: string): string {
	return line
		.replace(/`[^`]*`/g, ' ')
		.replace(/\{\{[^}]*\}\}/g, ' ')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[*_#>]/g, '')
		.replace(/^\s*[-+]\s+/, '')
		.replace(/^\s*\d+\.\s+/, '')
		.trim();
}

function countWords(s: string): number {
	return s.split(/\s+/).filter(Boolean).length;
}

/**
 * Normalize a bullet for duplicate detection: lowercase, decoration and
 * placeholders removed, punctuation and whitespace collapsed. Matching is on
 * whole normalized bullets only - never substrings - so legitimate paraphrase
 * does not trip it.
 */
export function normalizeBullet(line: string): string {
	// Unlike the word-count path, this keeps the *content* of inline code: a tool
	// or field name is part of what a rule says, so dropping it would let two
	// genuinely different bullets normalize to the same string.
	return line
		.replace(/`/g, '')
		.replace(/\{\{[^}]*\}\}/g, ' ')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[*_#>]/g, '')
		.replace(/^\s*[-+]\s+/, '')
		.replace(/^\s*\d+\.\s+/, '')
		.toLowerCase()
		.replace(/[^a-z0-9 ]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** True when a normalized bullet is long enough for a match to mean something. */
export function isComparableBullet(normalized: string): boolean {
	return countWords(normalized) >= 8;
}

function excerpt(s: string): string {
	const t = s.trim();
	return t.length <= 80 ? t : `${t.slice(0, 77)}...`;
}

/** Every style finding in `text`, errors and warnings together, in line order. */
export function checkPromptStyle(
	text: string,
	options: CheckPromptStyleOptions = {},
): PromptStyleFinding[] {
	const findings: PromptStyleFinding[] = [];
	const lines = checkableLines(text);

	for (const { line, content } of lines) {
		const prose = toProse(content);
		const lower = content.toLowerCase();

		// Errors -------------------------------------------------------------
		for (const m of content.matchAll(BACKTICKED_DOC)) {
			const filename = m[1];
			if (REPO_FILES.has(filename) || filename.includes('/')) continue;
			findings.push({
				rule: 'backticked_doc',
				severity: 'error',
				line,
				excerpt: m[0],
				message: `Write ${filename} bare so it renders as a link. In backticks it is inert and reads as a repo file path.`,
			});
		}

		if (options.marketplaceReaching) {
			for (const sym of HEZO_INTERNAL_SYMBOLS) {
				if (!content.includes(sym)) continue;
				findings.push({
					rule: 'hezo_internal',
					severity: 'error',
					line,
					excerpt: sym,
					message: `\`${sym}\` is Hezo's own code. This prompt ships into other people's repositories, where it does not exist - describe the shape it illustrates instead.`,
				});
			}
		}

		// Warnings -----------------------------------------------------------
		const isBullet = /^\s*([-+]|\d+\.)\s+/.test(content);
		if (isBullet && countWords(prose) > MAX_BULLET_WORDS) {
			findings.push({
				rule: 'one_rule_per_bullet',
				severity: 'warning',
				line,
				excerpt: excerpt(prose),
				message: `This bullet runs ${countWords(prose)} words (max ${MAX_BULLET_WORDS}). Split the second rule out, or cut the rationale.`,
			});
		}

		for (const sentence of prose.split(/(?<=[.!?])\s+/)) {
			const n = countWords(sentence);
			if (n > MAX_SENTENCE_WORDS) {
				findings.push({
					rule: 'long_sentence',
					severity: 'warning',
					line,
					excerpt: excerpt(sentence),
					message: `This sentence runs ${n} words (max ${MAX_SENTENCE_WORDS}). One idea per sentence.`,
				});
				break; // one report per line is enough to act on
			}
		}

		for (const hedge of HEDGES) {
			if (!lower.includes(hedge)) continue;
			findings.push({
				rule: 'hedge',
				severity: 'warning',
				line,
				excerpt: hedge,
				message: `"${hedge}" hedges the rule without narrowing it. State what always holds.`,
			});
			break;
		}

		for (const word of INTENSIFIERS) {
			if (!lower.includes(word)) continue;
			findings.push({
				rule: 'intensifier',
				severity: 'warning',
				line,
				excerpt: word,
				message: `"${word}" carries no constraint. Name the observable behaviour instead.`,
			});
			break;
		}
	}

	return findings.sort((a, b) => a.line - b.line);
}

export function promptStyleErrors(
	text: string,
	options?: CheckPromptStyleOptions,
): PromptStyleFinding[] {
	return checkPromptStyle(text, options).filter((f) => f.severity === 'error');
}

export function promptStyleWarnings(
	text: string,
	options?: CheckPromptStyleOptions,
): PromptStyleFinding[] {
	return checkPromptStyle(text, options).filter((f) => f.severity === 'warning');
}

/** Render findings as one line each, for a 4xx body or an agent-facing advisory. */
export function formatPromptStyleFindings(findings: PromptStyleFinding[]): string {
	return findings.map((f) => `line ${f.line}: ${f.message} (${f.excerpt})`).join('\n');
}

/**
 * Human-readable rejection naming every error-severity finding, suitable for a
 * 4xx response or a tool error. Null when the prompt has no errors. Mirrors
 * `requiredSystemPromptVarsError`, the sibling validator on this seam.
 */
export function promptStyleError(text: string, options?: CheckPromptStyleOptions): string | null {
	const errors = promptStyleErrors(text, options);
	if (errors.length === 0) return null;
	return `Prompt style violations that must be fixed:\n${formatPromptStyleFindings(errors)}`;
}
