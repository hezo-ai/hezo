import { type AdminMentionItem, ApprovalStatus } from '@hezo/shared';
import { CheckCheck, Inbox, Search, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAllAdminMentions, useMarkAllMentionsRead } from '../hooks/use-admin-mentions';
import { type Approval, useAllApprovals } from '../hooks/use-approvals';
import { useMediaQuery } from '../hooks/use-media-query';
import { useI18n } from '../lib/i18n';
import { compareInboxRowsForSort, InboxSortOrder } from '../lib/inbox-sort';
import { ApprovalCard } from './approval-card';
import { InboxFilterDialog } from './inbox-filter-dialog';
import { MentionCard } from './mention-card';
import { CountOverlayBadge } from './ui/count-overlay-badge';
import { EmptyState } from './ui/empty-state';
import { FilterPills } from './ui/filter-pills';
import { InfoTooltip } from './ui/info-tooltip';

interface InboxViewProps {
	projectSlugs: string[];
	scope: 'team' | 'global';
	/** Owned by each route's `sort` search param, so a link carries the order. */
	sort: InboxSortOrder;
	onSortChange: (next: InboxSortOrder) => void;
}

type ReadFilter = 'all' | 'unread' | 'read' | 'archived';

const DEFAULT_READ_FILTER: ReadFilter = 'unread';

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

function mentionSearch(m: AdminMentionItem): string {
	return [
		m.task_identifier,
		m.task_title,
		m.author_slug,
		m.author_display_name,
		m.credential_name,
		m.snippet,
	]
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

export function InboxView({ projectSlugs, scope, sort, onSortChange }: InboxViewProps) {
	const { t } = useI18n();
	const [readFilter, setReadFilter] = useState<ReadFilter>(DEFAULT_READ_FILTER);
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
	const [filtersOpen, setFiltersOpen] = useState(false);

	// One branch or the other, never both behind a CSS `hidden` — two rendered
	// copies of the read filter would put every label on the page twice, for
	// assistive tech and for any query that looks one up by its text.
	const isDesktop = useMediaQuery('(min-width: 640px)');

	const readOptions: { value: ReadFilter; label: string }[] = [
		{ value: 'unread', label: t('inbox.filter.unread') },
		{ value: 'read', label: t('inbox.filter.read') },
		{ value: 'all', label: t('inbox.filter.all') },
		{ value: 'archived', label: t('inbox.filter.archived') },
	];

	const sortOptions: { value: InboxSortOrder; label: string }[] = [
		{ value: InboxSortOrder.Newest, label: t('inbox.sort.newest') },
		{ value: InboxSortOrder.Oldest, label: t('inbox.sort.oldest') },
	];

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
		return [...approvalRows, ...mentionRows].sort((a, b) => compareInboxRowsForSort(a, b, sort));
	}, [approvals, mentions, sort]);

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

	// Only offered where it applies: an approval becomes read by being resolved,
	// so the action belongs to the unread view alone.
	const markAllReadAvailable = readFilter === 'unread';
	const markAllReadDisabled = unreadMentionSlugs.length === 0 || markAllRead.isPending;

	// How many of the two controls are off their default. Shown on the mobile
	// trigger so a narrowed inbox never reads as an empty one.
	const activeFilterCount =
		(readFilter === DEFAULT_READ_FILTER ? 0 : 1) + (sort === InboxSortOrder.Newest ? 0 : 1);

	if (isLoading) {
		return <div className="text-text-2">{t('common.loading')}</div>;
	}

	const searchBox = (
		<div className="relative w-full">
			<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-3" />
			<input
				type="text"
				value={search}
				onChange={(e) => setSearch(e.target.value)}
				placeholder={t('inbox.search.placeholder')}
				aria-label={t('inbox.search.label')}
				className="w-full rounded-md border border-border bg-surface pl-8 pr-2.5 py-1.5 text-xs text-text-1 placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-inverse"
			/>
		</div>
	);

	return (
		<div>
			<div className="flex items-center gap-1.5 mb-5">
				<h1 className="text-[22px] font-medium">
					{scope === 'global' ? t('inbox.titleGlobal') : t('inbox.title')}
				</h1>
				<InfoTooltip
					label={t('inbox.about.label')}
					content={scope === 'global' ? t('inbox.about.global') : t('inbox.about.team')}
					data-testid="inbox-info"
				/>
			</div>

			{isDesktop ? (
				<div className="flex items-center justify-between gap-3 mb-4">
					<div className="flex items-center gap-2">
						<FilterPills
							options={readOptions}
							value={readFilter}
							onChange={setReadFilter}
							label={t('inbox.filters.showLabel')}
							className=""
						/>
						<FilterPills
							options={sortOptions}
							value={sort}
							onChange={onSortChange}
							label={t('inbox.filters.sortLabel')}
							tone="plain"
							className=""
						/>
						{markAllReadAvailable && (
							<button
								type="button"
								onClick={handleMarkAllRead}
								disabled={markAllReadDisabled}
								data-testid="inbox-mark-all-read"
								className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-[12px] text-text-3 transition-colors hover:bg-surface-2 hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-3"
							>
								<CheckCheck className="w-3.5 h-3.5" />
								{t('inbox.markAllRead')}
							</button>
						)}
					</div>
					<div className="w-64 shrink-0">{searchBox}</div>
				</div>
			) : (
				<div className="flex items-center gap-2 mb-4">
					{searchBox}
					<button
						type="button"
						onClick={() => setFiltersOpen(true)}
						aria-label={t('inbox.filters.open')}
						aria-haspopup="dialog"
						data-testid="inbox-filter-trigger"
						className={`relative inline-flex shrink-0 items-center justify-center rounded-md border p-1.5 transition-colors ${
							activeFilterCount > 0
								? 'border-border-strong bg-surface-2 text-text-1'
								: 'border-border bg-surface text-text-2 hover:border-border-strong hover:text-text-1'
						}`}
					>
						<SlidersHorizontal className="w-3.5 h-3.5" />
						<CountOverlayBadge count={activeFilterCount} testId="inbox-filter-count" />
					</button>
				</div>
			)}

			{!isDesktop && (
				<InboxFilterDialog
					open={filtersOpen}
					onOpenChange={setFiltersOpen}
					readOptions={readOptions}
					readFilter={readFilter}
					onReadFilterChange={setReadFilter}
					sortOptions={sortOptions}
					sort={sort}
					onSortChange={onSortChange}
					onMarkAllRead={markAllReadAvailable ? handleMarkAllRead : undefined}
					markAllReadDisabled={markAllReadDisabled}
				/>
			)}

			{rows.length === 0 ? (
				<EmptyState
					icon={<Inbox className="w-10 h-10" />}
					title={archivedView ? t('inbox.empty.archived.title') : t('inbox.empty.allClear.title')}
					description={
						archivedView ? t('inbox.empty.archived.body') : t('inbox.empty.allClear.body')
					}
				/>
			) : filtered.length === 0 ? (
				<EmptyState
					icon={<Inbox className="w-10 h-10" />}
					title={t('inbox.empty.noMatch.title')}
					description={t('inbox.empty.noMatch.body')}
				/>
			) : (
				<div className="flex flex-col gap-3" data-testid="inbox-rows">
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
