import {
	AgentRuntimeStatus,
	ApprovalType,
	DocumentStatus,
	formatDocumentStatus,
	formatTaskStatus,
	TaskPriority,
	TaskStatus,
} from '@hezo/shared';
import type { BadgeColor } from '../components/ui/badge';

/**
 * Single source of truth for status/type → badge display, consolidating the
 * color/label maps that were previously copy-pasted across task-status-badge,
 * agent-status-label (twice — also in the agent detail route), and approval-card.
 *
 * Labels for domain enums that already carry them in @hezo/shared
 * (`TASK_STATUS_LABELS` / `formatTaskStatus`) are reused from there; the colors
 * are web Badge tokens, so they live here in web. A new enum value forces a
 * metadata entry (the `Record<Enum, …>` typing), instead of silently rendering
 * an unstyled fallback.
 */

export interface BadgeMeta {
	color: BadgeColor;
	label: string;
}

const TASK_STATUS_COLORS: Record<TaskStatus, BadgeColor> = {
	[TaskStatus.Backlog]: 'neutral',
	[TaskStatus.InProgress]: 'warning',
	[TaskStatus.Review]: 'purple',
	[TaskStatus.Blocked]: 'danger',
	[TaskStatus.Done]: 'success',
	[TaskStatus.Cancelled]: 'neutral',
};

/** Badge color for a task status, defaulting to neutral for unknown values. */
export function taskStatusColor(status: string): BadgeColor {
	return TASK_STATUS_COLORS[status as TaskStatus] ?? 'neutral';
}

/** Color + label for a task status (label sourced from the shared label map). */
export function taskStatusMeta(status: string): BadgeMeta {
	return { color: taskStatusColor(status), label: formatTaskStatus(status) };
}

const DOCUMENT_STATUS_COLORS: Record<DocumentStatus, BadgeColor> = {
	[DocumentStatus.Planning]: 'warning',
	[DocumentStatus.Approved]: 'success',
};

/** Badge color for a document status, defaulting to neutral for unknown values. */
export function documentStatusColor(status: string): BadgeColor {
	return DOCUMENT_STATUS_COLORS[status as DocumentStatus] ?? 'neutral';
}

/** Color + label for a document status (label sourced from the shared label map). */
export function documentStatusMeta(status: string): BadgeMeta {
	return { color: documentStatusColor(status), label: formatDocumentStatus(status) };
}

// Priority maps to the spec's semantic tints: urgent = danger, high = warning,
// medium = info, low = neutral (the "Quiet tint" badge treatment).
const TASK_PRIORITY_COLORS: Record<TaskPriority, BadgeColor> = {
	[TaskPriority.Urgent]: 'danger',
	[TaskPriority.High]: 'warning',
	[TaskPriority.Medium]: 'info',
	[TaskPriority.Low]: 'neutral',
};

/** Badge color for a task priority, defaulting to neutral for unknown values. */
export function taskPriorityColor(priority: string): BadgeColor {
	return TASK_PRIORITY_COLORS[priority as TaskPriority] ?? 'neutral';
}

export const AGENT_RUNTIME_STATUS_META: Record<AgentRuntimeStatus, BadgeMeta> = {
	// "Running" is the design system's one cyan "live" signal — reserved strictly
	// for active agent activity, never green.
	[AgentRuntimeStatus.Active]: { color: 'live', label: 'Running' },
	[AgentRuntimeStatus.Idle]: { color: 'neutral', label: 'Idle' },
	[AgentRuntimeStatus.OutOfAgentBudget]: { color: 'red', label: 'Over agent budget' },
	[AgentRuntimeStatus.OutOfProjectBudget]: { color: 'red', label: 'Over project budget' },
};

/** Runtime-status badge meta, defaulting to Idle for unknown values. */
export function agentRuntimeStatusMeta(status: string): BadgeMeta {
	return (
		AGENT_RUNTIME_STATUS_META[status as AgentRuntimeStatus] ??
		AGENT_RUNTIME_STATUS_META[AgentRuntimeStatus.Idle]
	);
}

const APPROVAL_TYPE_COLORS: Record<ApprovalType, BadgeColor> = {
	[ApprovalType.Strategy]: 'purple',
	[ApprovalType.DesignatedRepoRequest]: 'yellow',
	[ApprovalType.Hire]: 'green',
	[ApprovalType.PlanReview]: 'blue',
	[ApprovalType.DeployProduction]: 'red',
	[ApprovalType.SkillProposal]: 'blue',
	// Previously fell through to the Badge's neutral default (no typeColors entry).
	[ApprovalType.ProjectCreation]: 'neutral',
};

/** Badge color for an approval type, defaulting to neutral for unknown values. */
export function approvalTypeColor(type: string): BadgeColor {
	return APPROVAL_TYPE_COLORS[type as ApprovalType] ?? 'neutral';
}
