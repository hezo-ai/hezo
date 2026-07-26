import type { MarketplaceIndexEntry, TeamTemplateSource } from '@hezo/shared';
import { stemTerm } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import type { TeamTemplate, TeamTemplateAgentType } from '../src/hooks/use-team-templates';
import {
	buildTeamOptions,
	FIELD_WEIGHT,
	rankTeams,
	SUGGEST_MIN_CHARS,
} from '../src/lib/team-suggestions';

function mp(over: Partial<MarketplaceIndexEntry>): MarketplaceIndexEntry {
	return {
		slug: 's',
		name: 'N',
		description: '',
		summary: '',
		keywords: [],
		version: 1,
		roster_count: 1,
		latest_notes: '',
		...over,
	};
}

function at(slug: string): TeamTemplateAgentType {
	return {
		agent_type_id: slug,
		name: slug,
		slug,
		role_description: '',
		reports_to_slug: null,
		sort_order: 0,
	};
}

function tpl(over: Partial<TeamTemplate>): TeamTemplate {
	return {
		id: 'id',
		name: 'N',
		description: null,
		is_builtin: false,
		source: 'custom' as TeamTemplateSource,
		metadata: {},
		kb_docs_config: [],
		agent_types: [],
		created_at: '',
		...over,
	};
}

describe('buildTeamOptions', () => {
	it('maps the three sources with the exact meta strings + groups', () => {
		const options = buildTeamOptions(
			[
				mp({
					slug: 'inv',
					name: 'Investment',
					description: 'Stock research',
					summary: 'analysts',
					keywords: ['equities', 'due diligence'],
					roster_count: 6,
				}),
			],
			[
				tpl({ id: 'blank', name: 'Blank', description: null, agent_types: [] }),
				tpl({
					id: 'app',
					name: 'App Team',
					description: 'Builds apps',
					agent_types: [at('a'), at('b')],
				}),
			],
			[
				{ id: 't1', slug: 'ops', name: 'Ops', agent_count: 3 },
				{ id: 't2', slug: 'empty', name: 'Empty', agent_count: 0 },
			],
		);

		const inv = options.find((o) => o.key === 'marketplace:inv');
		expect(inv?.group).toBe('new');
		expect(inv?.meta).toBe('6 roles');
		// Authored keywords are the top tier, above the team's own name. The index
		// is keyed by stem, so "equities" is stored under stemTerm('equities').
		expect(inv?.terms.get(stemTerm('equities'))).toBe(FIELD_WEIGHT.keywords);
		// A keyword phrase contributes each of its words.
		expect(inv?.terms.get('due')).toBe(FIELD_WEIGHT.keywords);
		expect(inv?.terms.get('diligence')).toBe(FIELD_WEIGHT.keywords);
		// Terms are indexed by stem, weighted by the field they came from.
		expect(inv?.terms.get('investment')).toBe(FIELD_WEIGHT.name);
		expect(inv?.terms.get('research')).toBe(FIELD_WEIGHT.description);
		expect(inv?.terms.get(stemTerm('analysts'))).toBe(FIELD_WEIGHT.summary);

		// A template's name + description are indexed; "apps" folds onto "app".
		const app = options.find((o) => o.key === 'template:app');
		expect(app?.meta).toBe('2 agent roles');
		expect(app?.terms.get('app')).toBe(FIELD_WEIGHT.name);
		expect(options.find((o) => o.key === 'template:blank')?.meta).toBe('Captain only');

		const ops = options.find((o) => o.key === 'team:t1');
		expect(ops?.group).toBe('copy');
		expect(ops?.meta).toBe('3 agents');
		expect(ops?.terms.get('ops')).toBe(FIELD_WEIGHT.name);
		expect(options.find((o) => o.key === 'team:t2')?.meta).toBe('No agents yet');
	});

	it('keeps the strongest field a term appears in, not the sum', () => {
		const [option] = buildTeamOptions(
			[mp({ name: 'Growth', description: 'growth growth growth', summary: 'growth growth' })],
			[],
			[],
		);
		expect(option.terms.get('growth')).toBe(FIELD_WEIGHT.name);
	});

	it('singularizes a one-agent team', () => {
		const [team] = buildTeamOptions([], [], [{ id: 't', slug: 's', name: 'Solo', agent_count: 1 }]);
		expect(team.meta).toBe('1 agent');
	});
});

describe('rankTeams', () => {
	const options = buildTeamOptions(
		[
			mp({ slug: 'social', name: 'Social', description: 'social media influencer content growth' }),
			mp({ slug: 'fin', name: 'Finance', description: 'stock market research and analysis' }),
		],
		[],
		[],
	);

	it('returns [] for an empty or too-short query', () => {
		expect(rankTeams('', options)).toEqual([]);
		expect(rankTeams('ai', options)).toEqual([]);
	});

	it('ranks by keyword overlap, best first', () => {
		const ranked = rankTeams('influencer social content', options);
		expect(ranked[0]?.name).toBe('Social');
	});

	it('ignores tokens of 2 characters or fewer', () => {
		// every token here is ≤2 chars, so nothing is scored.
		expect(rankTeams('ai to go', options)).toEqual([]);
	});

	it('does not score function words', () => {
		// "and" is in Finance's description, "with"/"for" are in neither — a query
		// made only of function words must match nothing.
		expect(rankTeams('and for the with your', options)).toEqual([]);
	});

	it('matches whole stemmed words, never substrings', () => {
		const teams = buildTeamOptions(
			[
				mp({ slug: 'app', name: 'App Team', description: 'A full team that builds your app' }),
				mp({
					slug: 'social',
					name: 'Social Media Marketing',
					description: 'drafts content and publishes it with your approval',
				}),
				mp({
					slug: 'inv',
					name: 'Investment Portfolio',
					description: 'tracks stocks',
					summary: 'the investor objective, risk appetite, and horizon',
				}),
			],
			[],
			[],
		);

		// The reported bug: "app" was substring-matching "approval" and "appetite",
		// which tied with App Team and beat it on catalog order.
		const ranked = rankTeams('todo list app', teams, 2);
		expect(ranked.map((o) => o.name)).toEqual(['App Team']);
	});

	it('finds a team on a word that appears only in its authored keywords', () => {
		// The recall half: nothing in App Team's prose says "website", so before
		// keywords were data this query matched nothing at all.
		const teams = buildTeamOptions(
			[
				mp({
					slug: 'app',
					name: 'App Team',
					description: 'A full team that builds your app',
					keywords: ['website', 'saas', 'landing page'],
				}),
				mp({ slug: 'social', name: 'Social Media Marketing', description: 'grow your reach' }),
			],
			[],
			[],
		);
		expect(rankTeams('a website for my bakery', teams, 2).map((o) => o.name)).toEqual(['App Team']);
	});

	it('scores an authored keyword above another team name match', () => {
		const teams = buildTeamOptions(
			[
				mp({ slug: 'named', name: 'Website Team', description: 'unrelated' }),
				mp({ slug: 'kw', name: 'App Team', keywords: ['website'] }),
			],
			[],
			[],
		);
		expect(rankTeams('build a website', teams, 2)[0]?.name).toBe('App Team');
	});

	it('scores a name match above a summary match', () => {
		const teams = buildTeamOptions(
			[
				mp({ slug: 'buried', name: 'Portfolio', summary: 'a team that ships a mobile app' }),
				mp({ slug: 'named', name: 'App Team', description: 'builds software' }),
			],
			[],
			[],
		);
		expect(rankTeams('mobile app', teams, 2)[0]?.name).toBe('App Team');
	});

	it('matches across plural and verb forms', () => {
		const teams = buildTeamOptions(
			[mp({ slug: 'm', name: 'Market Research', description: 'analyst coverage' })],
			[],
			[],
		);
		expect(rankTeams('marketing analysts', teams, 2).map((o) => o.name)).toEqual([
			'Market Research',
		]);
	});

	it('caps the result at the given limit', () => {
		const many = buildTeamOptions(
			[
				mp({ slug: 'a', name: 'A', description: 'growth' }),
				mp({ slug: 'b', name: 'B', description: 'growth' }),
				mp({ slug: 'c', name: 'C', description: 'growth' }),
			],
			[],
			[],
		);
		expect(rankTeams('growth', many, 2)).toHaveLength(2);
	});

	it('exports a positive minimum-chars threshold', () => {
		expect(SUGGEST_MIN_CHARS).toBeGreaterThan(0);
	});
});
