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
});
