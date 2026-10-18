import { describe, expect, test } from 'vitest';
import type { MessageKey } from '../src/lib/i18n';
import en from '../src/lib/i18n/catalog/en.json';
import { composePlanWithCeoMessage } from '../src/lib/plan-with-ceo-message';
import type { TeamOption } from '../src/lib/team-suggestions';

// The English catalog as the translator, so the assertions read the real sentences.
const t = (key: MessageKey, vars?: Record<string, string | number>) =>
	(en as Record<string, string>)[key].replace(/\{(\w+)\}/g, (m, n: string) =>
		vars && n in vars ? String(vars[n]) : m,
	);

const terms: TeamOption['terms'] = new Map();

describe('composePlanWithCeoMessage', () => {
	test('asks the CEO to propose a team when none was picked, description as its own paragraph', () => {
		expect(
			composePlanWithCeoMessage(t, {
				name: 'Stock watch',
				description: 'Track my portfolio.',
				team: null,
				hasPlan: false,
			}),
		).toBe(
			[
				'I want to plan a new project with you.',
				'Project name: Stock watch',
				'Team: I did not pick one. Please suggest one.',
				'',
				'Track my portfolio.',
			].join('\n'),
		);
	});

	test('names a marketplace team with its slug, and says a plan is attached', () => {
		const team: TeamOption = {
			kind: 'marketplace',
			group: 'new',
			key: 'marketplace:investment',
			slug: 'investment',
			name: 'Investment Portfolio',
			description: '',
			meta: '6 roles',
			terms,
		};
		const message = composePlanWithCeoMessage(t, {
			name: 'Stock watch',
			description: 'Track my portfolio.',
			team,
			hasPlan: true,
		});
		expect(message).toContain(
			'Team I picked: Investment Portfolio (from the team marketplace, investment)',
		);
		expect(message).toContain('I attached my project plan.');
	});

	test('names a saved team type and a copied team by what the admin saw', () => {
		const template: TeamOption = {
			kind: 'template',
			group: 'new',
			key: 'template:t1',
			id: 't1',
			name: 'Blank',
			description: '',
			meta: 'Captain only',
			terms,
		};
		expect(
			composePlanWithCeoMessage(t, { name: 'A', description: 'B', team: template, hasPlan: false }),
		).toContain('Team I picked: Blank (a saved team type)');

		const copy: TeamOption = {
			kind: 'team',
			group: 'copy',
			key: 'team:x',
			id: 'x',
			slug: 'shop-team',
			projectSlug: 'shop',
			name: 'Shop Team',
			description: '',
			meta: '3 agents',
			terms,
		};
		expect(
			composePlanWithCeoMessage(t, {
				name: 'A',
				description: 'B',
				team: copy,
				hasPlan: false,
				copiedFromProject: 'Shop',
			}),
		).toContain('Team I picked: a copy of the Shop Team team from Shop');
	});
});
