import { WakeupSource } from '@hezo/shared';
import { expect, test } from 'vitest';
import type { HeartbeatRun } from '../src/hooks/use-heartbeat-runs';
import { formatTriggerReason } from '../src/lib/run-trigger';

const TEAM = 'acme';

// A fully-populated run with every trigger/deep-link field present. Tests start
// from this and null out fields to drive the fallback branches.
function run(overrides: Partial<HeartbeatRun>): HeartbeatRun {
	return {
		id: 'run-1',
		member_id: 'm-1',
		team_id: 't-1',
		wakeup_id: null,
		task_id: 'task-1',
		task_identifier: 'ACME-7',
		task_title: 'Do the thing',
		project_id: 'p-1',
		project_slug: 'web-app',
		project_name: 'Web App',
		status: 'succeeded',
		queued_reason: null,
		started_at: null,
		finished_at: null,
		exit_code: 0,
		error: null,
		input_tokens: 0,
		output_tokens: 0,
		cost_cents: 0,
		usage_partial: false,
		invocation_command: null,
		log_text: null,
		working_dir: null,
		trigger_source: null,
		trigger_payload: null,
		trigger_comment_id: null,
		trigger_comment_public_id: 'c-pub-99',
		trigger_actor_member_id: null,
		trigger_actor_slug: 'alice',
		trigger_actor_title: 'Alice',
		trigger_comment_task_id: 'task-1',
		trigger_comment_task_identifier: 'ACME-7',
		trigger_comment_project_slug: 'web-app',
		run_comment_id: null,
		run_comment_public_id: null,
		created_tasks: [],
		created_docs: [],
		created_skills: [],
		proposed_skills: [],
		...overrides,
	};
}

test('mention with actor + task links to the triggering comment', () => {
	const label = formatTriggerReason(run({ trigger_source: WakeupSource.Mention }), TEAM);
	expect(label.source).toBe(WakeupSource.Mention);
	expect(label.text).toBe('Mentioned by @alice in ACME-7');
	expect(label.href).toBe('/teams/acme/projects/web-app/tasks/ACME-7#comment-c-pub-99');
});

test('mention without actor/task falls back to generic copy but keeps the comment href when available', () => {
	const label = formatTriggerReason(
		run({
			trigger_source: WakeupSource.Mention,
			trigger_actor_slug: null,
			trigger_comment_task_identifier: null,
			task_identifier: null,
		}),
		TEAM,
	);
	expect(label.text).toBe('Mentioned in a comment');
	// commentHref still resolves: it depends on task_identifier of the *comment*,
	// project slug, and the comment public id — only the actor was dropped here,
	// but the comment task identifier was nulled too, so href is undefined.
	expect(label.href).toBeUndefined();
});

test('reply with actor + task links to the comment', () => {
	const label = formatTriggerReason(run({ trigger_source: WakeupSource.Reply }), TEAM);
	expect(label.text).toBe('Reply from @alice in ACME-7');
	expect(label.href).toBe('/teams/acme/projects/web-app/tasks/ACME-7#comment-c-pub-99');
});

test('reply without actor uses fallback copy', () => {
	const label = formatTriggerReason(
		run({ trigger_source: WakeupSource.Reply, trigger_actor_slug: null, task_identifier: null }),
		TEAM,
	);
	expect(label.text).toBe('Reply to your earlier comment');
});

test('comment uses the comment href when present', () => {
	const label = formatTriggerReason(run({ trigger_source: WakeupSource.Comment }), TEAM);
	expect(label.text).toBe('New comment on ACME-7');
	expect(label.href).toBe('/teams/acme/projects/web-app/tasks/ACME-7#comment-c-pub-99');
});

test('comment falls back to the task href when no comment public id', () => {
	const label = formatTriggerReason(
		run({ trigger_source: WakeupSource.Comment, trigger_comment_public_id: null }),
		TEAM,
	);
	expect(label.text).toBe('New comment on ACME-7');
	// No comment id → commentHref undefined → taskHref used instead.
	expect(label.href).toBe('/teams/acme/projects/web-app/tasks/ACME-7');
});

test('comment with no task id at all gets generic copy and no href', () => {
	const label = formatTriggerReason(
		run({
			trigger_source: WakeupSource.Comment,
			trigger_comment_task_identifier: null,
			task_identifier: null,
		}),
		TEAM,
	);
	expect(label.text).toBe('New comment on assigned task');
	expect(label.href).toBeUndefined();
});

test('assignment links to the task', () => {
	const label = formatTriggerReason(
		run({
			trigger_source: WakeupSource.Assignment,
			trigger_comment_task_identifier: null,
			trigger_comment_project_slug: null,
		}),
		TEAM,
	);
	expect(label.text).toBe('Assigned to ACME-7');
	// taskHref falls back to task_identifier/project_slug when the comment fields are absent.
	expect(label.href).toBe('/teams/acme/projects/web-app/tasks/ACME-7');
});

test('assignment without a task id uses generic copy', () => {
	const label = formatTriggerReason(
		run({
			trigger_source: WakeupSource.Assignment,
			trigger_comment_task_identifier: null,
			task_identifier: null,
		}),
		TEAM,
	);
	expect(label.text).toBe('Assigned to an task');
	expect(label.href).toBeUndefined();
});

test('automation reads the kind from the payload', () => {
	const label = formatTriggerReason(
		run({ trigger_source: WakeupSource.Automation, trigger_payload: { kind: 'stale-pr-nudge' } }),
		TEAM,
	);
	expect(label.text).toBe('Automation: stale-pr-nudge');
});

test('automation falls back to the reason field, then to bare label', () => {
	const withReason = formatTriggerReason(
		run({ trigger_source: WakeupSource.Automation, trigger_payload: { reason: 'budget-reset' } }),
		TEAM,
	);
	expect(withReason.text).toBe('Automation: budget-reset');

	const bare = formatTriggerReason(
		run({ trigger_source: WakeupSource.Automation, trigger_payload: null }),
		TEAM,
	);
	expect(bare.text).toBe('Automation');

	// Non-string payload values are ignored by getString.
	const nonString = formatTriggerReason(
		run({ trigger_source: WakeupSource.Automation, trigger_payload: { kind: 42 } }),
		TEAM,
	);
	expect(nonString.text).toBe('Automation');
});

test('heartbeat is a fixed label', () => {
	const label = formatTriggerReason(run({ trigger_source: WakeupSource.Heartbeat }), TEAM);
	expect(label.text).toBe('Scheduled heartbeat');
	expect(label.href).toBeUndefined();
});

test('timer reads the reason from the payload, with a fallback', () => {
	const withReason = formatTriggerReason(
		run({ trigger_source: WakeupSource.Timer, trigger_payload: { reason: 'no-output' } }),
		TEAM,
	);
	expect(withReason.text).toBe('Recovery timer: no-output');

	const bare = formatTriggerReason(
		run({ trigger_source: WakeupSource.Timer, trigger_payload: {} }),
		TEAM,
	);
	expect(bare.text).toBe('Recovery timer');
});

test('on-demand is a fixed label', () => {
	const label = formatTriggerReason(run({ trigger_source: WakeupSource.OnDemand }), TEAM);
	expect(label.text).toBe('Manually started');
});

test('unknown / null trigger source falls through to the default branch', () => {
	const nullSource = formatTriggerReason(run({ trigger_source: null }), TEAM);
	expect(nullSource.text).toBe('Unknown trigger');
	expect(nullSource.source).toBeNull();

	// CredentialProvided has no case in the switch, so it hits default too.
	const credential = formatTriggerReason(
		run({ trigger_source: WakeupSource.CredentialProvided }),
		TEAM,
	);
	expect(credential.text).toBe('Unknown trigger');
});
