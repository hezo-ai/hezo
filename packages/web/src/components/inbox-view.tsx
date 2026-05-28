import type { BoardMentionItem } from '@hezo/shared';
import { Inbox } from 'lucide-react';
import { type Approval, useAllPendingApprovals } from '../hooks/use-approvals';
import { useAllBoardMentions } from '../hooks/use-board-mentions';
import { ApprovalCard } from './approval-card';
import { MentionCard } from './mention-card';
import { EmptyState } from './ui/empty-state';

interface InboxViewProps {
	teamIds: string[];
	scope: 'team' | 'global';
}

type InboxRow =
	| { kind: 'approval'; created_at: string; key: string; approval: Approval }
	| { kind: 'mention'; created_at: string; key: string; mention: BoardMentionItem };

export function InboxView({ teamIds, scope }: InboxViewProps) {
	const { data: approvals, isLoading: approvalsLoading } = useAllPendingApprovals(teamIds);
	const { data: mentions, isLoading: mentionsLoading } = useAllBoardMentions(teamIds);

	const isLoading = approvalsLoading || mentionsLoading;

	const rows: InboxRow[] = [
		...(approvals ?? []).map<InboxRow>((a) => ({
			kind: 'approval',
			created_at: a.created_at,
			key: `approval:${a.id}`,
			approval: a,
		})),
		...(mentions ?? []).map<InboxRow>((m) => ({
			kind: 'mention',
			created_at: m.created_at,
			key: `mention:${m.id}`,
			mention: m,
		})),
	].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

	if (isLoading) {
		return <div className="text-text-muted">Loading...</div>;
	}

	return (
		<div>
			<h1 className="text-[22px] font-medium mb-5">Inbox</h1>

			{rows.length === 0 ? (
				<EmptyState
					icon={<Inbox className="w-10 h-10" />}
					title="All clear"
					description="No pending approvals or mentions."
				/>
			) : (
				<div className="flex flex-col gap-3">
					{rows.map((row) =>
						row.kind === 'approval' ? (
							<ApprovalCard key={row.key} approval={row.approval} showTeam={scope === 'global'} />
						) : (
							<MentionCard key={row.key} mention={row.mention} showTeam={scope === 'global'} />
						),
					)}
				</div>
			)}
		</div>
	);
}
