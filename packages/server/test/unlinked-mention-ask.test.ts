import { describe, expect, it } from 'vitest';
import { detectUnlinkedTeammateAsks } from '../src/lib/mentions';

const slugs = ['seo-distribution-specialist', 'architect', 'qa-engineer', 'admin'];

describe('detectUnlinkedTeammateAsks', () => {
	it('flags a bold-name handoff that reads as an ask (the screenshot case)', () => {
		expect(
			detectUnlinkedTeammateAsks(
				'The 47 new entries need admin browser submissions. **seo-distribution-specialist** — the assessment is ready for incorporation when you resume HM-167.',
				slugs,
			),
		).toEqual(['seo-distribution-specialist']);
	});

	it('flags a leading-line address that reads as an ask', () => {
		expect(detectUnlinkedTeammateAsks('architect: please review this plan.', slugs)).toEqual([
			'architect',
		]);
	});

	it('flags a routing-label handoff that reads as an ask (`**Next step:** architect —`)', () => {
		expect(
			detectUnlinkedTeammateAsks(
				'**Next step:** architect — ready for your review before we ship.',
				slugs,
			),
		).toEqual(['architect']);
	});

	it('flags a "Required actions for slug" heading over an imperative list (bare-name verdict-report shape)', () => {
		// Mirror of the passive detector's verdict-report case: the imperative list
		// carries no second-person/`please`/`?` signal, so only the action-assignment
		// phrase on the heading line can mark this as an ask.
		expect(
			detectUnlinkedTeammateAsks(
				'## Required actions for architect\n\n1. Reconcile the timing.\n2. Fix the duplication.',
				slugs,
			),
		).toEqual(['architect']);
	});

	it('flags a colon-terminated action-assignment line with a bare name', () => {
		expect(
			detectUnlinkedTeammateAsks('Next steps for qa-engineer:\n\n- Re-test the flow.', slugs),
		).toEqual(['qa-engineer']);
	});

	it('does not flag a slug that only appears inside a longer hyphenated bare name', () => {
		// With overlapping roster slugs, only the addressed teammate is flagged —
		// `architect` must not match inside `solution-architect`.
		expect(
			detectUnlinkedTeammateAsks('## Required actions for solution-architect\n\n1. Fix it.', [
				...slugs,
				'solution-architect',
			]),
		).toEqual(['solution-architect']);
	});

	it('does not flag an attribution heading without an action-assignment phrase', () => {
		expect(
			detectUnlinkedTeammateAsks('## Findings from architect\n\n- The design held up.', slugs),
		).toEqual([]);
	});

	it('does not flag an action-assignment heading whose name is @-prefixed (handled as a mention)', () => {
		// `@architect` is an active mention (wakes already); `@@architect` belongs to
		// the passive detector — the bare-name detector must claim neither.
		expect(
			detectUnlinkedTeammateAsks('## Required actions for @architect\n\n1. Fix it.', slugs),
		).toEqual([]);
		expect(
			detectUnlinkedTeammateAsks('## Required actions for @@architect\n\n1. Fix it.', slugs),
		).toEqual([]);
	});

	it('flags a bare-name closing handoff written as a readiness status line', () => {
		// Bare-name mirror of the passive detector's closing-handoff-block case: no
		// second-person pronoun, no `please`, no `?` — only the baton-passing
		// phrasing ("ready for") marks it as an ask.
		expect(
			detectUnlinkedTeammateAsks(
				'**architect** — re-verification confirms PASS. The document is ready for the admin.',
				slugs,
			),
		).toEqual(['architect']);
	});

	it('flags a bare-name address that hands the baton back ("all yours")', () => {
		expect(
			detectUnlinkedTeammateAsks('**qa-engineer** — the fixture is rebuilt, all yours.', slugs),
		).toEqual(['qa-engineer']);
	});

	it('flags a bare-name handoff that names the gate instead of the person', () => {
		// The gate-word forms of the same baton-passing handoff, with the `ready`
		// opener dropped. The ask gate is shared with detectPassiveTeammateAsks, so
		// the bare/bold form recognises them too.
		for (const line of [
			'architect — awaiting review.',
			'architect — for review.',
			'**architect** — pending approval before we ship.',
			'**architect** — sign-off needed before publication.',
		]) {
			expect(detectUnlinkedTeammateAsks(line, slugs)).toEqual(['architect']);
		}
	});

	it('flags a bare-name address that passes the baton on ("passing this back")', () => {
		expect(
			detectUnlinkedTeammateAsks('**qa-engineer** — passing this back after the rewrite.', slugs),
		).toEqual(['qa-engineer']);
	});

	it('does not flag a gate word in narration around a non-addressed bare name', () => {
		// "for review" is the signal, but nothing addresses the teammate — the name is
		// mid-sentence attribution, so the address gate rejects it before the ask gate.
		expect(
			detectUnlinkedTeammateAsks(
				'The doc went out for review last week; the architect wrote the brief.',
				slugs,
			),
		).toEqual([]);
	});

	it('does not flag a routing-label handoff without ask intent', () => {
		expect(
			detectUnlinkedTeammateAsks('**Next step:** architect — merged and shipped.', slugs),
		).toEqual([]);
	});

	it('does not flag a teammate named after an unrelated label phrase', () => {
		expect(
			detectUnlinkedTeammateAsks(
				'Status update: the architect finished, thanks for asking.',
				slugs,
			),
		).toEqual([]);
	});

	it('does not flag a bold name used for emphasis/attribution (no ask intent)', () => {
		expect(
			detectUnlinkedTeammateAsks(
				'Shipped. Credit to **architect** for the earlier analysis.',
				slugs,
			),
		).toEqual([]);
	});

	it('does not flag an active @mention (already wakes)', () => {
		expect(
			detectUnlinkedTeammateAsks('@architect — please consolidate the findings.', slugs),
		).toEqual([]);
	});

	it('does not flag a slug that is also actively @-mentioned elsewhere', () => {
		expect(
			detectUnlinkedTeammateAsks(
				'@architect kicked this off. **architect** — can you finish it?',
				slugs,
			),
		).toEqual([]);
	});

	it('does not flag a passive @@mention address', () => {
		expect(
			detectUnlinkedTeammateAsks('**@@architect** — you handled the review earlier.', slugs),
		).toEqual([]);
	});

	it('scopes ask intent to the addressing paragraph', () => {
		// The `you` lives in a different paragraph from the bold address.
		const text = 'Do you want the summary?\n\nSeparately, **architect** produced the plan.';
		expect(detectUnlinkedTeammateAsks(text, slugs)).toEqual([]);
	});

	it('ignores names inside inline code and fenced blocks', () => {
		expect(detectUnlinkedTeammateAsks('inert: `**architect** — please go`', slugs)).toEqual([]);
		expect(detectUnlinkedTeammateAsks('```\n**architect** — please go\n```', slugs)).toEqual([]);
	});

	it('flags @admin addressed by bold name with an ask', () => {
		expect(detectUnlinkedTeammateAsks('**admin** — please approve the draft.', slugs)).toEqual([
			'admin',
		]);
	});

	it('returns [] for empty content', () => {
		expect(detectUnlinkedTeammateAsks('', slugs)).toEqual([]);
		expect(detectUnlinkedTeammateAsks(null, slugs)).toEqual([]);
	});

	describe('name-bound sign-off gate (mid-sentence, no addressing position)', () => {
		const signoffSlugs = ['captain', 'marketing-lead', 'architect', 'admin'];

		it('flags the stranded "awaiting Captain sign-off" recap (the screenshot case)', () => {
			// The exact incident string: a stative status recap, name mid-sentence,
			// bound to the sign-off gate — no bold, no leading-line address, no @.
			expect(
				detectUnlinkedTeammateAsks(
					'Review complete. The task stays in `review` awaiting Captain sign-off.',
					signoffSlugs,
				),
			).toEqual(['captain']);
		});

		it('flags the gate → name → object forms (needs/pending/for)', () => {
			expect(
				detectUnlinkedTeammateAsks("The draft needs the marketing-lead's approval.", signoffSlugs),
			).toEqual(['marketing-lead']);
			expect(detectUnlinkedTeammateAsks('Left it pending Captain review.', signoffSlugs)).toEqual([
				'captain',
			]);
			expect(
				detectUnlinkedTeammateAsks('Parked for architect sign-off before release.', signoffSlugs),
			).toEqual(['architect']);
			expect(
				detectUnlinkedTeammateAsks('Still waiting on admin approval to ship.', signoffSlugs),
			).toEqual(['admin']);
		});

		it('flags the name → pending-action forms (modal required)', () => {
			for (const line of [
				'Captain to sign off next.',
				'Captain must approve before publication.',
				'Captain still needs to review the copy.',
			]) {
				expect(detectUnlinkedTeammateAsks(line, signoffSlugs)).toEqual(['captain']);
			}
		});

		it('does NOT flag a granted/past sign-off (no pending gate, no modal)', () => {
			// "the Captain's approval was already granted" — the name is possessed by a
			// noun with no leading gate word and no modal+verb, so it is a report of a
			// completed approval, not a pending ask.
			expect(
				detectUnlinkedTeammateAsks(
					"The Captain's approval was already granted last week.",
					signoffSlugs,
				),
			).toEqual([]);
			expect(
				detectUnlinkedTeammateAsks('Captain approved the plan on Monday.', signoffSlugs),
			).toEqual([]);
		});

		it('does NOT flag a gate word with no name bound to it', () => {
			// The sign-off gate fires only when a roster name is bound to it — a bare
			// "awaiting review" names no one.
			expect(detectUnlinkedTeammateAsks('The draft is awaiting review.', signoffSlugs)).toEqual([]);
		});

		it('does NOT flag a name only actively @-mentioned in the same sign-off recap', () => {
			// @captain already wakes, so the gate must not double-flag it.
			expect(
				detectUnlinkedTeammateAsks('@captain — this is awaiting captain sign-off.', signoffSlugs),
			).toEqual([]);
		});
	});
});
