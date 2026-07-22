import type { MarketplaceIndexEntry, TeamTemplateSource } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import type { TeamTemplate, TeamTemplateAgentType } from '../src/hooks/use-team-templates';
import { buildTeamOptions, rankTeams, SUGGEST_MIN_CHARS } from '../src/lib/team-suggestions';

function mp(over: Partial<MarketplaceIndexEntry>): MarketplaceIndexEntry {
	return {
		slug: 's',
		name: 'N',
		description: '',
		summary: '',
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
		// keywords fold in name + description + summary, lowercased.
		expect(inv?.keywords).toContain('analysts');
		expect(inv?.keywords).toContain('stock research');

		expect(options.find((o) => o.key === 'template:blank')?.meta).toBe('Captain only');
		expect(options.find((o) => o.key === 'template:app')?.meta).toBe('2 agent roles');

		const ops = options.find((o) => o.key === 'team:t1');
		expect(ops?.group).toBe('copy');
		expect(ops?.meta).toBe('3 agents');
		expect(options.find((o) => o.key === 'team:t2')?.meta).toBe('No agents yet');
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
