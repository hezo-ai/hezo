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

function commentHref(run: HeartbeatRun, companySlug: string): string | undefined {
	const issueIdentifier = run.trigger_comment_issue_identifier;
	const projectSlug = run.trigger_comment_project_slug;
	const commentId = run.trigger_comment_id;
	if (!issueIdentifier || !projectSlug || !commentId) return undefined;
	return `/companies/${companySlug}/projects/${projectSlug}/issues/${issueIdentifier}#c-${commentId}`;
}

function issueHref(run: HeartbeatRun, companySlug: string): string | undefined {
	const issueIdentifier = run.trigger_comment_issue_identifier ?? run.issue_identifier;
	const projectSlug = run.trigger_comment_project_slug ?? run.project_slug;
	if (!issueIdentifier || !projectSlug) return undefined;
	return `/companies/${companySlug}/projects/${projectSlug}/issues/${issueIdentifier}`;
}

export function formatTriggerReason(run: HeartbeatRun, companySlug: string): TriggerLabel {
	const source = run.trigger_source;
	const issueId = run.trigger_comment_issue_identifier ?? run.issue_identifier;
	const actor = run.trigger_actor_slug;

	switch (source) {
		case WakeupSource.Mention: {
			if (actor && issueId) {
				return {
					source,
					text: `Mentioned by @${actor} in ${issueId}`,
					href: commentHref(run, companySlug),
				};
			}
			return { source, text: 'Mentioned in a comment', href: commentHref(run, companySlug) };
		}
		case WakeupSource.Reply: {
			if (actor && issueId) {
				return {
					source,
					text: `Reply from @${actor} in ${issueId}`,
					href: commentHref(run, companySlug),
				};
			}
			return { source, text: 'Reply to your earlier comment', href: commentHref(run, companySlug) };
		}
		case WakeupSource.Comment: {
			if (issueId) {
				return {
					source,
					text: `New comment on ${issueId}`,
					href: commentHref(run, companySlug) ?? issueHref(run, companySlug),
				};
			}
			return { source, text: 'New comment on assigned issue' };
		}
		case WakeupSource.OptionChosen: {
			if (issueId) {
				return {
					source,
					text: `Option chosen on ${issueId}`,
					href: issueHref(run, companySlug),
				};
			}
			return { source, text: 'Option chosen on assigned issue' };
		}
		case WakeupSource.Assignment: {
			if (issueId) {
				return { source, text: `Assigned to ${issueId}`, href: issueHref(run, companySlug) };
			}
			return { source, text: 'Assigned to an issue' };
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
