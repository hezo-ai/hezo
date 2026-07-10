import { type AdminMentionItem, ApprovalStatus } from '@hezo/shared';
import { CheckCheck, Inbox, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAllAdminMentions, useMarkAllMentionsRead } from '../hooks/use-admin-mentions';
import { type Approval, useAllApprovals } from '../hooks/use-approvals';
import { ApprovalCard } from './approval-card';
import { MentionCard } from './mention-card';
import { EmptyState } from './ui/empty-state';
import { FilterPills } from './ui/filter-pills';
import { InfoTooltip } from './ui/info-tooltip';

interface InboxViewProps {
	projectSlugs: string[];
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
	{ value: 'unread', label: 'Unread' },
	{ value: 'read', label: 'Read' },
	{ value: 'all', label: 'All' },
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

export function InboxView({ projectSlugs, scope }: InboxViewProps) {
	const [readFilter, setReadFilter] = useState<ReadFilter>('unread');
	const archivedView = readFilter === 'archived';
	const { data: approvals, isLoading: approvalsLoading } = useAllApprovals(projectSlugs, {
		archived: archivedView,
	});
	const { data: mentions, isLoading: mentionsLoading } = useAllAdminMentions(projectSlugs, {
		archived: archivedView,
	});
	const markAllRead = useMarkAllMentionsRead();
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

	// Projects that still have an unread mention. "Mark all as read" targets
	// mentions only — approvals become read by being resolved, not dismissed.
	const unreadMentionSlugs = useMemo(() => {
		const slugs = new Set<string>();
		for (const m of mentions ?? []) {
			if (!m.read_at) slugs.add(m.project_slug);
		}
		return [...slugs];
	}, [mentions]);

	const handleMarkAllRead = () => {
		for (const slug of unreadMentionSlugs) {
			markAllRead.mutate(slug);
		}
	};

	if (isLoading) {
		return <div className="text-text-2">Loading...</div>;
	}

	return (
		<div>
			<div className="flex items-center gap-1.5 mb-5">
				<h1 className="text-[22px] font-medium">{scope === 'global' ? 'Global inbox' : 'Inbox'}</h1>
				<InfoTooltip
					label="About the inbox"
					content={
						scope === 'global'
							? 'Approvals and mentions waiting on you from every team you belong to.'
							: 'Approvals and mentions waiting on you in this team.'
					}
					data-testid="inbox-info"
				/>
			</div>

			<div className="flex flex-col gap-2 mb-4 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
					<FilterPills
						options={READ_OPTIONS}
						value={readFilter}
						onChange={setReadFilter}
						className=""
					/>
					{readFilter === 'unread' && (
						<button
							type="button"
							onClick={handleMarkAllRead}
							disabled={unreadMentionSlugs.length === 0 || markAllRead.isPending}
							className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-[12px] text-text-3 transition-colors hover:bg-surface-2 hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-3"
						>
							<CheckCheck className="w-3.5 h-3.5" />
							Mark all as read
						</button>
					)}
				</div>
				<div className="relative sm:w-64">
					<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-3" />
					<input
						type="text"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search inbox..."
						aria-label="Search inbox"
						className="w-full rounded-md border border-border bg-surface pl-8 pr-2.5 py-1.5 text-xs text-text-1 placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-inverse"
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
