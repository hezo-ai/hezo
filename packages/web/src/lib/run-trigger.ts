import { WakeupSource } from '@hezo/shared';
import type { HeartbeatRun } from '../hooks/use-heartbeat-runs';

export interface TriggerLabel {
	text: string;
	href?: string;
	source: HeartbeatRun['trigger_source'];
}

function getString(payload: Record<string, unknown> | null, key: string): string | undefined {
	if (!payload) return undefined;
	const v = payload[key];
	return typeof v === 'string' ? v : undefined;
}

function commentHref(run: HeartbeatRun, teamSlug: string): string | undefined {
	const taskIdentifier = run.trigger_comment_task_identifier;
	const projectSlug = run.trigger_comment_project_slug;
	const commentId = run.trigger_comment_id;
	if (!taskIdentifier || !projectSlug || !commentId) return undefined;
	return `/teams/${teamSlug}/projects/${projectSlug}/tasks/${taskIdentifier}#c-${commentId}`;
}

function taskHref(run: HeartbeatRun, teamSlug: string): string | undefined {
	const taskIdentifier = run.trigger_comment_task_identifier ?? run.task_identifier;
	const projectSlug = run.trigger_comment_project_slug ?? run.project_slug;
	if (!taskIdentifier || !projectSlug) return undefined;
	return `/teams/${teamSlug}/projects/${projectSlug}/tasks/${taskIdentifier}`;
}

export function formatTriggerReason(run: HeartbeatRun, teamSlug: string): TriggerLabel {
	const source = run.trigger_source;
	const taskId = run.trigger_comment_task_identifier ?? run.task_identifier;
	const actor = run.trigger_actor_slug;

	switch (source) {
		case WakeupSource.Mention: {
			if (actor && taskId) {
				return {
					source,
					text: `Mentioned by @${actor} in ${taskId}`,
					href: commentHref(run, teamSlug),
				};
			}
			return { source, text: 'Mentioned in a comment', href: commentHref(run, teamSlug) };
		}
		case WakeupSource.Reply: {
			if (actor && taskId) {
				return {
					source,
					text: `Reply from @${actor} in ${taskId}`,
					href: commentHref(run, teamSlug),
				};
			}
			return { source, text: 'Reply to your earlier comment', href: commentHref(run, teamSlug) };
		}
		case WakeupSource.Comment: {
			if (taskId) {
				return {
					source,
					text: `New comment on ${taskId}`,
					href: commentHref(run, teamSlug) ?? taskHref(run, teamSlug),
				};
			}
			return { source, text: 'New comment on assigned task' };
		}
		case WakeupSource.OptionChosen: {
			if (taskId) {
				return {
					source,
					text: `Option chosen on ${taskId}`,
					href: taskHref(run, teamSlug),
				};
			}
			return { source, text: 'Option chosen on assigned task' };
		}
		case WakeupSource.Assignment: {
			if (taskId) {
				return { source, text: `Assigned to ${taskId}`, href: taskHref(run, teamSlug) };
			}
			return { source, text: 'Assigned to an task' };
		}
		case WakeupSource.Automation: {
			const kind =
				getString(run.trigger_payload, 'kind') ?? getString(run.trigger_payload, 'reason');
			return { source, text: kind ? `Automation: ${kind}` : 'Automation' };
		}
		case WakeupSource.Heartbeat:
			return { source, text: 'Scheduled heartbeat' };
		case WakeupSource.Timer: {
			const reason = getString(run.trigger_payload, 'reason');
			return { source, text: reason ? `Recovery timer: ${reason}` : 'Recovery timer' };
		}
		case WakeupSource.OnDemand:
			return { source, text: 'Manually started' };
		default:
			return { source, text: 'Unknown trigger' };
	}
}
