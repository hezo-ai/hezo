import { HeartbeatRunKind, WakeupSource } from '@hezo/shared';
import type { HeartbeatRun } from '../hooks/use-heartbeat-runs';
import type { MessageKey } from './i18n';

export interface TriggerLabel {
	text: string;
	href?: string;
	source: HeartbeatRun['trigger_source'];
}

/** The catalog lookup, threaded in from the component rendering the label. */
type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

function getString(payload: Record<string, unknown> | null, key: string): string | undefined {
	if (!payload) return undefined;
	const v = payload[key];
	return typeof v === 'string' ? v : undefined;
}

function commentHref(run: HeartbeatRun, teamSlug: string): string | undefined {
	const taskIdentifier = run.trigger_comment_task_identifier;
	const projectSlug = run.trigger_comment_project_slug;
	const commentId = run.trigger_comment_public_id;
	if (!taskIdentifier || !projectSlug || !commentId) return undefined;
	return `/teams/${teamSlug}/projects/${projectSlug}/tasks/${taskIdentifier}#comment-${commentId}`;
}

function taskHref(run: HeartbeatRun, teamSlug: string): string | undefined {
	const taskIdentifier = run.trigger_comment_task_identifier ?? run.task_identifier;
	const projectSlug = run.trigger_comment_project_slug ?? run.project_slug;
	if (!taskIdentifier || !projectSlug) return undefined;
	return `/teams/${teamSlug}/projects/${projectSlug}/tasks/${taskIdentifier}`;
}

export function formatTriggerReason(
	run: HeartbeatRun,
	teamSlug: string,
	t: Translate,
): TriggerLabel {
	const source = run.trigger_source;
	const taskId = run.trigger_comment_task_identifier ?? run.task_identifier;
	const actor = run.trigger_actor_slug;

	// Progress-update runs are the Captain's periodic progress assessment. They have no task and
	// reuse the heartbeat wakeup, so describe them by what the run does, not the raw source.
	if (run.kind === HeartbeatRunKind.ProgressUpdate) {
		return { source, text: t('runTrigger.progressUpdate') };
	}

	switch (source) {
		case WakeupSource.Mention: {
			if (actor && taskId) {
				return {
					source,
					text: t('runTrigger.mentionedByIn', { actor, task: taskId }),
					href: commentHref(run, teamSlug),
				};
			}
			return { source, text: t('runTrigger.mentioned'), href: commentHref(run, teamSlug) };
		}
		case WakeupSource.Reply: {
			if (actor && taskId) {
				return {
					source,
					text: t('runTrigger.replyFromIn', { actor, task: taskId }),
					href: commentHref(run, teamSlug),
				};
			}
			return { source, text: t('runTrigger.reply'), href: commentHref(run, teamSlug) };
		}
		case WakeupSource.Comment: {
			if (taskId) {
				return {
					source,
					text: t('runTrigger.commentOn', { task: taskId }),
					href: commentHref(run, teamSlug) ?? taskHref(run, teamSlug),
				};
			}
			return { source, text: t('runTrigger.comment') };
		}
		case WakeupSource.Assignment: {
			if (taskId) {
				return {
					source,
					text: t('runTrigger.assignedTo', { task: taskId }),
					href: taskHref(run, teamSlug),
				};
			}
			return { source, text: t('runTrigger.assigned') };
		}
		case WakeupSource.Automation: {
			// `kind` is the raw payload token the server wrote (`container_start`,
			// `hire_resolved`). Machine text, so it is interpolated, never translated.
			const kind =
				getString(run.trigger_payload, 'kind') ?? getString(run.trigger_payload, 'reason');
			return {
				source,
				text: kind ? t('runTrigger.automationKind', { kind }) : t('runTrigger.automation'),
			};
		}
		case WakeupSource.ApprovalResolved: {
			if (taskId) {
				return {
					source,
					text: t('runTrigger.approvalResolvedOn', { task: taskId }),
					href: taskHref(run, teamSlug),
				};
			}
			return { source, text: t('runTrigger.approvalResolved') };
		}
		case WakeupSource.CredentialProvided:
			return {
				source,
				text: t('runTrigger.credentialProvided'),
				href: commentHref(run, teamSlug) ?? taskHref(run, teamSlug),
			};
		case WakeupSource.AssetDeletionResolved:
			return {
				source,
				text: t('runTrigger.assetDeletionResolved'),
				href: commentHref(run, teamSlug) ?? taskHref(run, teamSlug),
			};
		case WakeupSource.Heartbeat:
			return { source, text: t('runTrigger.heartbeat') };
		case WakeupSource.Timer: {
			const reason = getString(run.trigger_payload, 'reason');
			return {
				source,
				text: reason ? t('runTrigger.timerReason', { reason }) : t('runTrigger.timer'),
			};
		}
		case WakeupSource.OnDemand:
			return { source, text: t('runTrigger.onDemand') };
		default:
			return { source, text: t('runTrigger.unknown') };
	}
}
