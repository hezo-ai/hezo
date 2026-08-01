import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { detectPassiveTeammateAsks, detectUnlinkedTeammateAsks } from '../src/lib/mentions';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

// The screenshot case: an agent ends a comment with `@@admin — …` (the passive
// mention form). It renders as a bare-word link, so it LOOKS like a ping, but @@
// notifies no one — the handoff stalls. The forms are gated differently: a
// LEADING-LINE `@@slug — …` always warns (opening a line with a teammate
// reference and a separator is the address shape, which is reserved for active
// mentions — a genuine reference goes mid-sentence), an ACTION-ASSIGNMENT line and
// a NAME-BOUND SIGN-OFF GATE (`Ready for @@slug review.`) are self-gating (the
// binding is the ask), while an EMPHASISED `**@@slug**` warns only when its
// paragraph reads as an ask, since bold marks attribution and headings as much as
// address.

describe('detectPassiveTeammateAsks', () => {
	const slugs = ['architect', 'qa-engineer', 'engineer', 'admin'];

	it('flags the screenshot case: passive @@admin address with a second-person ask', () => {
		expect(
			detectPassiveTeammateAsks(
				"@@admin — the drafts are ready for your re-review in Typefully when you're set.",
				slugs,
			),
		).toEqual(['admin']);
	});

	it('flags an emphasised passive address with an imperative opener', () => {
		expect(detectPassiveTeammateAsks('**@@architect** — please review.', slugs)).toEqual([
			'architect',
		]);
	});

	it('flags a leading-line passive address that asks a question', () => {
		expect(detectPassiveTeammateAsks('@@admin: can you approve?', slugs)).toEqual(['admin']);
	});

	it('flags the routing-label screenshot case: `**Next step:** @@captain — …your…`', () => {
		// The exact stalled handoff: a passive @@captain sits after a `**Next step:**`
		// label (not the first token on the line) with a second-person ask, while the
		// only actively-mentioned name is @admin — so the captain was never woken.
		expect(
			detectPassiveTeammateAsks(
				'**Next step:** @@captain — this X thread draft is reviewed and approved from my ' +
					'side. Ready for your strategic review. After Captain sign-off, @admin will need to ' +
					'attach screen recordings in Typefully before final approval and scheduling.',
				['captain', 'admin', 'marketing-lead'],
			),
		).toEqual(['captain']);
	});

	it('flags a routing-label passive address without markdown emphasis', () => {
		expect(detectPassiveTeammateAsks('Next step: @@architect — can you review?', slugs)).toEqual([
			'architect',
		]);
	});

	it('flags a routing-label passive handoff even with no ask intent', () => {
		// A routing label in front of the name does not change what the shape is: the
		// line still opens with a teammate address, which is reserved for active
		// mentions. The label makes it MORE of a handoff, not less.
		expect(
			detectPassiveTeammateAsks('**Next step:** @@architect — merged and shipped.', slugs),
		).toEqual(['architect']);
	});

	it('does not flag a teammate named after an unrelated label phrase', () => {
		// The colon belongs to an unrelated lead-in; `architect` is mid-sentence, not
		// addressed — the bounded, same-line label must sit immediately before the name.
		expect(
			detectPassiveTeammateAsks('Status update: the @@architect plan is ready, thanks.', slugs),
		).toEqual([]);
	});

	it('flags the verdict-report case: "Required actions for @@slug" heading over an imperative list', () => {
		// The DGXX verification report shape: a heading assigns required actions to a
		// passive @@ mention, and the numbered list below is pure imperatives — no
		// second-person pronoun, no `please`, no `?` — so the paragraph ask-gate
		// never fires. The action-assignment phrase on the heading line IS the ask.
		expect(
			detectPassiveTeammateAsks(
				'## Required actions for @@engineer\n\n' +
					'1. Reconcile the Phase 1 timing with the 8-K.\n' +
					'2. Bridge run-rate to recognized revenue.\n' +
					'3. Fix the source duplication.\n\n' +
					'Return to me for re-verification when these are addressed.',
				slugs,
			),
		).toEqual(['engineer']);
	});

	it('flags a bold action-assignment label line with a passive mention', () => {
		expect(
			detectPassiveTeammateAsks(
				'**Action items for @@architect**\n\n- Update the spec.\n- Re-run the checks.',
				slugs,
			),
		).toEqual(['architect']);
	});

	it('flags a colon-terminated action-assignment line with a passive mention', () => {
		expect(
			detectPassiveTeammateAsks('Next steps for @@qa-engineer:\n\n- Re-test the flow.', slugs),
		).toEqual(['qa-engineer']);
	});

	it('does not flag a heading naming a passive mention without an action-assignment phrase', () => {
		expect(
			detectPassiveTeammateAsks('## Notes from @@architect\n\n- The design held up well.', slugs),
		).toEqual([]);
	});

	it('does not flag an attribution heading ("Actions taken by") — compound phrases only', () => {
		expect(
			detectPassiveTeammateAsks('## Actions taken by @@architect\n\n- Migrated the schema.', slugs),
		).toEqual([]);
	});

	it('does not flag an action-assignment heading when the slug is also actively mentioned', () => {
		expect(
			detectPassiveTeammateAsks(
				'## Required actions for @@engineer\n\n1. Fix the build.\n\n@engineer — please pick these up.',
				slugs,
			),
		).toEqual([]);
	});

	it('does not flag a slug that only appears inside a longer hyphenated slug', () => {
		// `engineer` must not match inside `@@qa-engineer` — only the addressed
		// teammate is flagged, even when the roster carries overlapping slugs.
		expect(
			detectPassiveTeammateAsks('## Required actions for @@qa-engineer\n\n1. Re-test.', slugs),
		).toEqual(['qa-engineer']);
	});

	it('does not flag an action-assignment phrase in plain prose (not a heading/label line)', () => {
		expect(
			detectPassiveTeammateAsks(
				'I folded the required actions from @@architect into the tracker already.',
				slugs,
			),
		).toEqual([]);
	});

	it('flags the closing-handoff-block case: a readiness status line with no pronoun/please/?', () => {
		// The verdict-report screenshot: the report DOES end with a per-recipient
		// handoff block, but every line in it is passive. The captain line is pure
		// status — "confirms PASS", "is ready for the admin" — so it carries no
		// second-person pronoun, no `please`, no `?` and no action-assignment
		// phrase, and every earlier gate misses it. The baton-passing phrasing
		// ("ready for") is the ask signal.
		expect(
			detectPassiveTeammateAsks(
				'@@captain — SVRA re-verification confirms PASS. The July 24 CFO departure update ' +
					'is verified and properly integrated. The document is ready for the admin.',
				['captain', 'equity-analyst', 'admin'],
			),
		).toEqual(['captain']);
	});

	it('flags every passive recipient of a multi-recipient closing handoff block', () => {
		expect(
			detectPassiveTeammateAsks(
				'## Verdict\n\n' +
					'**PASS.** The update is thoroughly researched and correctly integrated. The five ' +
					'observations above are for awareness, not action items.\n\n' +
					'@@captain — re-verification confirms PASS. The document is ready for the admin.\n\n' +
					'@@equity-analyst — clean pass. Five minor observations above for your ' +
					'consideration on the next write — none are blocking.',
				['captain', 'equity-analyst', 'admin'],
			),
		).toEqual(['captain', 'equity-analyst']);
	});

	it('flags the passive line of a MIXED closing handoff block', () => {
		// The third screenshot: the block got `@captain` right on one line, then wrote
		// `@@equity-analyst` on the next — and the passive line is the one carrying the
		// explicit "Please make the correction". A sibling line being active must not
		// suppress the warning on the line that actually asks for work.
		expect(
			detectPassiveTeammateAsks(
				'**Overall: PASS.** The document is cleared with one minor correction.\n\n' +
					'@captain — the doc is signed off. The correction is minor and can be made in-line.\n\n' +
					'@@equity-analyst — strong work on the rewrite. Please make the DWS correction ' +
					'(2.92%) at your next opportunity.',
				['captain', 'equity-analyst', 'admin'],
			),
		).toEqual(['equity-analyst']);
	});

	it('flags a passive address that hands the baton back ("all yours")', () => {
		// `yours` escapes the `your` pronoun pattern — its word boundary stops at
		// the `s` — so only the baton-passing signal catches this one.
		expect(detectPassiveTeammateAsks('@@architect — analysis attached, all yours.', slugs)).toEqual(
			['architect'],
		);
	});

	it('flags the content-writer screenshot: a passive sign-off handoff on a finished draft', () => {
		// The exact stalled handoff: a completion report ends with a passive
		// `@@marketing-lead — ready for review.`, which renders as the bare word
		// `marketing-lead` (a delivered-LOOKING link) and wakes no one. The trailing
		// sentence is pure status, so `ready for` is the only ask signal present.
		expect(
			detectPassiveTeammateAsks(
				'hiddentao.com canonical draft complete at assets/community-posts/article.md ' +
					'(2,801 words, 10 sections).\n\n' +
					'@@marketing-lead — ready for review. Dev.to adaptation follows after this ' +
					'version is approved.',
				['marketing-lead', 'captain', 'admin'],
			),
		).toEqual(['marketing-lead']);
	});

	it('flags a passive handoff that names the gate instead of the person', () => {
		// The same closing-handoff shape with the `ready` opener dropped — the line
		// names only what is being waited on. Each of these was silent until the
		// gate-word signals joined the baton-passing set.
		for (const line of [
			'@@marketing-lead — awaiting review.',
			'@@marketing-lead — awaiting final sign-off.',
			'@@marketing-lead — for review.',
			'@@marketing-lead — pending approval before publication.',
			'@@marketing-lead — sign-off needed before publication.',
			'@@marketing-lead — needs signoff.',
		]) {
			expect(detectPassiveTeammateAsks(line, ['marketing-lead', 'admin'])).toEqual([
				'marketing-lead',
			]);
		}
	});

	it('flags a passive address that passes the baton on ("passing this to …")', () => {
		// `pass` is the same verb class as the `hand …` signal, which alone missed it.
		expect(
			detectPassiveTeammateAsks('@@architect — passing this back after the rewrite.', slugs),
		).toEqual(['architect']);
		expect(
			detectPassiveTeammateAsks('**@@architect** — passed it back for the rewrite.', slugs),
		).toEqual(['architect']);
	});

	it('does not flag a gate word in narration around a non-addressed passive reference', () => {
		// "for review" is the signal, but nothing addresses the teammate — the passive
		// mention sits mid-sentence as attribution, so the address gate rejects it
		// before the ask gate is ever consulted.
		expect(
			detectPassiveTeammateAsks(
				'The doc went out for review last week; @@architect wrote the brief.',
				slugs,
			),
		).toEqual([]);
	});

	it('scopes the baton-passing signal to the emphasised address paragraph', () => {
		// The readiness line is about the work, in its own paragraph; the emphasised
		// address is a plain recap and must not inherit the other paragraph's signal.
		// (The emphasised form is the one still gated on ask intent — a leading-line
		// address is flagged on sight, see below.)
		expect(
			detectPassiveTeammateAsks(
				'The doc is ready for the admin.\n\n**@@architect** merged and shipped.',
				slugs,
			),
		).toEqual([]);
	});

	it('flags a line-leading passive address even when the line is pure status', () => {
		// The canonical miss: `@@admin — release is done.` is not a note filed for the
		// record, it asks the admin to register the fact — but it carries no pronoun,
		// no `please` and no `?`, so no ask gate could ever see it. The line-opening
		// address shape is reserved for active mentions, so the passive marking is
		// wrong on sight and warns with no ask gate at all.
		expect(detectPassiveTeammateAsks('@@admin — release is done.', slugs)).toEqual(['admin']);
		expect(detectPassiveTeammateAsks('@@architect — merged and shipped.', slugs)).toEqual([
			'architect',
		]);
		// Every addressing separator counts, not just the dash.
		expect(detectPassiveTeammateAsks('@@admin: release is done.', slugs)).toEqual(['admin']);
	});

	it('does not flag a passive reference that lives inside the sentence', () => {
		// The escape hatch the rule leaves open: a reference you genuinely only mean to
		// MAKE goes mid-sentence, where it is not an address and never warns.
		expect(
			detectPassiveTeammateAsks(
				'Release is done; @@admin signed the changelog off earlier.',
				slugs,
			),
		).toEqual([]);
	});

	it('does not flag a mid-prose passive reference', () => {
		expect(detectPassiveTeammateAsks('as @@admin noted, ship it when you can.', slugs)).toEqual([]);
	});

	it('does not flag a slug that is also actively mentioned', () => {
		expect(detectPassiveTeammateAsks('@admin — done. cc @@admin, your call.', slugs)).toEqual([]);
	});

	it('does not flag an active-only mention', () => {
		expect(detectPassiveTeammateAsks('@architect — please review.', slugs)).toEqual([]);
	});

	it('does not flag a passive address to a non-teammate', () => {
		expect(detectPassiveTeammateAsks('@@database — check your config', slugs)).toEqual([]);
	});

	it('ignores passive asks inside inline code and fenced blocks', () => {
		expect(detectPassiveTeammateAsks('inert: `@@admin — please review` here', slugs)).toEqual([]);
		expect(detectPassiveTeammateAsks('```\n@@admin — can you approve?\n```', slugs)).toEqual([]);
	});

	it('scopes the ask signal to the paragraph carrying the emphasised mention', () => {
		// The "you" lives in a different paragraph than **@@admin**, so no ask is
		// inferred for the emphasised form (the gated one).
		expect(
			detectPassiveTeammateAsks('**@@admin** shipped the release.\n\nthanks, you all rock', slugs),
		).toEqual([]);
	});

	describe('name-bound sign-off gate (mid-sentence, no addressing position)', () => {
		// The passive twin of the bare-name gate in unlinked-mention-ask.test.ts. The
		// shape both catch: the closing line of a review verdict that hands the next
		// action to a named approver from INSIDE the sentence, so none of the
		// address-position forms (bold, leading-line, action-assignment) can see it.
		const signoffSlugs = ['captain', 'marketing-lead', 'architect', 'admin'];

		it('flags the review-verdict screenshot case: "Ready for @@marketing-lead review."', () => {
			// The exact stalled comment: an approving review verdict whose only handoff
			// is a mid-sentence passive reference. It rendered as a delivered-looking
			// chip, so the report read as routed - and the marketing-lead was never woken.
			expect(
				detectPassiveTeammateAsks(
					'**Blocking findings:** None - the previous blocking finding is resolved.\n\n' +
						'**Verdict:** APPROVED - the fix is correct and complete. Ready for ' +
						'@@marketing-lead review.',
					signoffSlugs,
				),
			).toEqual(['marketing-lead']);
		});

		it("leaves the same report's attribution references passive", () => {
			// Same comment, the body line above the verdict: "as previously flagged by
			// @@captain and @@marketing-lead" credits both and asks nothing, so neither
			// is flagged for it - only the closing handoff is.
			expect(
				detectPassiveTeammateAsks(
					'The commit body still states the wrong root cause, as previously flagged by ' +
						'@@captain and @@marketing-lead. The `static/` copy is the correct fix regardless.',
					signoffSlugs,
				),
			).toEqual([]);
		});

		it('flags the gate → name → object forms (needs/pending/for/awaiting)', () => {
			expect(
				detectPassiveTeammateAsks("The draft needs the @@marketing-lead's approval.", signoffSlugs),
			).toEqual(['marketing-lead']);
			expect(detectPassiveTeammateAsks('Left it pending @@captain review.', signoffSlugs)).toEqual([
				'captain',
			]);
			expect(
				detectPassiveTeammateAsks('Parked for @@architect sign-off before release.', signoffSlugs),
			).toEqual(['architect']);
			expect(
				detectPassiveTeammateAsks('The ticket stays in review awaiting @@captain sign-off.', [
					'captain',
				]),
			).toEqual(['captain']);
		});

		it('flags the name → pending-action forms (modal required)', () => {
			for (const line of [
				'@@captain to sign off next.',
				'@@captain must approve before publication.',
				'@@captain still needs to review the copy.',
			]) {
				expect(detectPassiveTeammateAsks(line, signoffSlugs)).toEqual(['captain']);
			}
		});

		it('agrees with the bare-name detector on the same sentence', () => {
			// The two spellings of one stranded handoff must warn alike - a passive
			// `@@slug` wakes exactly as many people as a bare name (none), so a rule
			// that fired on one and not the other would just teach the `@@` workaround.
			for (const [bareText, passiveText] of [
				['Ready for marketing-lead review.', 'Ready for @@marketing-lead review.'],
				['Awaiting captain sign-off before merge.', 'Awaiting @@captain sign-off before merge.'],
				['The architect must approve the copy.', 'The @@architect must approve the copy.'],
			]) {
				const bare = detectUnlinkedTeammateAsks(bareText, signoffSlugs);
				expect(bare.length).toBeGreaterThan(0);
				expect(detectPassiveTeammateAsks(passiveText, signoffSlugs)).toEqual(bare);
			}
		});

		it('does NOT flag a granted/past sign-off (no pending gate, no modal)', () => {
			expect(
				detectPassiveTeammateAsks(
					"The @@captain's approval was already granted last week.",
					signoffSlugs,
				),
			).toEqual([]);
			expect(
				detectPassiveTeammateAsks('@@captain approved the plan on Monday.', signoffSlugs),
			).toEqual([]);
		});

		it('does NOT flag a gate word with no passive name bound to it', () => {
			expect(detectPassiveTeammateAsks('The draft is awaiting review.', signoffSlugs)).toEqual([]);
		});

		it('does NOT flag a name only actively @-mentioned in the same sign-off recap', () => {
			// @captain already wakes, so the gate must not double-flag the passive echo.
			expect(
				detectPassiveTeammateAsks('@captain - this is awaiting @@captain sign-off.', signoffSlugs),
			).toEqual([]);
		});

		it('does NOT flag a gate word narrated around a non-addressed passive reference', () => {
			expect(
				detectPassiveTeammateAsks(
					'The doc went out for review last week; @@captain wrote the brief.',
					signoffSlugs,
				),
			).toEqual([]);
		});
	});
});

describe('MCP create_comment / update_comment warn on passive-mention asks', () => {
	let app: Hono<Env>;
	let db: Db;
	let token: string;
	let masterKeyManager: MasterKeyManager;

	let teamId: string;
	let projectId: string;
	let architectId: string;
	let architectSlug: string;
	let productLeadId: string;
	let captainId: string;

	async function insertTask(assigneeId: string, title: string): Promise<string> {
		const meta = await db.query<{ task_prefix: string; number: number }>(
			`SELECT p.task_prefix, next_project_task_number(p.id) AS number
			 FROM projects p WHERE p.id = $1`,
			[projectId],
		);
		const n = meta.rows[0].number;
		const res = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
			 VALUES ($1, $2, $3, $4, $5, $6, 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING id`,
			[teamId, projectId, assigneeId, n, `${meta.rows[0].task_prefix}-${n}`, title],
		);
		return res.rows[0].id;
	}

	async function callTool(
		agentToken: string,
		name: string,
		args: Record<string, unknown>,
	): Promise<{ id?: string; warning?: string; error?: string }> {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name, arguments: args },
				id: 1,
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { content: Array<{ type: string; text: string }> };
		};
		return JSON.parse(body.result.content[0].text) as {
			id?: string;
			warning?: string;
			error?: string;
		};
	}

	async function adminMentionCount(commentId: string): Promise<number> {
		const r = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM admin_mentions WHERE comment_id = $1`,
			[commentId],
		);
		return r.rows[0].c;
	}

	beforeAll(async () => {
		const ctx = await createTestApp();
		app = ctx.app;
		db = ctx.db;
		token = ctx.token;
		masterKeyManager = ctx.masterKeyManager;

		const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
		const typeId = (await typesRes.json()).data.find(
			(t: Record<string, unknown>) => t.name === 'App Team',
		).id;

		const teamRes = await createTestTeam(db, { name: 'Passive Co', template_id: typeId });
		teamId = (await teamRes.json()).data.id;

		const projectData = (await (await createTestProject(db, teamId, { name: 'Project' })).json())
			.data;
		projectId = projectData.id;

		const agentsRes = await app.request(`/api/projects/${projectData.slug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
		const architect = agents.find((a) => a.slug === 'architect')!;
		architectId = architect.id;
		architectSlug = architect.slug;
		productLeadId = agents.find((a) => a.slug === 'product-lead')!.id;
		captainId = agents.find((a) => a.slug === 'captain')!.id;
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('warns on a passive @@admin ask and notifies no one', async () => {
		const taskId = await insertTask(architectId, 'Passive admin ask');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			productLeadId,
			teamId,
			taskId,
			{ projectId },
		);
		const result = await callTool(agentToken, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: "@@admin — the drafts are ready for your re-review when you're set.",
		});
		expect(result.warning).toBeDefined();
		expect(result.warning).toContain('admin');
		expect(result.warning).toContain('active mention');
		// The passive form genuinely notified no one.
		expect(await adminMentionCount(result.id!)).toBe(0);
	});

	it('warns on the routing-label handoff `**Next step:** @@captain — …your…` (screenshot case)', async () => {
		const taskId = await insertTask(captainId, 'Routing-label captain handoff');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			productLeadId,
			teamId,
			taskId,
			{ projectId },
		);
		const result = await callTool(agentToken, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content:
				'**Next step:** @@captain — this draft is reviewed and approved from my side. Ready ' +
				'for your strategic review before we schedule.',
		});
		expect(result.warning).toBeDefined();
		expect(result.warning).toContain('captain');
		expect(result.warning).toContain('active mention');
	});

	it('warns on a verdict report whose closing handoff block is all passive (screenshot case)', async () => {
		const taskId = await insertTask(architectId, 'Verdict report closing block');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			productLeadId,
			teamId,
			taskId,
			{ projectId },
		);
		const result = await callTool(agentToken, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content:
				'## Verdict\n\n**PASS.** The update is thoroughly researched and correctly ' +
				'integrated. The observations above are for awareness, not action items.\n\n' +
				'@@captain — re-verification confirms PASS. The document is ready for the admin.',
		});
		expect(result.warning).toBeDefined();
		expect(result.warning).toContain('captain');
		expect(result.warning).toContain('active mention');
	});

	it('warns on a review verdict whose only handoff is a mid-sentence sign-off gate (screenshot case)', async () => {
		// The stalled comment: findings, then `Ready for @@captain review.` as the last
		// sentence. Nothing opens a line with the name and nothing is bold, so every
		// address-position form misses it - yet that sentence IS the handoff, and the
		// passive marking meant the approver was never woken.
		const taskId = await insertTask(architectId, 'Verdict with mid-sentence sign-off gate');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			productLeadId,
			teamId,
			taskId,
			{ projectId },
		);
		const result = await callTool(agentToken, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content:
				'**Advisory findings:**\n\n- The PR description still references the old path; the ' +
				'commit itself is correct, so this is cosmetic.\n\n**Blocking findings:** None - the ' +
				'previous blocking finding is resolved.\n\n**Verdict:** APPROVED - the fix is correct ' +
				'and complete. Ready for @@captain review.',
		});
		expect(result.warning).toBeDefined();
		expect(result.warning).toContain('@@captain');
		expect(result.warning).toContain('@captain');
		expect(result.warning).toContain('sign-off gate');
	});

	it('does not warn when the same verdict routes with an active mention', async () => {
		// The correct form of the comment above: the closing handoff is active, so the
		// approver is genuinely woken and the advisory stays quiet.
		const taskId = await insertTask(architectId, 'Verdict with active handoff');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			productLeadId,
			teamId,
			taskId,
			{ projectId },
		);
		const result = await callTool(agentToken, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content:
				'**Verdict:** APPROVED - the fix is correct and complete.\n\n' +
				'@captain - ready for your review.',
		});
		expect(result.warning).toBeUndefined();
	});

	it('warns on a line-leading passive @@admin address even with no ask intent', async () => {
		const taskId = await insertTask(architectId, 'Passive admin FYI');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			productLeadId,
			teamId,
			taskId,
			{ projectId },
		);
		const result = await callTool(agentToken, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: '@@admin — release is done.',
		});
		expect(result.warning).toContain('@@admin');
		expect(result.warning).toContain('@admin');
		// The warning explains the escape hatch: move the reference into the sentence.
		expect(result.warning).toContain('move the');
		// Still passive, so it genuinely notified no one — that is the bug being flagged.
		expect(await adminMentionCount(result.id!)).toBe(0);
	});

	it('does not warn on an active @admin ask and does notify', async () => {
		const taskId = await insertTask(architectId, 'Active admin ask');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			productLeadId,
			teamId,
			taskId,
			{ projectId },
		);
		const result = await callTool(agentToken, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: '@admin — the drafts are ready for your re-review.',
		});
		expect(result.warning).toBeUndefined();
		expect(await adminMentionCount(result.id!)).toBeGreaterThan(0);
	});

	it('does not warn when an agent passively addresses itself', async () => {
		const taskId = await insertTask(architectId, 'Self passive ask');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskId,
			{ projectId },
		);
		const result = await callTool(agentToken, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: `@@${architectSlug} — remember to review your own plan.`,
		});
		expect(result.warning).toBeUndefined();
	});

	it('warns when an edit turns a comment into a passive @@admin ask', async () => {
		const taskId = await insertTask(architectId, 'Edit into passive ask');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			productLeadId,
			teamId,
			taskId,
			{ projectId },
		);
		const created = await callTool(agentToken, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: 'Draft ready.',
		});
		expect(created.warning).toBeUndefined();

		const edited = await callTool(agentToken, 'update_comment', {
			project: projectId,
			task_id: taskId,
			comment_id: created.id,
			content: '@@admin — please take a look when you can.',
		});
		expect(edited.warning).toBeDefined();
		expect(edited.warning).toContain('admin');
		expect(await adminMentionCount(created.id!)).toBe(0);
	});
});
