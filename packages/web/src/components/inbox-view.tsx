import { type AdminMentionItem, ApprovalStatus } from '@hezo/shared';
import { Inbox, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAllAdminMentions } from '../hooks/use-admin-mentions';
import { type Approval, useAllApprovals } from '../hooks/use-approvals';
import { ApprovalCard } from './approval-card';
import { MentionCard } from './mention-card';
import { EmptyState } from './ui/empty-state';
import { FilterPills } from './ui/filter-pills';

interface InboxViewProps {
	teamIds: string[];
	scope: 'team' | 'global';
}

type ReadFilter = 'all' | 'unread' | 'read' | 'archived';

type InboxRow =
	| {
			kind: 'approval';
			created_at: string;
			key: string;
			read: boolean;
			search: string;
			approval: Approval;
	  }
	| {
			kind: 'mention';
			created_at: string;
			key: string;
			read: boolean;
			search: string;
			mention: AdminMentionItem;
	  };

const READ_OPTIONS: { value: ReadFilter; label: string }[] = [
	{ value: 'all', label: 'All' },
	{ value: 'unread', label: 'Unread' },
	{ value: 'read', label: 'Read' },
	{ value: 'archived', label: 'Archived' },
];

function mentionSearch(m: AdminMentionItem): string {
	return [m.task_identifier, m.task_title, m.author_slug, m.author_display_name, m.snippet]
		.filter(Boolean)
		.join(' ')
		.toLowerCase();
}

function approvalSearch(a: Approval): string {
	return [
		a.type.replace(/_/g, ' '),
		a.requested_by_name,
		a.payload_member_name,
		a.payload_project_name,
		a.payload_task_identifier,
	]
		.filter(Boolean)
		.join(' ')
		.toLowerCase();
}

export function InboxView({ teamIds, scope }: InboxViewProps) {
	const [readFilter, setReadFilter] = useState<ReadFilter>('all');
	const archivedView = readFilter === 'archived';
	const { data: approvals, isLoading: approvalsLoading } = useAllApprovals(teamIds, {
		archived: archivedView,
	});
	const { data: mentions, isLoading: mentionsLoading } = useAllAdminMentions(teamIds, {
		archived: archivedView,
	});
	const [search, setSearch] = useState('');
	const [debouncedSearch, setDebouncedSearch] = useState('');

	useEffect(() => {
		const handle = setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 250);
		return () => clearTimeout(handle);
	}, [search]);

	const isLoading = approvalsLoading || mentionsLoading;

	const rows = useMemo<InboxRow[]>(() => {
		const approvalRows = (approvals ?? []).map<InboxRow>((a) => ({
			kind: 'approval',
			created_at: a.created_at,
			key: `approval:${a.id}`,
			read: a.status !== ApprovalStatus.Pending,
			search: approvalSearch(a),
			approval: a,
		}));
		const mentionRows = (mentions ?? []).map<InboxRow>((m) => ({
			kind: 'mention',
			created_at: m.created_at,
			key: `mention:${m.id}`,
			read: !!m.read_at,
			search: mentionSearch(m),
			mention: m,
		}));
		return [...approvalRows, ...mentionRows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
	}, [approvals, mentions]);

	const filtered = useMemo(() => {
		return rows.filter((row) => {
			if (readFilter === 'unread' && row.read) return false;
			if (readFilter === 'read' && !row.read) return false;
			if (debouncedSearch && !row.search.includes(debouncedSearch)) return false;
			return true;
		});
	}, [rows, readFilter, debouncedSearch]);

	if (isLoading) {
		return <div className="text-text-muted">Loading...</div>;
	}

	return (
		<div>
			<h1 className="text-[22px] font-medium mb-5">Inbox</h1>

			<div className="flex flex-col gap-2 mb-4 sm:flex-row sm:items-center sm:justify-between">
				<FilterPills options={READ_OPTIONS} value={readFilter} onChange={setReadFilter} />
				<div className="relative sm:w-64">
					<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-subtle" />
					<input
						type="text"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search inbox..."
						aria-label="Search inbox"
						className="w-full rounded-radius-md border border-border bg-bg pl-8 pr-2.5 py-1.5 text-xs text-text placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-primary"
					/>
				</div>
			</div>

			{rows.length === 0 ? (
				<EmptyState
					icon={<Inbox className="w-10 h-10" />}
					title={archivedView ? 'No archived items' : 'All clear'}
					description={
						archivedView
							? 'Items are archived 30 days after they are read or resolved.'
							: 'No approvals or mentions yet.'
					}
				/>
			) : filtered.length === 0 ? (
				<EmptyState
					icon={<Inbox className="w-10 h-10" />}
					title="Nothing matches"
					description="No inbox items match your filters."
				/>
			) : (
				<div className="flex flex-col gap-3">
					{filtered.map((row) =>
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
