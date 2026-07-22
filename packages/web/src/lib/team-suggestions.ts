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
 * One selectable team in the New Project dialog, unifying the three sources that
 * can back a new team — a marketplace team, a local catalog template, or an
 * existing team to clone — behind a single shape the suggestion ranker, the
 * search, and the card renderer all work over. `group` splits them into the two
 * "all teams" tabs: `new` (marketplace + templates) vs `copy` (existing teams).
 * `keywords` is the lowercased free-text bag the client-side ranker scores
 * against (there is no server suggestion endpoint and teams carry no tags).
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
			keywords: string;
	  }
	| {
			kind: 'template';
			group: 'new';
			key: string;
			id: string;
			name: string;
			description: string;
			meta: string;
			keywords: string;
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
			keywords: string;
	  };

/**
 * Minimum description length before the entry step swaps its "describe your
 * project" prompt for ranked suggestions. Below this we don't have enough signal
 * to suggest anything meaningful.
 */
export const SUGGEST_MIN_CHARS = 12;

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
			keywords: `${mt.name} ${mt.description ?? ''} ${mt.summary ?? ''}`.toLowerCase(),
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
			keywords: `${tpl.name} ${tpl.description ?? ''}`.toLowerCase(),
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
			keywords: src.name.toLowerCase(),
		}),
	);

	return [...marketplace, ...template, ...team];
}

/**
 * Rank options by keyword overlap with the query (the project name + description).
 * Distinct query tokens of >2 chars each score a point per option whose keyword
 * bag contains them; ties fall back to the original order. Returns the top
 * `limit` positively-scored options, or `[]` when the query has no usable tokens
 * (the caller decides the empty-query fallback / prompt).
 */
export function rankTeams(query: string, options: TeamOption[], limit = 2): TeamOption[] {
	const tokens = Array.from(
		new Set((query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2)),
	);
	if (tokens.length === 0) return [];
	return options
		.map((option, index) => ({
			option,
			index,
			score: tokens.reduce((acc, token) => acc + (option.keywords.includes(token) ? 1 : 0), 0),
		}))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, limit)
		.map((entry) => entry.option);
}
