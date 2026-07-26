import type { MarketplaceIndexEntry } from '@hezo/shared';
import type { TeamTemplate } from '../hooks/use-team-templates';

/**
 * A cloneable existing team, as the create-project dialog derives it from the
 * projects index (`useAllVisibleProjects`).
 */
export interface SourceTeamOption {
	id: string;
	slug: string;
	name: string;
	agent_count: number;
}

/**
 * Relative worth of a match, by the field it landed in. A team's *name* is the
 * strongest signal it is the right team ("App Team" for "todo list app"); its
 * one-line description is next; its long marketing summary is the weakest — that
 * blob mentions half the vocabulary of every project brief, so an unweighted hit
 * there would drown out a name match.
 */
export const FIELD_WEIGHT = { name: 3, description: 2, summary: 1 } as const;

/**
 * The scored term index for one option: stemmed term → the *highest* field weight
 * it was found in. Keyed by stem (see `stemTerm`) so "apps" matches "app" and
 * "marketing" matches "market", while a bare substring like "app" can never match
 * inside "approval".
 */
export type TeamKeywordIndex = ReadonlyMap<string, number>;

/**
 * One selectable team in the New Project dialog, unifying the three sources that
 * can back a new team — a marketplace team, a local catalog template, or an
 * existing team to clone — behind a single shape the suggestion ranker, the
 * search, and the card renderer all work over. `group` splits them into the two
 * "all teams" tabs: `new` (marketplace + templates) vs `copy` (existing teams).
 * `keywords` is the weighted term index the client-side ranker scores against
 * (there is no server suggestion endpoint and teams carry no tags).
 */
export type TeamOption =
	| {
			kind: 'marketplace';
			group: 'new';
			key: string;
			slug: string;
			name: string;
			description: string;
			meta: string;
			keywords: TeamKeywordIndex;
	  }
	| {
			kind: 'template';
			group: 'new';
			key: string;
			id: string;
			name: string;
			description: string;
			meta: string;
			keywords: TeamKeywordIndex;
	  }
	| {
			kind: 'team';
			group: 'copy';
			key: string;
			id: string;
			slug: string;
			name: string;
			description: string;
			meta: string;
			keywords: TeamKeywordIndex;
	  };

/**
 * Minimum description length before the entry step swaps its "describe your
 * project" prompt for ranked suggestions. Below this we don't have enough signal
 * to suggest anything meaningful.
 */
export const SUGGEST_MIN_CHARS = 12;

/**
 * Function words that carry no signal about *which* team fits. Every project
 * brief and every team summary is full of them, so scoring them ranks teams by
 * how much prose they happen to ship. Only words longer than 2 characters need
 * listing — shorter tokens are dropped outright. Domain vocabulary ("app",
 * "team", "content", "market", "research", …) is deliberately absent.
 *
 * The list is matched against the raw word *and* its stem, so a few entries are
 * stems rather than words ("thi" ← "this", "doe" ← "does", "don" ← "don't").
 */
const STOPWORDS = new Set([
	'about',
	'after',
	'again',
	'all',
	'also',
	'and',
	'any',
	'are',
	'because',
	'been',
	'before',
	'being',
	'both',
	'but',
	'can',
	'could',
	'did',
	'doe',
	'don',
	'each',
	'either',
	'etc',
	'even',
	'ever',
	'every',
	'for',
	'from',
	'get',
	'had',
	'has',
	'have',
	'her',
	'here',
	'him',
	'his',
	'how',
	'into',
	'its',
	'itself',
	'just',
	'like',
	'may',
	'might',
	'more',
	'most',
	'much',
	'must',
	'need',
	'not',
	'now',
	'off',
	'once',
	'one',
	'only',
	'onto',
	'other',
	'our',
	'out',
	'over',
	'own',
	'per',
	'rather',
	'really',
	'same',
	'she',
	'should',
	'since',
	'some',
	'such',
	'than',
	'that',
	'the',
	'their',
	'them',
	'then',
	'there',
	'these',
	'they',
	'thi',
	'this',
	'those',
	'through',
	'too',
	'two',
	'under',
	'until',
	'upon',
	'use',
	'very',
	'via',
	'want',
	'was',
	'way',
	'were',
	'what',
	'when',
	'where',
	'which',
	'while',
	'who',
	'whose',
	'why',
	'will',
	'with',
	'would',
	'you',
	'your',
]);

/**
 * Collapse a word to a crude stem so obvious morphological variants match:
 * plurals first ("apps" → "app", "publishes" → "publish", "verifies" → "verify"),
 * then verb/agent endings, applied repeatedly so "engineering" → "engineer" →
 * "engin" lands on the same stem as "engineer".
 *
 * Length guards keep short words intact, which is what stops the class of false
 * positive this ranker exists to avoid: "app" is never rewritten, and nothing
 * rewrites "approval" into it.
 */
export function stemTerm(word: string): string {
	let w = word;
	if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
	else if (w.length > 4 && /(?:s|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
	// "business" / "status" are not plurals.
	else if (w.length > 3 && w.endsWith('s') && !/(?:ss|us)$/.test(w)) w = w.slice(0, -1);

	// Two passes at most: "engineering" → "engineer" → "engin".
	for (let pass = 0; pass < 2; pass++) {
		if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
		else if (w.length > 5 && (w.endsWith('ed') || w.endsWith('er'))) w = w.slice(0, -2);
		else break;
	}
	return w;
}

/**
 * Split free text into the scoreable terms: alphanumeric words longer than two
 * characters, stemmed, with function words dropped (checked both before and after
 * stemming, so "uses" is discarded along with "use").
 */
export function extractTerms(text: string): string[] {
	const terms: string[] = [];
	for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
		if (word.length <= 2 || STOPWORDS.has(word)) continue;
		const stem = stemTerm(word);
		if (STOPWORDS.has(stem)) continue;
		terms.push(stem);
	}
	return terms;
}

/**
 * Build the weighted term index for one option, keeping the *best* field a term
 * appears in rather than summing — a term repeated through a long summary should
 * not out-score a term in the team's name.
 */
function buildKeywordIndex(fields: Array<[string, number]>): TeamKeywordIndex {
	const index = new Map<string, number>();
	for (const [text, weight] of fields) {
		for (const term of extractTerms(text)) {
			const best = index.get(term);
			if (best === undefined || best < weight) index.set(term, weight);
		}
	}
	return index;
}

function roleCountMeta(n: number): string {
	return `${n} role${n === 1 ? '' : 's'}`;
}

/**
 * Assemble the unified option list from the three data sources, reusing the exact
 * meta strings the dialog's cards have always shown.
 */
export function buildTeamOptions(
	marketplaceTeams: MarketplaceIndexEntry[],
	templates: TeamTemplate[],
	sourceTeams: SourceTeamOption[],
): TeamOption[] {
	const marketplace: TeamOption[] = marketplaceTeams.map(
		(mt): TeamOption => ({
			kind: 'marketplace',
			group: 'new',
			key: `marketplace:${mt.slug}`,
			slug: mt.slug,
			name: mt.name,
			description: mt.description ?? '',
			meta: roleCountMeta(mt.roster_count),
			keywords: buildKeywordIndex([
				[mt.name, FIELD_WEIGHT.name],
				[mt.description ?? '', FIELD_WEIGHT.description],
				[mt.summary ?? '', FIELD_WEIGHT.summary],
			]),
		}),
	);

	const template: TeamOption[] = templates.map(
		(tpl): TeamOption => ({
			kind: 'template',
			group: 'new',
			key: `template:${tpl.id}`,
			id: tpl.id,
			name: tpl.name,
			description: tpl.description ?? '',
			meta:
				tpl.agent_types.length === 0
					? 'Captain only'
					: `${tpl.agent_types.length} agent role${tpl.agent_types.length === 1 ? '' : 's'}`,
			keywords: buildKeywordIndex([
				[tpl.name, FIELD_WEIGHT.name],
				[tpl.description ?? '', FIELD_WEIGHT.description],
			]),
		}),
	);

	const team: TeamOption[] = sourceTeams.map(
		(src): TeamOption => ({
			kind: 'team',
			group: 'copy',
			key: `team:${src.id}`,
			id: src.id,
			slug: src.slug,
			name: src.name,
			description: '',
			meta:
				src.agent_count === 0
					? 'No agents yet'
					: `${src.agent_count} agent${src.agent_count === 1 ? '' : 's'}`,
			keywords: buildKeywordIndex([[src.name, FIELD_WEIGHT.name]]),
		}),
	);

	return [...marketplace, ...template, ...team];
}

/**
 * Rank options by weighted term overlap with the query (the project name +
 * description). Each distinct query term scores the weight of the best field it
 * matches in — name beats description beats summary — and terms are matched as
 * whole stemmed words, never as substrings, so "app" hits "App Team" and not the
 * "approval" buried in another team's blurb. Ties fall back to the original
 * order. Returns the top `limit` positively-scored options, or `[]` when the
 * query has no usable terms (the caller decides the empty-query fallback).
 */
export function rankTeams(query: string, options: TeamOption[], limit = 2): TeamOption[] {
	const terms = Array.from(new Set(extractTerms(query)));
	if (terms.length === 0) return [];
	return options
		.map((option, index) => ({
			option,
			index,
			score: terms.reduce((acc, term) => acc + (option.keywords.get(term) ?? 0), 0),
		}))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, limit)
		.map((entry) => entry.option);
}
