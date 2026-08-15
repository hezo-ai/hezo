import { ApprovalType, type ProjectDashboardNeedsYouItem } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../lib/i18n';
import { inboxRowKind, inboxRowLead } from '../../lib/inbox-row-kind';
import { Badge } from '../ui/badge';
import { Card } from '../ui/card';
import { RelativeTime } from '../ui/relative-time';

function approvalText(approval: { type: string; requested_by_name: string | null }): string {
	const who = approval.requested_by_name ?? 'An agent';
	switch (approval.type) {
		case ApprovalType.DesignatedRepoRequest:
			return `${who} needs GitHub access to set up the repo`;
		case ApprovalType.PlanReview:
			return `${who} drafted a plan to review`;
		case ApprovalType.Hire:
			return `${who} wants to hire an agent`;
		case ApprovalType.DeployProduction:
			return `${who} wants to deploy to production`;
		case ApprovalType.SkillProposal:
			return `${who} proposed a reusable skill`;
		case ApprovalType.Strategy:
			return `${who} needs a strategy decision`;
		case ApprovalType.ProjectCreation:
			return `${who} proposed a new project`;
		default:
			return `${who} needs your approval`;
	}
}

const ROW_CLASS = 'flex items-center gap-3 px-3 py-2.5 hover:bg-surface-2';

/** The row itself is the control, so its inner layout is all this renders. */
function RowContent({
	tag,
	tagColor,
	children,
	createdAt,
}: {
	tag: string;
	tagColor: 'accent' | 'info' | 'warning';
	children: ReactNode;
	createdAt: string;
}) {
	return (
		<>
			<Badge color={tagColor} mono className="shrink-0">
				{tag}
			</Badge>
			<span className="min-w-0 flex-1 truncate text-[13px] text-text-1">{children}</span>
			<RelativeTime
				iso={createdAt}
				compact
				className="shrink-0 font-mono text-[11px] text-text-3"
			/>
		</>
	);
}

function ActionItemRow({
	projectId,
	row,
}: {
	projectId: string;
	row: ProjectDashboardNeedsYouItem;
}) {
	if (row.kind === 'approval') {
		return (
			<Link
				to="/projects/$projectId/inbox"
				params={{ projectId }}
				className={ROW_CLASS}
				data-testid="dashboard-action-item"
			>
				<RowContent tag="action" tagColor="accent" createdAt={row.created_at}>
					{approvalText(row.approval)}
				</RowContent>
			</Link>
		);
	}
	const m = row.mention;
	const kind = inboxRowKind(m.content_type);
	const lead = inboxRowLead(m);
	return (
		<Link
			to="/projects/$projectId/tasks/$taskId"
			params={{ projectId, taskId: m.task_identifier.toLowerCase() }}
			hash={`comment-${m.comment_public_id}`}
			className={ROW_CLASS}
			data-testid="dashboard-action-item"
		>
			<RowContent tag={kind.tag} tagColor={kind.tagColor} createdAt={row.created_at}>
				{lead ? (
					<>
						{m.task_identifier}: {lead}
					</>
				) : (
					<>
						{m.author_display_name} on {m.task_identifier}: {m.snippet || m.task_title}
					</>
				)}
			</RowContent>
		</Link>
	);
}

/**
 * What is waiting on the reader: the project inbox's *unread* rows, so "Open inbox" lands on
 * exactly what this just listed and an item leaves the dashboard once read.
 *
 * Kept at the top of the left column because it is the one thing on the page that is blocked on
 * a human rather than simply informative.
 */
export function ActionItems({
	projectId,
	rows,
	actionCount,
}: {
	projectId: string;
	rows: ProjectDashboardNeedsYouItem[];
	actionCount: number;
}) {
	const { t } = useI18n();

	if (rows.length === 0) {
		return (
			<section data-testid="dashboard-action-items">
				<div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[13px]">
					<Inbox className="h-3.5 w-3.5 shrink-0 text-text-3" aria-hidden="true" />
					<span className="font-medium text-text-1">{t('dashboard.actionItems.heading')}</span>
					<span className="text-text-3">· {t('dashboard.actionItems.allClear')}</span>
				</div>
			</section>
		);
	}

	return (
		<section data-testid="dashboard-action-items">
			<div className="mb-2 flex items-center gap-2">
				<Inbox className="h-4 w-4 shrink-0 text-text-3" aria-hidden="true" />
				{/* The separator is rendered rather than baked into the catalog string, so no
				    translation has to carry punctuation to keep the count legible. */}
				<h2 className="text-[12.5px] font-medium text-text-1">
					{t('dashboard.actionItems.heading')}{' '}
					<span className="font-mono text-[11px] tabular-nums text-text-3">· {actionCount}</span>
				</h2>
				<Link
					to="/projects/$projectId/inbox"
					params={{ projectId }}
					className="ml-auto text-[11px] text-info-soft-fg hover:underline"
				>
					{t('dashboard.actionItems.openInbox')}
				</Link>
			</div>
			<Card className="divide-y divide-border p-0">
				{rows.map((row) => (
					<ActionItemRow
						key={`${row.kind}-${row.kind === 'approval' ? row.approval.id : row.mention.id}`}
						projectId={projectId}
						row={row}
					/>
				))}
			</Card>
		</section>
	);
}
