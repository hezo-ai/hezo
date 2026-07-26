import { extractTerms, type MarketplaceIndexEntry, uniqueTerms } from '@hezo/shared';
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
 * Relative worth of a match, by the field it landed in.
 *
 * A team's authored `keywords` outrank everything: they are the team's own
 * statement of what it is for ("website", "saas", "todo list"), curated for this
 * exact purpose, and they are the one field that can be improved for a team
 * without touching this code. Its *name* comes next ("App Team" for "todo list
 * app"), then its one-line description. Its long marketing summary is the
 * weakest — that blob mentions half the vocabulary of every project brief, so an
 * unweighted hit there would drown out a name match.
 */
export const FIELD_WEIGHT = { keywords: 4, name: 3, description: 2, summary: 1 } as const;

/**
 * The scored match index for one option: stemmed term → the *highest* field
 * weight it was found in. Keyed by stem (`stemTerm` in `@hezo/shared`) so "apps"
 * matches "app" and "marketing" matches "market", while a bare substring like
 * "app" can never match inside "approval". Distinct from a team's authored
 * `keywords`, which are one of the fields folded into this index.
 */
export type TeamTermIndex = ReadonlyMap<string, number>;

/**
 * One selectable team in the New Project dialog, unifying the three sources that
 * can back a new team — a marketplace team, a local catalog template, or an
 * existing team to clone — behind a single shape the suggestion ranker, the
 * search, and the card renderer all work over. `group` splits them into the two
 * "all teams" tabs: `new` (marketplace + templates) vs `copy` (existing teams).
 * `terms` is the weighted match index the client-side ranker scores against
 * (there is no server suggestion endpoint — ranking is client-side over the
 * catalog the picker already has).
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
			terms: TeamTermIndex;
	  }
	| {
			kind: 'template';
			group: 'new';
			key: string;
			id: string;
			name: string;
			description: string;
			meta: string;
			terms: TeamTermIndex;
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
			terms: TeamTermIndex;
	  };

/**
 * Minimum description length before the entry step swaps its "describe your
 * project" prompt for ranked suggestions. Below this we don't have enough signal
 * to suggest anything meaningful.
 */
export const SUGGEST_MIN_CHARS = 12;

/**
 * Build the weighted match index for one option, keeping the *best* field a term
 * appears in rather than summing — a term repeated through a long summary should
 * not out-score a term in the team's name.
 */
function buildTermIndex(fields: Array<[string, number]>): TeamTermIndex {
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
			description: mt.description,
			meta: roleCountMeta(mt.roster_count),
			terms: buildTermIndex([
				// Authored discovery vocabulary first, at the highest weight. Phrases
				// split into their words, so "todo list" contributes both.
				[mt.keywords.join(' '), FIELD_WEIGHT.keywords],
				[mt.name, FIELD_WEIGHT.name],
				[mt.description, FIELD_WEIGHT.description],
				[mt.summary, FIELD_WEIGHT.summary],
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
			terms: buildTermIndex([
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
			terms: buildTermIndex([[src.name, FIELD_WEIGHT.name]]),
		}),
	);

	return [...marketplace, ...template, ...team];
}

/**
 * Rank options by weighted term overlap with the query (the project name +
 * description). Each distinct query term scores the weight of the best field it
 * matches in — authored keywords beat name beats description beats summary — and
 * terms are matched as whole stemmed words, never as substrings, so "app" hits
 * "App Team" and not the "approval" buried in another team's blurb. Ties fall
 * back to the original order. Returns the top `limit` positively-scored options,
 * or `[]` when the query has no usable terms (the caller decides the empty-query
 * fallback).
 */
export function rankTeams(query: string, options: TeamOption[], limit = 2): TeamOption[] {
	const terms = uniqueTerms(query);
	if (terms.length === 0) return [];
	return options
		.map((option, index) => ({
			option,
			index,
			score: terms.reduce((acc, term) => acc + (option.terms.get(term) ?? 0), 0),
		}))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, limit)
		.map((entry) => entry.option);
}
