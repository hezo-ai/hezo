import { DEFAULT_TEAM_ID, HEZO_DOCS_URL } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { resolveSystemPrompt } from '../src/services/template-resolver';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	projectSlugForTeamSlug,
} from './helpers/app';

let db: Db;
let app: Hono<Env>;
let token: string;
let teamId: string;
let projectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const teamRes = await createTestTeam(db, {
		name: 'Template Co',

		description: 'Build amazing things',
	});
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Template Project',
		description: 'Test project.',
	});
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('template resolver', () => {
	it('resolves {{current_date}}', async () => {
		const result = await resolveSystemPrompt(db, 'Today is {{current_date}}.', {
			teamId,
		});
		expect(result).toMatch(/Today is \d{4}-\d{2}-\d{2}\./);
	});

	it('resolves {{team_name}}', async () => {
		const result = await resolveSystemPrompt(db, 'Working for {{team_name}}.', {
			teamId,
		});
		expect(result).toContain('Working for Template Co.');
	});

	it('appends the report_no_work guidance to every runtime prompt', async () => {
		const result = await resolveSystemPrompt(db, 'Base prompt.', { teamId });
		expect(result).toContain('No Work To Do This Run');
		expect(result).toContain('report_no_work');
		// Re-engagement guard: a re-woken agent must recognise an already-handed-off
		// ticket and no-op rather than redo work that is now in a teammate's court.
		expect(result).toContain('already handed this ticket off');
	});

	it('routes recurring work to standing tasks and frames goals as outcomes', async () => {
		const result = await resolveSystemPrompt(db, 'Base prompt.', { teamId });
		// Positive framing: describe how scheduled work IS done rather than what's absent,
		// so an agent routes a repeating need instead of asking for a cron feature.
		expect(result).toContain('### Recurring & Scheduled Work');
		expect(result).toContain('goals are not a scheduler');
		// Recurring operational work is a standing task the heartbeat re-visits.
		expect(result).toContain('standing task');
		// Goals are outcomes the admin wants — elicited from them, never invented.
		expect(result).toContain('Project goals are outcomes, not schedules');
		expect(result).toContain('ask the admin what they want the project to achieve');
		// The goal-vs-task rule: a finite deliverable is a task, not a goal.
		expect(result).toContain('fixed done state');
	});

	it('appends the credential-handling guidance to every runtime prompt', async () => {
		const result = await resolveSystemPrompt(db, 'Base prompt.', { teamId });
		// The paste form is the only channel — never accept a plaintext secret in chat.
		expect(result).toContain('the only way a secret value reaches you');
		// Agents must scope request_credential to the upstream API host(s).
		expect(result).toContain('the upstream API host');
		// In-container tools that read a credential from env ride a project-scoped
		// local MCP connection (placeholder in config.env), not a hand-injected global
		// secret — so two projects' credentials for the same service don't collide.
		expect(result).toContain('add_connector');
		expect(result).toContain('config.env');
	});

	it('tells agents to record and maintain a skill for a connected service, scoped to the connector', async () => {
		const result = await resolveSystemPrompt(db, 'Base prompt.', { teamId });
		// After getting a connector working, the integration know-how is persisted
		// as a skill for teammates.
		expect(result).toContain('#### Record the service as a skill once the connector works');
		expect(result).toContain('persist it as a skill before you move on');
		// Skills are maintained, not write-once: same slug + scope upserts in place.
		expect(result).toContain('Skills are living documents');
		expect(result).toContain('same slug and scope');
		// Public-first: search skills.sh / vendor skill files and persist rather
		// than authoring a duplicate.
		expect(result).toContain('Check for an existing public skill before authoring your own');
		// Scope heuristic: the skill's scope follows the connector's reach.
		expect(result).toContain("Match the skill's scope to the connector's reach");
		// Layering: project specifics go in a project skill that references the
		// general skill, not a fork of it.
		expect(result).toContain('references the general skill by slug');
	});

	it('makes checking the skills manifest for a relevant skill mandatory before any write or edit', async () => {
		const result = await resolveSystemPrompt(db, 'Base prompt.', { teamId });
		// Every agent, every run, must scan the manifest and load an applicable
		// skill BEFORE producing/modifying the deliverable — not after.
		expect(result).toContain('MANDATORY, every run, before you write or edit anything');
		expect(result).toContain('every agent on every run');
		// Load the full body first, then work — don't consult it afterward.
		expect(result).toContain('load its full body **first**');
		// Err toward loading when relevance is uncertain.
		expect(result).toContain('load it and see');
		// get_skill is the ONLY loader — agents must not reach for the coding
		// CLI's own skill feature (a Skill tool, /skill command, or file read),
		// which doesn't know these DB-backed slugs and fails with "unknown skill".
		expect(result).toContain('`get_skill` is the only way to load a Hezo skill');
		expect(result).toContain('never try to load one with the CLI');
	});

	it('appends the ask-before-closing completion rule', async () => {
		const result = await resolveSystemPrompt(db, 'Base prompt.', { teamId });
		// Never mark done while an active mention you posted awaits an answer —
		// and never close first and ask after.
		expect(result).toContain('ask BEFORE closing, never close-then-ask');
		// The server-enforced half: done is rejected while an @admin ask lacks a
		// later human reply.
		expect(result).toContain('has no later human reply');
		expect(result).toContain('the only correct state to wait in');
	});

	it('tells agents the admin has no mark-done control and completion is the agent action', async () => {
		const result = await resolveSystemPrompt(db, 'Base prompt.', { teamId });
		// The admin cannot mark a ticket done from the UI — Close cancels — so the
		// agent must complete it itself or ask the admin to approve, never delegate
		// the done-transition.
		expect(result).toContain('the admin has no "mark done" button');
		expect(result).toContain('Asking the admin to **approve** completion is correct');
	});

	it('appends the cancellation hand-back rule with the admin/CEO carve-out', async () => {
		const result = await resolveSystemPrompt(db, 'Base prompt.', { teamId });
		// A manager must hand an active task back to wind down, not cancel it out from under
		// the assignee.
		expect(result).toContain('hand it back to wind down first');
		// ...except the human admin and the CEO, who may cancel unilaterally.
		expect(result).toContain('without recourse');
	});

	it('resolves {{team_description}} to team description', async () => {
		const result = await resolveSystemPrompt(db, 'Desc: {{team_description}}', {
			teamId,
		});
		expect(result).toContain('Desc: Build amazing things');
	});

	it('leaves the removed {{team_mission}} placeholder untouched', async () => {
		const result = await resolveSystemPrompt(db, 'Mission: {{team_mission}}', {
			teamId,
		});
		// team_mission was retired; the resolver no longer substitutes it.
		expect(result).toContain('Mission: {{team_mission}}');
	});

	it('resolves team_name and team_description in a single query', async () => {
		const result = await resolveSystemPrompt(db, '{{team_name}} - ({{team_description}})', {
			teamId,
		});
		expect(result).toContain('Template Co - (Build amazing things)');
	});

	it('resolves {{team_preferences_context}} with no prefs', async () => {
		const result = await resolveSystemPrompt(db, 'Prefs: {{team_preferences_context}}', {
			teamId,
		});
		expect(result).toContain('No preferences set');
	});

	it('resolves {{project_docs_context}} to empty-state when the project has no docs', async () => {
		// The team already owns its one project (created in beforeAll), and the 1:1
		// invariant forbids a second on the same team — so the docless project lives
		// on its own fresh team.
		const doclessTeamRes = await createTestTeam(db, {
			name: 'Docless Co',
			description: 'No docs here',
		});
		const doclessTeamId = (await doclessTeamRes.json()).data.id as string;
		const bare = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, description, docker_base_image)
			 VALUES ($1, 'Docless', 'docless', 'DL', 'No docs here', 'hezo/agent-base:latest')
			 RETURNING id`,
			[doclessTeamId],
		);
		const result = await resolveSystemPrompt(db, 'Docs: {{project_docs_context}}', {
			teamId: doclessTeamId,
			projectId: bare.rows[0].id,
		});
		expect(result).toContain('No project documentation available');
		// Even with zero docs (the onboarding/team-setup case) the empty state must
		// steer the agent off filesystem probes toward the DB-backed doc tools.
		expect(result).toContain('not the filesystem');
		expect(result).toContain('write_project_doc');
	});

	it('renders {{project_docs_context}} as a metadata manifest pointing at read_project_doc', async () => {
		const docRes = await app.request(`/api/projects/${projectId}/docs/spec.md`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content: 'Detailed spec.',
				description: 'The technical spec for the build.',
			}),
		});
		expect(docRes.status).toBe(200);

		const result = await resolveSystemPrompt(db, '{{project_docs_context}}', {
			teamId,
			projectId,
		});

		expect(result).toContain('The project docs database holds high-level project context');
		expect(result).toContain('read_project_doc(filename)');

		// The manifest warns docs are not on disk, steering agents off filesystem probes.
		expect(result).toContain('not the filesystem');
		expect(result).toContain('/workspace/.hezo/project-docs');

		// It also names the *write* path so agents don't reflexively reach for the
		// Edit/Write file tools when they go to change a doc (they target disk).
		expect(result).toContain('write_project_doc(filename, content)');
		expect(result).toContain('will not touch these');

		// Described doc — the manifest shows "filename — description (updated date)".
		expect(result).toMatch(
			/- spec\.md — The technical spec for the build\. \(updated \d{4}-\d{2}-\d{2}\)/,
		);

		// Description-less doc (architecture-guidelines.md is seeded with no description) —
		// no em-dash, no "undefined".
		expect(result).toMatch(/- architecture-guidelines\.md \(updated \d{4}-\d{2}-\d{2}\)/);
		expect(result).not.toContain('architecture-guidelines.md —');
		expect(result).not.toContain('undefined');

		// Doc bodies and the old warning copy are gone — the whole point of the manifest.
		expect(result).not.toContain('Detailed spec.');
		expect(result).not.toContain('### spec.md');
		expect(result).not.toContain('Edit`/`Write` tools will NOT work');
		expect(result).not.toContain('use `write_project_doc`');
	});

	it('sorts the {{project_docs_context}} manifest by filename', async () => {
		const teamRes = await createTestTeam(db, { name: 'Sort Co', description: '' });
		const sortTeamId = (await teamRes.json()).data.id as string;
		const proj = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, description, docker_base_image)
			 VALUES ($1, 'Sort', 'sort', 'SO', '', 'hezo/agent-base:latest')
			 RETURNING id`,
			[sortTeamId],
		);
		const sortProjectId = proj.rows[0].id;
		await db.query(
			`INSERT INTO documents (team_id, project_id, type, slug, content)
			 VALUES ($1, $2, 'project_doc', 'z-last.md', 'z'),
			        ($1, $2, 'project_doc', 'a-first.md', 'a')`,
			[sortTeamId, sortProjectId],
		);

		const result = await resolveSystemPrompt(db, '{{project_docs_context}}', {
			teamId: sortTeamId,
			projectId: sortProjectId,
		});
		const aIdx = result.indexOf('a-first.md');
		const zIdx = result.indexOf('z-last.md');
		expect(aIdx).toBeGreaterThan(-1);
		expect(zIdx).toBeGreaterThan(aIdx);
	});

	it('passes through text without template variables', async () => {
		const result = await resolveSystemPrompt(db, 'Hello world', { teamId });
		expect(result).toContain('Hello world');
	});

	it('resolves multiple variables in one template', async () => {
		const result = await resolveSystemPrompt(db, 'Team: {{team_name}}, Date: {{current_date}}', {
			teamId,
		});
		expect(result).toContain('Team: Template Co');
		expect(result).toMatch(/Date: \d{4}-\d{2}-\d{2}/);
	});

	it('resolves {{reports_to}} without agentId to empty string', async () => {
		const result = await resolveSystemPrompt(db, 'Reports to: {{reports_to}}', {
			teamId,
		});
		expect(result).toContain('Reports to: ');
	});

	it('resolves {{requester_context}} to empty string', async () => {
		const result = await resolveSystemPrompt(db, 'Context: {{requester_context}}', {
			teamId,
		});
		expect(result).toContain('Context: ');
	});

	it('appends shared working guidelines to every prompt', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		expect(result).toContain('## Working Guidelines');
		// Every agent is told up front that Hezo entities (docs, assets, tickets,
		// skills) live in the DB and are reached via their MCP tools — not as files
		// on the container filesystem — so none burns a run rediscovering it.
		expect(result).toContain(
			'### Hezo Entities Live in the Database, Not on the Container Filesystem',
		);
		expect(result).toContain('read_project_doc');
		expect(result).toContain('### Ticket Maintenance');
		expect(result).toContain('### Creating Tickets');
		expect(result).toContain('### Ticket Dependencies');
		expect(result).toContain('### Completion Handoff');
		expect(result).toContain('### @-Mentions, Linking & Handoffs');
		expect(result).toContain('### Knowledge Maintenance');
		expect(result).toContain('### Sub-Agents & Parallel Exploration');
		// Before doing assigned work, an agent must first decide whether parts of it
		// belong to a direct report and delegate rather than absorbing it all —
		// acute on "redo / revise / fix" assignments that re-do the team's prior work.
		expect(result).toContain('### Decide Who Owns the Work Before Defaulting to Doing It Yourself');
		expect(result).toContain('redo / revise / fix');
		expect(result).toContain('### Sub-Tasks & Delegation');
		// A defect in the agent's own in-flight deliverable must be fixed on the
		// current ticket, not offloaded into a sub-task/peer ticket (PR-cascade fix).
		expect(result).toContain('A defect in your own in-flight work is NOT a new ticket');
		expect(result).toContain('### Assigning Work');
		expect(result).toContain('### Fetching External URLs');
		expect(result).toContain('curl');
		expect(result).toContain('### Comments');
		expect(result).toContain('update_task');
		expect(result).toContain('write_project_doc');
		expect(result).toContain('create_skill');
		expect(result).toContain('create_task');
		// Every agent must seek admin approval before mutating an external service, and
		// must inspect for an existing resource before creating a duplicate.
		expect(result).toContain('### Changes to External Services Require Admin Approval');
		expect(result).toContain('Inspect before you write');
	});

	it('tells every agent the run is headless and not to point the user at terminal/adapter commands', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		expect(result).toContain('### Your Run Is Headless');
		// The execution model: the user cannot attach to or drive the adapter terminal.
		expect(result).toContain('cannot attach to it');
		expect(result).toContain('interactive/slash commands');
		// Hezo (comments/chat/docs) is the only channel back to the operator.
		expect(result).toContain('Hezo is the only channel to the user');
		// The exact misfire from the live chat: telling the operator to watch progress via
		// an adapter slash command they can't reach.
		expect(result).toContain('Never tell the user to run a terminal or adapter command');
		expect(result).toContain('watch it progress with `/workflows`');
		expect(result).toContain('it does not control your run');
	});

	it('teaches that a status-phrased handoff (e.g. "ready for review") is an active-`@` ask', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// A baton-passing line with no imperative verb still wakes the next actor —
		// guards against the passive-mention misclassification that strands review handoffs.
		expect(result).toContain('baton-passing handoff is an ask even when it reads as a status line');
		expect(result).toContain('who is expected to act next on this ticket?');
		expect(result).toContain('ready for review');
	});

	it('tells a triage run to post a summary comment when it acted or the admin mentioned it, not just an ack', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// A mention on someone else's ticket used to end with an ack reaction only.
		// Now a substantive triage response — or any admin mention — also gets a short
		// summary comment on the triggering thread so the mentioner sees what was done,
		// not just that it was seen.
		expect(result).toContain(
			'a reaction alone tells the commenter you saw the mention, not what you did with it',
		);
		expect(result).toContain('you took substantive action this run');
		expect(result).toContain('the mentioner is the admin');
		expect(result).toContain(
			'Post the reaction alone — no comment — only when the mention was purely informational',
		);
	});

	it('requires an agent asked a question to answer it as a comment (teammate or admin)', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// A question from a teammate or the admin is answered on the thread, not with a
		// bare reaction — on the agent's own ticket and on the triage path alike, and the
		// general Comments guidance names answering a question as an end-of-run comment.
		expect(result).toContain('answer any question it asks by posting your answer as a comment');
		expect(result).toContain('the mention asks you something only you can answer');
		expect(result).toContain('the comment IS your answer');
		expect(result).toContain('an answer to a question you were asked');
	});

	it('promotes the universal partials into the shared guidelines for every agent', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// check-before-create
		expect(result).toContain('Check before you create');
		expect(result).toContain('`list_tasks`');
		// no-auto-timelines
		expect(result).toContain("Don't invent timelines or deadlines");
		// ticket-dependencies (gate upstream too)
		expect(result).toContain('Gate upstream too');
		// assignment-hierarchy
		expect(result).toContain('You can assign only to yourself or a direct report');
		// subtask-preference (deliverable-feed test + fan-out tell) + skills discovery
		expect(result).toContain('deliverable-feed test');
		expect(result).toContain('Fanning work out from the ticket you are on');
		expect(result).toContain('npx skills find');
		// comment hygiene (no-redundant-comments + comment-formatting)
		expect(result).toContain("Don't repost when nothing changed");
		expect(result).toContain('Format as proper markdown');
	});

	it('scopes inline code to code tokens and forbids backticking linkable references', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// The old wording told agents to backtick "filenames and identifiers",
		// which conflicts with the bare-reference rule and renders links inert.
		expect(result).not.toContain('`inline code` for filenames and identifiers');
		expect(result).toContain('Use `inline code` only for literal code tokens');
		expect(result).toContain('backticks make all of these inert');
	});

	it('anti-repost rule points at update_comment and covers gate continuations', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// A formatting-only fix must be an in-place edit, not a reposted copy.
		expect(result).toContain('edit it in place with `update_comment`');
		expect(result).toContain('never repost a reformatted or reworded copy');
		// Being continued by the completeness gate is not licence to re-summarize.
		expect(result).toContain('Being re-woken by the completeness gate');
	});

	it('completion handoff guidance covers mark-done, auto-wake, and no-mention rules', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		expect(result).toContain('### Completion Handoff');
		expect(result).toContain('update_task(status: "done")');
		expect(result).toContain('dependents');
		expect(result).toContain('do not `@`-mention any agent in that comment');
	});

	it('completion handoff tells agents to track the full approval chain before closing', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// The incident: a reviewer marked the ticket done on its own review after a
		// rework/detour, forgetting the admin's final approval was still owed. A
		// reviewer's own pass is one link in the chain, not the terminal approval.
		expect(result).toContain("A reviewer's own pass is not the ticket's final approval");
		expect(result).toContain('who still owes an approval');
		expect(result).toContain('stated by **any** participant');
		// A rework/detour does not discharge a still-outstanding approval.
		expect(result).toContain('does **not** discharge a pending approval');
		// The fix: a live @-mention ask with the ticket kept non-terminal, not prose.
		expect(result).toContain('post the approval request as a **live `@`-mention ask**');
		expect(result).toContain('A prose "ready for admin approval"');
	});

	it('completion handoff requires reconciling an announced plan before closing', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// An agent that announced a fan-out, got the unblocking answer, then silently
		// did a fraction and closed leaves readers unable to tell scope-collapse from
		// dropped work — the wrap-up must reconcile the announced plan.
		expect(result).toContain('Reconcile your announced plan before you close');
		expect(result).toContain('indistinguishable from dropping work');
		expect(result).toContain('not merely acknowledging the answer');
		// Announcing a delegation in the thread is the decision, made and published.
		expect(result).toContain('Announcing in the thread that you will delegate');
	});

	it('tells agents not to park a done deliverable as blocked and to spin off the gated tail', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		expect(result).toContain(
			"Don't park a ticket `blocked` when your own deliverable is already done",
		);
		expect(result).toContain('blocked_by_task_ids');
		expect(result).toContain('deliverable-feed test');
	});

	it('tells reviewers/consolidators to gate the originating ticket blocked_by spawned remediation', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		expect(result).toContain(
			"When a ticket can't close until remediation you're routing out is done, GATE it",
		);
		// a passive task-link does not re-wake; only a blocked_by edge does
		expect(result).toContain('add_task_blocker');
		expect(result).toContain('many-to-many');
	});

	it('mention discipline names the structural-routing channels and the handoff carve-out', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		expect(result).toContain('### @-Mentions, Linking & Handoffs');
		// structural channels that already wake the recipient
		expect(result).toContain('`create_task` with an `assignee_slug`');
		expect(result).toContain('`blocked_by`');
		expect(result).toContain('the cascade will release');
		// explicit carve-out: structural routing already wakes them, so use @@
		expect(result).toContain('Structural routing already wakes the recipient');
		expect(result).toContain('Write `@@<slug>`');
	});

	it('mention discipline requires an active @ when no structural wake backs the handoff', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		expect(result).toContain('A handoff with nothing structural behind it uses active');
		// the approval-to-merge / hand-back case that stalls on a passive @@
		expect(result).toContain('the mention is the only wake there is');
		expect(result).toContain('A passive `@@` there pings no one and the ticket stalls');
		// a direct instruction to the assignee leads the section as a co-equal rule
		expect(result).toContain('A direct instruction or request is the only wake there is');
		// rubric carries the directive phrasing that misfired as passive
		expect(result).toContain('you can proceed');
	});

	it('mention discipline warns that a bold/plain teammate name with no @ prefix wakes no one', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// a name needs @/@@ to register; bare/bold is not a mention
		expect(result).toContain('a bare name is not a mention');
		// the exact bug shape: bold name + imperative reads as an address but pings nobody
		expect(result).toContain('**devops-engineer**');
		expect(result).toContain('emphasis is not a substitute for `@`');
	});

	it('mention discipline gives an active mention one canonical shape: `@<slug> - ` then the ask', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// the shape rule itself: slug opens the line, hyphen, then the request
		expect(result).toContain('Every active mention has one shape');
		expect(result).toContain('A line starting with `@<slug> - ` is an active mention');
		// the corollary that keeps the shape from swallowing plain references
		expect(result).toContain('a teammate you are only naming does not get this shape at all');
		// the worked example teaches the hyphen separator, not an em dash
		expect(result).toContain('`@<slug> - please re-run the fixture and confirm it passes.`');
	});

	it('mention discipline requires multiple recipients to be mentioned one per line', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// the antipattern: two slugs sharing one ask, so neither owns anything
		expect(result).toContain('one `@<slug>` per line, one ask per line');
		expect(result).toContain('`@<slug-a> @<slug-b> - please review`');
		expect(result).toContain('both wait and neither moves, or both do the same work twice');
		// the fenced worked example renders as real lines, not a literal \n
		expect(result).toContain(
			'\n  @<slug-a> - please re-check the totals in section 3 and correct them in place.\n',
		);
		// a teammate who owes nothing stays out of the block entirely
		expect(result).toContain('A teammate who owes none does not get a line');
	});

	it('mention discipline forbids opening a line with a passive `@@<slug> - ` address', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		expect(result).toContain('Never open a line with `@@<slug> - `');
		expect(result).toContain('The address shape is reserved for active mentions');
		// the canonical miss, and why "it was only a status line" is not a defence
		expect(result).toContain('`@@admin - release is done.`');
		expect(result).toContain('asking the admin to register that fact');
		// the escape hatch: a genuine reference goes inside a sentence, not at line head
		expect(result).toContain('never at the head of its own line');
		// a routing label in front of it is the same mistake
		expect(result).toContain('`Next step: @@<slug> - …` is the identical mistake');
		// and the detector backs the rule unconditionally
		expect(result).toContain('warns on this shape every time, ask or no ask');
	});

	it('teaches the hyphen separator consistently across the mention examples', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// The shape rule teaches `@<slug> - ask`, so no mention-address example in the
		// section may still model an em dash — a contradicted example teaches the
		// contradiction.
		for (const example of [
			'`**devops-engineer** - please update the PR`',
			'`@<slug>` - please address the required actions above',
			'`@@<slug> - verification confirms PASS',
			'`@<slug-a> - signed off, the correction can be made in-line.`',
			'`@@<slug-b> - strong work on the rewrite.',
		]) {
			expect(result).toContain(example);
		}
	});

	it('mention discipline makes routing/triage handoffs an active @, not a passive reference', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// handing work to someone to own — even tracked on a different ticket — wakes them
		expect(result).toContain('Handing work *to* someone for them to own');
		// the exact contradiction that orphaned the findings: "routed to @@<slug>"
		expect(result).toContain('"routed to `@@<slug>`" is a contradiction');
		// upward/peer handoff has no structural channel, so the active mention is it
		expect(result).toContain('`create_task` assigns downward only');
		// non-blocking follow-ups must be ticketed or actively handed off, never left as prose
		expect(result).toContain("Follow-ups that *don't* block this ticket still need an owner");
	});

	it('mention discipline makes @@ the explicit default and flags the status-recap antipattern', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// passive is the explicit presumption; the to-vs-about test leads the section
		expect(result).toContain('default to `@@`');
		expect(result).toContain('am I instructing them, or referring to them');
		// the exact pattern that over-pinged the roster: crediting people in a recap stays passive
		expect(result).toContain('Status updates and recaps credit people');
		expect(result).toContain('at most one');
		// crediting the admin in a recap is also passive — active @admin lands an
		// inbox row for every admin
		expect(result).toContain('@@admin');
	});

	it('makes asking for input an active mention and the admin ask mandatory', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// the general principle: when you are the one asking, the active mention IS the ask
		expect(result).toContain('the active mention **is** the ask');
		expect(result).toContain('A request written only as prose, or marked passive');
		// the admin-ask application: @admin is mandatory, and the prose/passive form stalls
		expect(result).toContain('the active `@admin` is **not optional — it is the ask**');
		expect(result).toContain('put `@admin` in that same comment');
		expect(result).toContain("lands in no admin's inbox");
		// a worked example demonstrates the correct active admin approval-ask
		expect(result).toContain('please review and approve the draft');
	});

	it('mention discipline makes a completion report that hands off the next action an active @, and warns against inverting admin/teammate', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// a "review complete / findings below" recap that hands the next action to a named
		// owner is a handoff — the exact screenshot failure where a passive @@ stranded it
		expect(result).toContain(
			'A completion report that hands the next action to a named owner is a handoff',
		);
		expect(result).toContain('must now act on your output');
		expect(result).toContain('consolidate it, route it');
		// the who-acts-next test is applied per name — admin isn't auto-active, teammate isn't auto-passive
		expect(result).toContain('every name independently');
		expect(result).toContain('the admin is not automatically active');
		// worked example for the review/analysis completion handoff
		expect(result).toContain('findings below for you to consolidate and route');
	});

	it('mention discipline requires the closing handoff block itself to be active, not just present', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// The screenshot failure: a verdict report DID end with a per-recipient handoff
		// block, but every line in it was passive (`@@captain — …ready for the admin.`),
		// so it looked routed and woke no one. The body's passive rule must not be read
		// as extending into the block.
		expect(result).toContain(
			'The closing handoff block only routes if its own mentions are active',
		);
		expect(result).toContain('the same stall with the ritual performed');
		// the verdict vocabulary is what disguises the ask as status
		expect(result).toContain('"PASS", "verified", "clean pass", "cleared", "ready for"');
		expect(result).toContain('every line in it is active `@<slug>`');
		// worked example carries the all-passive block as a named Bad case
		expect(result).toContain('the closing block is *there* but passive throughout');
	});

	it('mention discipline names the MIXED closing block and rejects tone as the test', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// The screenshot failure: `@captain` active on one line, `@@equity-analyst` on the
		// next — and the passive line was the one carrying an explicit "Please …".
		expect(result).toContain('A *mixed* closing block is the same bug half-applied');
		expect(result).toContain('Tone is not the test');
		expect(result).toContain('at your next opportunity');
		expect(result).toContain(
			'one active line in the block is not evidence the rest are marked right',
		);
	});

	it('mention discipline tells agents to backtick a mention token they are quoting, not using', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// The screenshot failure: an agent described an unanswered @admin ask living in an
		// earlier comment using live `@admin` tokens, firing fresh mentions here — and for
		// @admin, a fresh unanswered ask is exactly what blocks the ticket from closing.
		expect(result).toContain('Quoting a mention that lives in another comment? Backtick it');
		expect(result).toContain('does not *point at* that comment');
		// the passive form is explicitly NOT the fix — it drops the token being quoted
		expect(result).toContain('loses the very token you are quoting');
		expect(result).toContain('The test is *use vs mention*');
		// the backtick prohibition carries the matching carve-out so the rules don't fight
		expect(result).toContain('quoting rather than using');
		// and the advisory-warning list mentions the new check
		expect(result).toContain(
			'write a live mention while describing a mention that lives elsewhere',
		);
	});

	it('worked examples include a bare-vs-backticked doc/asset reference case', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// The screenshot failure: an agent backticked a doc/asset reference in a comment,
		// so it rendered as an inert code chip instead of a clickable link. The worked
		// examples (previously all @-mention active/passive) now cover this failure too.
		expect(result).toContain('Pointing a teammate or the admin at a project doc or asset');
		expect(result).toContain(
			'Hezo linkifies a document or asset reference **only** when it is bare',
		);
		expect(result).toContain('never backtick one you want opened');
	});

	it('warns agents that dropping the assets/ prefix also breaks the link and is flagged', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// The screenshot failure: a real asset backticked AND written without the
		// `assets/` prefix (`diagrams/hero.svg`). The Rules block must call out that
		// the prefix-dropped form never links and that the server now warns on it.
		expect(result).toContain('always keeps its `assets/` prefix');
		expect(result).toContain('drop the `assets/` prefix on a real asset');
	});

	it('requires verifying a wake exists before declaring you are waiting on a teammate', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// The core discipline: don't assume the other agent will pick it up — confirm a
		// real wake (assigned task, blocked_by edge, or an active @<slug>) actually exists.
		expect(result).toContain(
			"Before you state you're waiting on — or expecting — a teammate to act, confirm something will actually wake them",
		);
		expect(result).toContain("never assume they'll pick it up");
		// The exact stranded-handoff shape from the report: a prose "waiting for the
		// marketing lead" that wakes no one.
		expect(result).toContain('waiting for the marketing lead to review');
		// When unsure whether a channel exists, default to an active mention.
		expect(result).toContain('If none of the three exists — or you are unsure whether one does');
		// It must NOT tell agents to @ on top of a structural wake — that's the redundant-wakeup antipattern.
		expect(result).toContain('reference them `@@<slug>` instead');
	});

	it('completion handoff forbids ending a run waiting on a teammate with no wake created', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		expect(result).toContain(
			"Never end a run stating you're waiting on a named teammate without first creating the wake",
		);
	});

	it('no-work wait state only applies when a real wake was actually created', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		// A re-woken agent that finds its earlier "waiting on X" was only prose must post
		// the active mention now rather than calling report_no_work.
		expect(result).toContain('This wait state applies **only** if you genuinely created a wake');
	});

	it('Run Context carries no project line when no project is set', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId });
		expect(result).toContain('## Run Context');
		expect(result).not.toContain('- Project:');
		expect(result).not.toContain('Current ticket:');
	});

	it('Run Context names the project by slug (never a UUID) when projectId is set', async () => {
		const proj = await db.query<{ slug: string }>('SELECT slug FROM projects WHERE id = $1', [
			projectId,
		]);
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId, projectId });
		expect(result).toContain(`- Project: \`${proj.rows[0].slug}\``);
		expect(result).not.toContain(projectId);
		expect(result).not.toContain('Current ticket:');
	});

	it('Repository block steers GitHub work to the connected account before any PAT', async () => {
		await db.query(
			`INSERT INTO repos (project_id, repo_identifier, host_type)
			 VALUES ($1, 'acme/widget', 'github')`,
			[projectId],
		);
		await db.query(
			`UPDATE projects SET designated_repo_id = (SELECT id FROM repos WHERE project_id = $1 LIMIT 1) WHERE id = $1`,
			[projectId],
		);
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId, projectId });
		expect(result).toContain('GitHub auth is already provisioned by the project');
		expect(result).toContain('list_connectors');
		expect(result).toContain('rest_auth.placeholder');
		await db.query(`UPDATE projects SET designated_repo_id = NULL WHERE id = $1`, [projectId]);
		await db.query(`DELETE FROM repos WHERE project_id = $1`, [projectId]);
	});

	it('Run Context names the current ticket by identifier when taskId is set', async () => {
		const inserted = await db.query<{ id: string; identifier: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority, labels)
			 VALUES ($1, $2, next_project_task_number($2), 'RC-1', 'Run context ticket', 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING id, identifier`,
			[teamId, projectId],
		);
		const task = inserted.rows[0];
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId,
			projectId,
			taskId: task.id,
		});
		expect(result).toContain(`- Current ticket: \`${task.identifier}\``);
		expect(result).not.toContain(task.id);
	});

	it('preview mode substitutes placeholders, omits Run Context, keeps Teammates and Working Guidelines', async () => {
		const result = await resolveSystemPrompt(
			db,
			'Working for {{team_name}} ({{team_description}}).',
			{ teamId, mode: 'preview' },
		);
		expect(result).toContain('Working for Template Co');
		expect(result).toContain('Build amazing things');
		expect(result).not.toContain('{{');
		expect(result).not.toContain('## Run Context');
		expect(result).not.toContain(`Team ID: ${teamId}`);
		expect(result).toContain('## Teammates');
		expect(result).toContain('## Working Guidelines');
	});
});

describe('template resolver with agents', () => {
	let agentTeamId: string;
	let agentTeamSlug: string;
	let engineerAgentId: string;
	let captainAgentId: string;

	beforeAll(async () => {
		// Get the builtin team type
		const typesRes = await app.request('/api/team-templates', {
			method: 'GET',
			headers: authHeader(token),
		});
		const types = (await typesRes.json()) as any;
		const softDevType = types.data.find((t: any) => t.name === 'App Team');

		// Create a team with the software dev team type to auto-create agents
		const teamRes = await createTestTeam(db, {
			name: 'Agent Test Co',

			description: 'Test team for agent templates',
			template_id: softDevType.id,
		});
		const agentTeamData = ((await teamRes.json()) as any).data;
		agentTeamId = agentTeamData.id;
		agentTeamSlug = agentTeamData.slug;

		// Get agents
		const agentsRes = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, agentTeamSlug)}/agents`,
			{
				method: 'GET',
				headers: authHeader(token),
			},
		);
		const agents = ((await agentsRes.json()) as any).data;
		const engineer = agents.find((a: any) => a.slug === 'engineer');
		const captain = agents.find((a: any) => a.slug === 'captain');
		engineerAgentId = engineer.id;
		captainAgentId = captain.id;
	});

	it('resolves {{reports_to}} with agentId to manager display name', async () => {
		const result = await resolveSystemPrompt(db, 'Reports to: {{reports_to}}', {
			teamId: agentTeamId,
			agentId: engineerAgentId,
		});
		expect(result).toContain('Reports to: Architect');
	});

	it('resolves {{reports_to}} for a Captain to the instance CEO', async () => {
		const ceo = await db.query<{ display_name: string }>(
			`SELECT m.display_name FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE ma.slug = 'ceo' AND m.team_id = $1`,
			[DEFAULT_TEAM_ID],
		);
		const ceoName = ceo.rows[0].display_name;
		expect(ceoName).toBeTruthy();
		const result = await resolveSystemPrompt(db, 'Reports to: {{reports_to}}', {
			teamId: agentTeamId,
			agentId: captainAgentId,
		});
		// A Captain's reports_to is wired to the CEO at provisioning time
		// (linkTeamCaptainToInstanceCeo), so the placeholder resolves to the CEO.
		expect(result).toContain(`Reports to: ${ceoName}`);
	});

	it('resolves a full system prompt template with all variables', async () => {
		const template = `You are an Engineer at {{team_name}}.

You report to: Architect ({{reports_to}})

Current date: {{current_date}}

{{skills_context}}

{{team_preferences_context}}

{{project_docs_context}}

{{requester_context}}`;

		await db.query(
			"INSERT INTO skills (name, slug, description, content) VALUES ('Team Overview', 'team-overview', 'Team overview summary', '# Team Overview')",
		);

		const result = await resolveSystemPrompt(db, template, {
			teamId: agentTeamId,
			agentId: engineerAgentId,
		});

		expect(result).toContain('You are an Engineer at Agent Test Co.');
		expect(result).toContain('You report to: Architect (Architect)');
		expect(result).toMatch(/Current date: \d{4}-\d{2}-\d{2}/);
		expect(result).toContain('Team Overview');
		expect(result).toContain('No preferences set');
		expect(result).toContain('No project documentation available');
	});

	async function getAgentPrompt(agentId: string): Promise<string> {
		const res = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, agentTeamSlug)}/agents/${agentId}/system-prompt`,
			{
				headers: authHeader(token),
			},
		);
		return (((await res.json()) as any).data?.content ?? '') as string;
	}

	it('agents created from team type have system prompts', async () => {
		const agentsRes = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, agentTeamSlug)}/agents`,
			{
				method: 'GET',
				headers: authHeader(token),
			},
		);
		const agents = ((await agentsRes.json()) as any).data.filter((a: any) => !a.is_instance);

		for (const agent of agents) {
			const prompt = await getAgentPrompt(agent.id);
			expect(prompt).toBeTruthy();
			expect(prompt.length).toBeGreaterThan(100);
			expect(prompt).toContain('{{team_name}}');
			expect(prompt).toContain('{{reports_to}}');
			expect(prompt).toContain('{{skills_context}}');
			expect(prompt).toMatch(/##\s*Rules/);
		}
	});

	it('each agent has role-specific system prompt content', async () => {
		const agentsRes = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, agentTeamSlug)}/agents`,
			{
				method: 'GET',
				headers: authHeader(token),
			},
		);
		const agents = ((await agentsRes.json()) as any).data;
		const bySlug = new Map<string, any>(agents.map((a: any) => [a.slug, a]));

		expect(await getAgentPrompt(bySlug.get('captain').id)).toContain('You are the Captain of');
		expect(await getAgentPrompt(bySlug.get('architect').id)).toContain('You are the Architect at');
		expect(await getAgentPrompt(bySlug.get('product-lead').id)).toContain(
			'You are the Product Lead at',
		);
		expect(await getAgentPrompt(bySlug.get('engineer').id)).toContain('You are an Engineer at');
		expect(await getAgentPrompt(bySlug.get('qa-engineer').id)).toContain(
			'You are the QA Engineer at',
		);
		expect(await getAgentPrompt(bySlug.get('ui-designer').id)).toContain(
			'You are the UI Designer at',
		);
		expect(await getAgentPrompt(bySlug.get('devops-engineer').id)).toContain(
			'You are the DevOps Engineer at',
		);
		expect(await getAgentPrompt(bySlug.get('marketing-lead').id)).toContain(
			'You are the Marketing Lead at',
		);
		expect(await getAgentPrompt(bySlug.get('researcher').id)).toContain(
			'You are the Researcher at',
		);
	});

	it('Product Lead prompt codifies the PRD metadata header and the post-approval changelog', async () => {
		const agentsRes = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, agentTeamSlug)}/agents`,
			{ headers: authHeader(token) },
		);
		const agents = ((await agentsRes.json()) as any).data;
		const productLead = agents.find((a: any) => a.slug === 'product-lead');
		const prompt = await getAgentPrompt(productLead.id);

		// Step 5 — the metadata header attributes the PRD's author.
		expect(prompt).toContain('Author: @@product-lead');

		// Step 7 — on approval, record the approval in the changelog, linking back
		// to the approval task + comment.
		expect(prompt).toContain('Approved in <TASK-ID>#comment-<uuid>');
		// The linked comment is the triggering (admin approval) comment, never a fabricated id.
		expect(prompt).toContain('the comment that triggered this run');
	});

	it('Product Lead asks the admin with an active @admin and no longer cites option cards', async () => {
		const agentsRes = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, agentTeamSlug)}/agents`,
			{ headers: authHeader(token) },
		);
		const agents = ((await agentsRes.json()) as any).data;
		const productLead = agents.find((a: any) => a.slug === 'product-lead');
		const prompt = await getAgentPrompt(productLead.id);

		// Steps 4 (clarify) and 6 (approval) now emit an active @admin — the mention is the
		// ask that reaches the inbox, the exact step that previously stalled with no notification.
		expect(prompt).toContain('put an active `@admin` in that same comment');
		expect(prompt).toContain('with an active `@admin` in that comment');
		// Option cards are not post-able by any agent tool (create_comment is text-only),
		// so the dead guidance that told the PL to use them is gone.
		expect(prompt).not.toContain('option card');
		expect(prompt).not.toContain('structured-option');
	});

	it('Captain system prompt uses {{reports_to}} (resolves to the instance CEO)', async () => {
		const agentsRes = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, agentTeamSlug)}/agents`,
			{
				method: 'GET',
				headers: authHeader(token),
			},
		);
		const agents = ((await agentsRes.json()) as any).data;
		const captain = agents.find((a: any) => a.slug === 'captain');
		// A Captain reports to the CEO, so its prompt carries {{reports_to}} like
		// every other role; it is wired to the CEO at provisioning time.
		expect(await getAgentPrompt(captain.id)).toContain('{{reports_to}}');
	});

	it('non-Captain agents use {{reports_to}} in their system prompts', async () => {
		const agentsRes = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, agentTeamSlug)}/agents`,
			{
				method: 'GET',
				headers: authHeader(token),
			},
		);
		const agents = ((await agentsRes.json()) as any).data;
		const nonCeo = agents.filter(
			(a: any) => !a.is_instance && a.slug !== 'captain' && a.slug !== 'architect',
		);
		for (const agent of nonCeo) {
			expect(await getAgentPrompt(agent.id)).toContain('{{reports_to}}');
		}
	});
});

describe('teammates block', () => {
	let tbTeamId: string;
	let tbTeamSlug: string;
	let tbCaptainMemberId: string;
	let tbEngineerMemberId: string;

	beforeAll(async () => {
		const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
		const startup = ((await typesRes.json()) as any).data.find((t: any) => t.name === 'App Team');

		const teamRes = await createTestTeam(db, {
			name: 'Teammates Co',
			description: 'Teammates block test team',
			template_id: startup.id,
		});
		const tbTeamData = ((await teamRes.json()) as any).data;
		tbTeamId = tbTeamData.id;
		tbTeamSlug = tbTeamData.slug;

		const agentsRes = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, tbTeamSlug)}/agents`,
			{
				headers: authHeader(token),
			},
		);
		const agents = ((await agentsRes.json()) as any).data;
		tbCaptainMemberId = agents.find((a: any) => a.slug === 'captain').id;
		tbEngineerMemberId = agents.find((a: any) => a.slug === 'engineer').id;
	});

	it('appends a Teammates header and the slug-not-title directive to every prompt', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId: tbTeamId });
		expect(result).toContain('## Teammates');
		expect(result).toContain('write `@<slug>` (active) or `@@<slug>` (passive) from this list');
		expect(result).toContain('Bare titles do not linkify.');
	});

	it('lists every enabled peer in @<slug> — Title form, sorted by title', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId: tbTeamId });
		expect(result).toContain('- @architect — Architect');
		expect(result).toContain('- @captain — Captain');
		expect(result).toContain('- @engineer — Engineer');
		expect(result).toContain('- @product-lead — Product Lead');
		expect(result).toContain('- @qa-engineer — QA Engineer');
		expect(result).toContain('- @researcher — Researcher');

		const block = result.slice(result.indexOf('## Teammates'));
		const archIdx = block.indexOf('- @architect');
		const captainIdx = block.indexOf('- @captain');
		const engIdx = block.indexOf('- @engineer');
		expect(archIdx).toBeGreaterThan(-1);
		expect(archIdx).toBeLessThan(captainIdx);
		expect(captainIdx).toBeLessThan(engIdx);
	});

	it('excludes the running agent from the teammates list', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: tbTeamId,
			agentId: tbCaptainMemberId,
		});
		expect(result).toContain('## Teammates');
		expect(result).not.toContain('- @captain — Captain');
		expect(result).toContain('- @architect — Architect');
		expect(result).toContain('- @engineer — Engineer');
	});

	it('excludes agents with admin_status != enabled', async () => {
		await db.query(
			`UPDATE member_agents SET admin_status = 'disabled'::agent_admin_status WHERE id = $1`,
			[tbEngineerMemberId],
		);

		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId: tbTeamId });
		expect(result).toContain('## Teammates');
		expect(result).not.toContain('- @engineer — Engineer');
		expect(result).toContain('- @architect — Architect');

		await db.query(
			`UPDATE member_agents SET admin_status = 'enabled'::agent_admin_status WHERE id = $1`,
			[tbEngineerMemberId],
		);
	});

	it('does not include agents from other teams', async () => {
		const otherRes = await createTestTeam(db, {
			name: 'Isolated Co',
			description: 'builtin agents only',
		});
		const otherId = ((await otherRes.json()) as any).data.id;

		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId: otherId });
		expect(result).toContain('## Teammates');
		// The builtin Captain is seeded for every team (Coach now lives only in HQ),
		// but the app-team-template-only roles from the other test team must not bleed in.
		expect(result).toContain('- @captain — Captain');
		expect(result).not.toContain('- @coach — Coach');
		expect(result).not.toContain('- @architect — Architect');
		expect(result).not.toContain('- @engineer — Engineer');
		expect(result).not.toContain('- @product-lead — Product Lead');
	});

	it('renders before SHARED_INSTRUCTIONS and after the Project State block', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId: tbTeamId });
		const teammatesIdx = result.indexOf('## Teammates');
		const guidelinesIdx = result.indexOf('## Working Guidelines');
		expect(teammatesIdx).toBeGreaterThan(-1);
		expect(guidelinesIdx).toBeGreaterThan(-1);
		expect(teammatesIdx).toBeLessThan(guidelinesIdx);
	});
});

describe('team context block', () => {
	let tcTeamId: string;
	let tcTeamSlug: string;
	let tcCaptainMemberId: string;
	let tcEngineerMemberId: string;

	beforeAll(async () => {
		const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
		const startup = ((await typesRes.json()) as any).data.find((t: any) => t.name === 'App Team');

		const teamRes = await createTestTeam(db, {
			name: 'Team Context Co',
			description: 'Team context block test team',
			template_id: startup.id,
		});
		const tcTeamData = ((await teamRes.json()) as any).data;
		tcTeamId = tcTeamData.id;
		tcTeamSlug = tcTeamData.slug;

		const agentsRes = await app.request(
			`/api/projects/${await projectSlugForTeamSlug(db, tcTeamSlug)}/agents`,
			{
				headers: authHeader(token),
			},
		);
		const agents = ((await agentsRes.json()) as any).data;
		tcCaptainMemberId = agents.find((a: any) => a.slug === 'captain').id;
		tcEngineerMemberId = agents.find((a: any) => a.slug === 'engineer').id;
	});

	it('emits a ## Your Team block when the agent has a stored team_context', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: tcTeamId,
			agentId: tcEngineerMemberId,
		});
		expect(result).toContain('## Your Team');
		expect(result).toContain('precomputed so you don');
	});

	it("renders the engineer's stored team_context content (App Team template default)", async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: tcTeamId,
			agentId: tcEngineerMemberId,
		});
		expect(result).toContain('You report to the @architect');
		expect(result).toContain('@qa-engineer');
		expect(result).toContain('@security-engineer');
	});

	it('omits the block entirely when team_context is empty', async () => {
		await db.query(`UPDATE member_agents SET team_context = '' WHERE id = $1`, [
			tcEngineerMemberId,
		]);

		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: tcTeamId,
			agentId: tcEngineerMemberId,
		});
		expect(result).not.toContain('## Your Team');
		// Teammates block still renders as a fallback.
		expect(result).toContain('## Teammates');
	});

	it('omits the block when no agentId is supplied (preview/team-level resolve)', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId: tcTeamId });
		expect(result).not.toContain('## Your Team');
	});

	it('renders Your Team before Teammates so the rich narrative leads', async () => {
		await db.query(`UPDATE member_agents SET team_context = $1 WHERE id = $2`, [
			'Test team_context content',
			tcCaptainMemberId,
		]);
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: tcTeamId,
			agentId: tcCaptainMemberId,
		});
		const yourTeamIdx = result.indexOf('## Your Team');
		const teammatesIdx = result.indexOf('## Teammates');
		expect(yourTeamIdx).toBeGreaterThan(-1);
		expect(teammatesIdx).toBeGreaterThan(yourTeamIdx);
	});

	it('substitutes {{team_context}} inline when the template uses it', async () => {
		await db.query(`UPDATE member_agents SET team_context = $1 WHERE id = $2`, [
			'INLINE TEAM CONTEXT MARKER',
			tcCaptainMemberId,
		]);
		const result = await resolveSystemPrompt(db, 'Body: {{team_context}}', {
			teamId: tcTeamId,
			agentId: tcCaptainMemberId,
		});
		expect(result).toContain('Body: INLINE TEAM CONTEXT MARKER');
	});
});

describe('project state block', () => {
	let psTeamId: string;
	let psProjectId: string;
	let psProjectSlug: string;
	let psCaptainMemberId: string;
	let psArchitectMemberId: string;

	beforeAll(async () => {
		const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
		const startup = ((await typesRes.json()) as any).data.find((t: any) => t.name === 'App Team');

		const teamRes = await createTestTeam(db, {
			name: 'Project State Co',
			description: 'PS test team',
			template_id: startup.id,
		});
		const psTeamData = ((await teamRes.json()) as any).data;
		psTeamId = psTeamData.id;

		// Materialize the team's single project up front so its prefix (PP) and
		// planning ticket are the ones the Project State block reflects. Creating it
		// before resolving the agents endpoint avoids a generic 'Work Project' being
		// minted first and returned by the idempotent helper.
		const projectRes = await createTestProject(db, psTeamId, {
			name: 'PS Project',
			description: 'Test',
		});
		const psProjectData = (await projectRes.json()).data as { id: string; slug: string };
		psProjectId = psProjectData.id;
		psProjectSlug = psProjectData.slug;

		const agentsRes = await app.request(`/api/projects/${psProjectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = ((await agentsRes.json()) as any).data;
		psCaptainMemberId = agents.find((a: any) => a.slug === 'captain').id;
		psArchitectMemberId = agents.find((a: any) => a.slug === 'architect').id;
	});

	it('omits Project State block when projectId is absent', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: psTeamId,
		});
		expect(result).not.toContain('## Project State');
	});

	it('renders Project State header with active tickets when projectId is set', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: psTeamId,
			projectId: psProjectId,
		});
		expect(result).toContain('## Project State');
		expect(result).toContain('### Active tickets');
		// App Team-template projects auto-create a planning ticket assigned to the Captain.
		expect(result).toMatch(/- PP-\d+ — Draft execution plan/);
		expect(result).toContain('assigned to Captain');
	});

	it('renders empty-state when the project has no active tickets', async () => {
		// Cancel the auto-created planning ticket on a fresh project so it has no active tickets.
		const projectRes = await createTestProject(db, psTeamId, {
			name: 'Empty PS Project',
			description: 'Test',
		});
		const emptyProjectId = ((await projectRes.json()) as any).data.id;

		await db.query(`UPDATE tasks SET status = 'cancelled'::task_status WHERE project_id = $1`, [
			emptyProjectId,
		]);

		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: psTeamId,
			projectId: emptyProjectId,
		});
		expect(result).toContain('## Project State');
		expect(result).toContain('No active tickets in this project.');
	});

	it('lists active tickets and excludes terminal-status ones', async () => {
		const activeRes = await app.request(`/api/projects/${psProjectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: psProjectId,
				title: 'Active backlog item',
				assignee_id: psArchitectMemberId,
			}),
		});
		const active = ((await activeRes.json()) as any).data;

		const doneRes = await app.request(`/api/projects/${psProjectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: psProjectId,
				title: 'Already finished item',
				assignee_id: psArchitectMemberId,
			}),
		});
		const done = ((await doneRes.json()) as any).data;
		await app.request(`/api/projects/${psProjectSlug}/tasks/${done.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'done' }),
		});

		const result = await resolveSystemPrompt(db, 'X', {
			teamId: psTeamId,
			projectId: psProjectId,
		});
		expect(result).toContain('## Project State');
		expect(result).toContain(active.identifier);
		expect(result).toContain('Active backlog item');
		expect(result).toContain('assigned to Architect');
		expect(result).not.toContain('Already finished item');
	});

	it('shows "Tickets you created" subsection scoped to the agent\'s prior runs', async () => {
		const planningTaskRes = await app.request(`/api/projects/${psProjectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: psProjectId,
				title: 'Captain planning ticket',
				assignee_id: psCaptainMemberId,
			}),
		});
		const planningTask = ((await planningTaskRes.json()) as any).data;

		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status, now())
			 RETURNING id`,
			[psCaptainMemberId, psTeamId, planningTask.id],
		);

		const subRes = await db.query<{ identifier: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, parent_task_id, created_by_run_id, number, identifier, title, description, status, priority, labels)
			 VALUES ($1, $2, $3, NULL, $4, next_project_task_number($2), 'PS-CR-1', 'Delegated to architect by Captain', '', 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING identifier`,
			[psTeamId, psProjectId, psArchitectMemberId, run.rows[0].id],
		);

		const result = await resolveSystemPrompt(db, 'X', {
			teamId: psTeamId,
			projectId: psProjectId,
			agentId: psCaptainMemberId,
		});
		expect(result).toContain('### Tickets you created on prior runs');
		expect(result).toContain(subRes.rows[0].identifier);
		expect(result).toContain('Delegated to architect by Captain');
	});

	it('"Tickets you created" is empty for an agent that hasn\'t created any', async () => {
		const result = await resolveSystemPrompt(db, 'X', {
			teamId: psTeamId,
			projectId: psProjectId,
			agentId: psArchitectMemberId,
		});
		expect(result).toContain('### Tickets you created on prior runs');
		expect(result).toContain('You have not created any tickets in this project on prior runs');
	});

	it('omits "Tickets you created" subsection when agentId is absent', async () => {
		const result = await resolveSystemPrompt(db, 'X', {
			teamId: psTeamId,
			projectId: psProjectId,
		});
		expect(result).not.toContain('Tickets you created on prior runs');
	});
});

describe('repository block', () => {
	let repoTeamId: string;
	let repoProjectId: string;

	beforeAll(async () => {
		const teamRes = await createTestTeam(db, {
			name: 'Repo Co',
			description: 'Repository block test team',
		});
		repoTeamId = ((await teamRes.json()) as any).data.id;
		const projectRes = await createTestProject(db, repoTeamId, {
			name: 'Repo Project',
			description: 'Test',
		});
		repoProjectId = ((await projectRes.json()) as any).data.id;
	});

	it('omits the Repository block when the project has no linked repo', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: repoTeamId,
			projectId: repoProjectId,
		});
		expect(result).not.toContain('## Repository');
	});

	it('names the designated repo by owner/name and forbids inventing/creating one or using a PAT', async () => {
		const repoIns = await db.query<{ id: string }>(
			`INSERT INTO repos (project_id, repo_identifier, host_type)
			 VALUES ($1, 'acme/widgets', 'github'::repo_host_type)
			 RETURNING id`,
			[repoProjectId],
		);
		await db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [
			repoIns.rows[0].id,
			repoProjectId,
		]);

		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: repoTeamId,
			projectId: repoProjectId,
		});
		expect(result).toContain('## Repository');
		expect(result).toContain('Designated repository: `acme/widgets` (github)');
		// The four behaviours the agent got wrong: inventing/creating a repo,
		// repointing origin, fetching a PAT for git, and disabling TLS.
		expect(result).toContain('Never create a new repository');
		expect(result).toContain('repoint `origin`');
		expect(result).toContain('git push -u origin');
		expect(result).toContain('do **not** need a GitHub Personal Access Token');
		expect(result).toContain('Never disable TLS verification');
		// PRs go through the github MCP, not raw curl to api.github.com.
		expect(result).toContain('`github` MCP');
		expect(result).toContain('api.github.com');
		// CI failures: read logs via the github MCP's actions tools, never curl.
		expect(result).toContain('get_job_logs');
		expect(result).toContain('failed_only');
		expect(result).toContain('list_workflow_runs');
		expect(result).toContain('never by hand');
		// The repo is named by owner/name, never by its internal UUID.
		expect(result).not.toContain(repoIns.rows[0].id);
	});

	it('lists additional linked repos under the designated one and marks them cloned locally', async () => {
		await db.query(
			`INSERT INTO repos (project_id, repo_identifier, host_type)
			 VALUES ($1, 'acme/docs', 'github'::repo_host_type)`,
			[repoProjectId],
		);
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: repoTeamId,
			projectId: repoProjectId,
		});
		expect(result).toContain('Designated repository: `acme/widgets`');
		expect(result).toContain('Also linked: `acme/docs`');
		// The additional repo is flagged as cloned/checked out locally, and — with no
		// resolved ticket here — described relative to the working directory.
		expect(result).toContain('cloned and checked out for this run at');
		expect(result).toContain('a sibling directory named `docs` next to your working directory');
		// Steer reading to disk, not the github MCP file API.
		expect(result).toContain('Read connected repositories from disk, never through an API');
		expect(result).toContain('get_file_contents');
	});

	// An agent told the designated repo is "the one and only place your code goes"
	// refuses to push a finished change to a second linked repo and asks a human to
	// apply the patch by hand — while nothing about the run is actually per-repo
	// scoped. Every linked repo must read as writable.
	it('states that additional linked repos are writable, not just readable', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: repoTeamId,
			projectId: repoProjectId,
		});
		expect(result).toContain('Every repository listed above is yours to work in');
		expect(result).toContain('commit, push, and open a pull request here');
		expect(result).toContain('Nothing about your run is scoped to a single repository');
		// The old framing must be gone — it is what produced the refusal.
		expect(result).not.toContain('the one and only place your code goes');
		// A denied push is reported with the real git error, never theorised about.
		expect(result).toContain('quote the exact git output');
		expect(result).toContain('Never assert a restriction that is not written in this block');
	});

	it('marks a repo the connected account cannot push to, and leaves unknown repos unmarked', async () => {
		const readOnly = await db.query<{ id: string }>(
			`INSERT INTO repos (project_id, repo_identifier, host_type, can_push)
			 VALUES ($1, 'acme/vendor', 'github'::repo_host_type, false)
			 RETURNING id`,
			[repoProjectId],
		);

		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: repoTeamId,
			projectId: repoProjectId,
		});
		const vendorLine = result
			.split('\n')
			.find((l) => l.includes('Also linked: `acme/vendor`')) as string;
		expect(vendorLine).toContain('no write access to this repository');
		expect(vendorLine).toContain('ask `@admin`');

		// `can_push` is NULL on the other repos — unknown, not restricted. Reporting
		// unknown as read-only would recreate the very refusal this block prevents.
		const docsLine = result
			.split('\n')
			.find((l) => l.includes('Also linked: `acme/docs`')) as string;
		expect(docsLine).not.toContain('no write access');

		await db.query('DELETE FROM repos WHERE id = $1', [readOnly.rows[0].id]);
	});

	it('names the concrete worktree path of a linked repo when the ticket resolves', async () => {
		await db.query(
			`INSERT INTO repos (project_id, repo_identifier, host_type)
			 VALUES ($1, 'acme/api', 'github'::repo_host_type)`,
			[repoProjectId],
		);
		const task = await db.query<{ id: string; identifier: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority, labels)
			 VALUES ($1, $2, next_project_task_number($2), 'REPO-1', 'Repo worktree ticket', 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING id, identifier`,
			[repoTeamId, repoProjectId],
		);
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: repoTeamId,
			projectId: repoProjectId,
			taskId: task.rows[0].id,
		});
		// The additional repo is addressed by its absolute per-task worktree path.
		expect(result).toContain(`/worktrees/${task.rows[0].identifier}/api`);
	});

	it('omits the Repository block for a cross-team (roaming) resolve', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: repoTeamId,
			projectId: repoProjectId,
			crossTeam: true,
		});
		expect(result).not.toContain('## Repository');
	});

	it('omits the Repository block in preview mode', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: repoTeamId,
			projectId: repoProjectId,
			mode: 'preview',
		});
		expect(result).not.toContain('## Repository');
	});

	it('renders the Repository block after Run Context and before Project State', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId: repoTeamId,
			projectId: repoProjectId,
		});
		const runCtxIdx = result.indexOf('## Run Context');
		const repoIdx = result.indexOf('## Repository');
		const stateIdx = result.indexOf('## Project State');
		expect(runCtxIdx).toBeGreaterThan(-1);
		expect(repoIdx).toBeGreaterThan(runCtxIdx);
		expect(stateIdx).toBeGreaterThan(repoIdx);
	});
});

describe('projects context block ({{projects_context}})', () => {
	it('lists every non-internal project by name and slug, with no team in the line', async () => {
		const result = await resolveSystemPrompt(db, 'Roster:\n{{projects_context}}', { teamId });
		expect(result).toContain('Hezo is project-centric');

		const proj = await db.query<{ name: string; slug: string }>(
			'SELECT name, slug FROM projects WHERE id = $1',
			[projectId],
		);
		// The beforeAll project surfaces on its own roster line by name and slug…
		const rosterLine = result
			.split('\n')
			.find((line) => line.includes(`slug: ${proj.rows[0].slug}`));
		expect(rosterLine).toBeDefined();
		expect(rosterLine).toContain(proj.rows[0].name);
		// …with no team name or slug — projects are the unit; teams are just a part of them.
		expect(rosterLine).not.toContain('team');
		expect(rosterLine).not.toContain('Template Co');
		// …and never by raw UUID, since this text is echoed to the human operator.
		expect(result).not.toContain(projectId);

		// HQ is the one internal project and must never appear as a roster row.
		const hq = await db.query<{ slug: string }>(
			'SELECT slug FROM projects WHERE is_internal = true LIMIT 1',
		);
		expect(result).not.toContain(`slug: ${hq.rows[0].slug}`);
	});

	it('shows an empty-state line when no projects exist beyond HQ', async () => {
		// A fresh instance has only HQ (internal), so the roster is empty.
		const fresh = await createTestApp();
		try {
			const result = await resolveSystemPrompt(fresh.db, '{{projects_context}}', {
				teamId: DEFAULT_TEAM_ID,
			});
			expect(result).toContain('No projects exist yet beyond HQ');
		} finally {
			await safeClose(fresh.db);
		}
	});

	it('does not inject the roster into prompts that omit the placeholder', async () => {
		const result = await resolveSystemPrompt(db, 'No placeholder here', { teamId });
		expect(result).not.toContain('Hezo is project-centric');
	});
});

describe('cross-team chat resolution (crossTeam: true)', () => {
	// The CEO chat roams across every project, so its prompt is resolved with the
	// home team (HQ) as teamId/projectId only to load the CEO's own template. The
	// single-team run blocks must NOT pin to that home team, or every project the
	// operator asks about gets misreported as HQ's (empty) state.
	it('suppresses the home-team-pinned Project State and Teammates blocks', async () => {
		const result = await resolveSystemPrompt(db, 'Roster:\n{{projects_context}}', {
			teamId,
			projectId,
			crossTeam: true,
		});
		expect(result).not.toContain('## Project State');
		expect(result).not.toContain('No active tickets in this project');
		expect(result).not.toContain('## Teammates');
	});

	it('replaces the Run Context identifier list with cross-team guidance', async () => {
		const result = await resolveSystemPrompt(db, 'Simple prompt', {
			teamId,
			projectId,
			crossTeam: true,
		});
		expect(result).toContain('## Run Context');
		expect(result).toContain('You are not scoped to a single project');
		// The home-team identifiers must not be handed to the agent — no UUIDs leak.
		expect(result).not.toContain(teamId);
		expect(result).not.toContain(projectId);
	});

	it('still renders the cross-team project roster', async () => {
		const result = await resolveSystemPrompt(db, '{{projects_context}}', {
			teamId,
			projectId,
			crossTeam: true,
		});
		expect(result).toContain('Hezo is project-centric');
	});

	it('leaves the single-team blocks intact for a normal (non-crossTeam) run', async () => {
		const proj = await db.query<{ slug: string }>('SELECT slug FROM projects WHERE id = $1', [
			projectId,
		]);
		const result = await resolveSystemPrompt(db, 'Simple prompt', { teamId, projectId });
		expect(result).toContain('## Project State');
		expect(result).toContain('## Teammates');
		expect(result).toContain(`- Project: \`${proj.rows[0].slug}\``);
	});

	// The CEO prompt's HEZO_DOCS marker: full docs in live chat, a pointer elsewhere.
	const docsMarker = '<!-- HEZO_DOCS: docs injected here at runtime -->';

	it('embeds the full bundled docs at the HEZO_DOCS marker when embedDocs is set', async () => {
		const result = await resolveSystemPrompt(db, `Intro\n\n${docsMarker}\n\nOutro`, {
			teamId,
			embedDocs: true,
		});
		// Marker replaced by the organised docs block (header + real doc content).
		expect(result).not.toContain('HEZO_DOCS');
		expect(result).toContain('# Hezo documentation');
		expect(result).toContain('### Installation');
		expect(result).toContain(HEZO_DOCS_URL);
	});

	it('replaces the HEZO_DOCS marker with a live-docs pointer when embedDocs is not set', async () => {
		const result = await resolveSystemPrompt(db, `Intro\n\n${docsMarker}\n\nOutro`, {
			teamId,
		});
		expect(result).not.toContain('HEZO_DOCS');
		expect(result).toContain(`Full Hezo product & API documentation: ${HEZO_DOCS_URL}`);
		// The full docs are NOT inlined for headless runs.
		expect(result).not.toContain('# Hezo documentation');
		expect(result).not.toContain('### Installation');
	});
});
