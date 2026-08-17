import {
	formatTaskStatus,
	isLastRunFailed,
	TaskStatus,
	TERMINAL_TASK_STATUSES,
} from '@hezo/shared';
import { useNavigate } from '@tanstack/react-router';
import { AlertTriangle, AtSign, ChevronDown, ListPlus, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAgentLookup } from '../hooks/use-agent-lookup';
import { useAgents } from '../hooks/use-agents';
import { usePanelPlacement } from '../hooks/use-panel-placement';
import { type Task, useInfiniteTasks, useTasks } from '../hooks/use-tasks';
import { useI18n } from '../lib/i18n';
import { nestTasksForDisplay } from '../lib/nest-tasks-for-display';
import {
	clearStoredTaskFilters,
	readStoredTaskFilters,
	type TaskSortDir as SortDir,
	type TaskSortField as SortField,
	type StoredTaskFilters,
	writeStoredTaskFilters,
} from '../lib/task-filter-storage';
import { AdminApprovalsBanner } from './admin-approvals-banner';
import { agentDisplayName } from './agent-identity-tooltip';
import { AgentRef } from './agent-ref';
import { CreateTaskDialog } from './create-task-dialog';
import { InfiniteScrollSentinel } from './infinite-scroll-sentinel';
import { TaskMentionTooltipContent } from './task-mention-tooltip';
import { TaskPriorityBadge } from './task-priority-badge';
import { TaskRunDot } from './task-run-dot';
import { TaskStatusBadge } from './task-status-badge';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { type Column, DataTable } from './ui/data-table';
import { EmptyState } from './ui/empty-state';
import { MultiSelect, type MultiSelectOption } from './ui/multi-select';
import { Tooltip } from './ui/tooltip';

const ALL_STATUSES = Object.values(TaskStatus) as string[];
const TERMINAL_STATUS_SET = new Set<string>(TERMINAL_TASK_STATUSES);
const DEFAULT_OPEN_STATUSES: string[] = ALL_STATUSES.filter((s) => !TERMINAL_STATUS_SET.has(s));
/** Task statuses pinned in the top "In progress" section (also excluded from the main list). */
const PINNED_TASK_STATUSES = [TaskStatus.InProgress, TaskStatus.Review] as const;
const PINNED_STATUS_SET = new Set<string>(PINNED_TASK_STATUSES);
const PINNED_STATUS_PARAM = PINNED_TASK_STATUSES.join(',');
// The default selection shows open work (backlog/blocked; in_progress/review are
// pinned in their own section) plus completed (`done`) tasks, which land in the
// bottom "Done" section. `cancelled` stays hidden unless explicitly filtered in.
const DEFAULT_TODO_STATUSES: string[] = [
	...DEFAULT_OPEN_STATUSES.filter((s) => !PINNED_STATUS_SET.has(s)),
	TaskStatus.Done,
];

const todoStatusOptions: MultiSelectOption[] = ALL_STATUSES.filter(
	(s) => !PINNED_STATUS_SET.has(s),
).map((s) => ({
	value: s,
	label: formatTaskStatus(s),
}));

const sortLabels: Record<`${SortField}:${SortDir}`, string> = {
	'work_order:asc': 'Work order',
	'work_order:desc': 'Work order',
	'created_at:desc': 'Newest first',
	'created_at:asc': 'Oldest first',
	'updated_at:desc': 'Recently updated',
	'updated_at:asc': 'Oldest updates',
};

function isDefaultTodoSelection(values: string[]): boolean {
	if (values.length !== DEFAULT_TODO_STATUSES.length) return false;
	const set = new Set(values);
	return DEFAULT_TODO_STATUSES.every((s) => set.has(s));
}

type TaskRow = Pick<
	Task,
	| 'id'
	| 'identifier'
	| 'title'
	| 'status'
	| 'priority'
	| 'parent_task_id'
	| 'project_name'
	| 'project_slug'
	| 'assignee_id'
	| 'assignee_name'
	| 'assignee_type'
	| 'has_active_run'
	| 'has_unread_admin_mention'
	| 'last_run_status'
	| 'queued_wakeup'
> & { depth: number };

interface TaskListProps {
	projectId: string;
}

interface TaskListSectionProps {
	title: string;
	testId: string;
	tasks: TaskRow[];
	columns: Column<TaskRow>[];
	onRowClick: (row: TaskRow) => void;
	/** Dim the section's rows — used for finished (terminal) work in "Done". */
	faded?: boolean;
}

function TaskListSection({
	title,
	testId,
	tasks,
	columns,
	onRowClick,
	faded,
}: TaskListSectionProps) {
	if (tasks.length === 0) return null;

	return (
		<section data-testid={testId} className="mb-6 last:mb-0">
			<h2 className="text-[11px] font-medium uppercase tracking-wider text-text-3 mb-2 px-0.5">
				{title}
			</h2>
			<DataTable
				columns={columns}
				data={tasks}
				rowKey={(row) => row.id}
				onRowClick={onRowClick}
				getRowDepth={(row) => row.depth}
				indentColumnKey="title"
				// Fade finished work via opacity — reads as "faded" in both light and
				// dark themes (it only lowers alpha, no theme-specific colour).
				rowClassName={faded ? () => 'opacity-60' : undefined}
			/>
		</section>
	);
}

/**
 * Title cell: the ID column claims its full width (it never wraps), so the title
 * is what gives - it truncates with an ellipsis. A tooltip carrying the full ID
 * and title (the same card the task @mention link shows) makes that lossless.
 *
 * The tooltip is driven as a controlled Radix root rather than conditionally
 * wrapping the span: the `<Tooltip>` stays mounted either way, so the measured
 * node's ref never detaches. Truncation is measured on hover intent inside
 * `onOpenChange`, which keeps a long list free of per-row ResizeObservers.
 */
function TaskTitleCell({ row }: { row: TaskRow }) {
	const textRef = useRef<HTMLSpanElement>(null);
	const [open, setOpen] = useState(false);
	return (
		<Tooltip
			open={open}
			onOpenChange={(next) => {
				const el = textRef.current;
				// Only open when the title is actually clipped; a fully visible title
				// has nothing to reveal.
				if (next && (!el || el.scrollWidth <= el.clientWidth + 1)) return;
				setOpen(next);
			}}
			content={
				<TaskMentionTooltipContent
					identifier={row.identifier}
					title={row.title}
					status={row.status}
				/>
			}
		>
			<span className="font-medium inline-flex items-center gap-1.5 min-w-0 max-w-full">
				{row.depth > 0 && (
					<span className="text-text-3 shrink-0" aria-hidden="true">
						↳
					</span>
				)}
				<span ref={textRef} className="truncate">
					{row.title}
				</span>
			</span>
		</Tooltip>
	);
}

export function TaskList({ projectId }: TaskListProps) {
	const { t } = useI18n();
	const navigate = useNavigate();
	const { data: agents } = useAgents(projectId);
	const { byMemberId: agentsByMemberId } = useAgentLookup(projectId);
	const [expanded, setExpanded] = useState(false);
	// Hydrate the filter bar from this project's last-set selections (or defaults).
	const [stored] = useState(() => readStoredTaskFilters(projectId));
	const [search, setSearch] = useState(stored?.search ?? '');
	const [debouncedSearch, setDebouncedSearch] = useState((stored?.search ?? '').trim());
	const [statusValues, setStatusValues] = useState<string[]>(
		stored?.statusValues ?? [...DEFAULT_TODO_STATUSES],
	);
	const [ownerValues, setOwnerValues] = useState<string[]>(stored?.ownerValues ?? []);
	const [sortField, setSortField] = useState<SortField>(stored?.sortField ?? 'work_order');
	const [sortDir, setSortDir] = useState<SortDir>(stored?.sortDir ?? 'asc');
	const [createOpen, setCreateOpen] = useState(false);

	const filterBarRef = useRef<HTMLDivElement>(null);
	// No design cap: the panel is a wrap-around form, so it stays exactly as tall
	// as its content wherever there is room and only clamps on a short viewport.
	const {
		panelRef: filterPanelRef,
		side: filterSide,
		sideClassName: filterSideClass,
		style: filterPanelStyle,
	} = usePanelPlacement<HTMLDivElement>(filterBarRef, { open: expanded });

	useEffect(() => {
		const handle = setTimeout(() => {
			setDebouncedSearch(search.trim());
		}, 250);
		return () => clearTimeout(handle);
	}, [search]);

	// The route reuses this component across projects (param change, no remount),
	// so re-hydrate the filter bar when the project changes. The initial project is
	// already hydrated above; skip it to avoid clobbering the lazy-init values.
	const hydratedProjectRef = useRef(projectId);
	useEffect(() => {
		if (hydratedProjectRef.current === projectId) return;
		hydratedProjectRef.current = projectId;
		const next = readStoredTaskFilters(projectId);
		setSearch(next?.search ?? '');
		setDebouncedSearch((next?.search ?? '').trim());
		setStatusValues(next?.statusValues ?? [...DEFAULT_TODO_STATUSES]);
		setOwnerValues(next?.ownerValues ?? []);
		setSortField(next?.sortField ?? 'work_order');
		setSortDir(next?.sortDir ?? 'asc');
	}, [projectId]);

	// Persist the full filter set on every change, overriding the one field that
	// changed (state setters above haven't flushed into this closure yet). Writing
	// from the change handlers — rather than an effect watching the values — keeps
	// the project-switch re-hydration from racing a stale write back to storage.
	const persistFilters = useCallback(
		(override: Partial<StoredTaskFilters>) => {
			writeStoredTaskFilters(projectId, {
				search,
				statusValues,
				ownerValues,
				sortField,
				sortDir,
				...override,
			});
		},
		[projectId, search, statusValues, ownerValues, sortField, sortDir],
	);

	const ownerOptions: MultiSelectOption[] = useMemo(
		() =>
			(agents ?? [])
				.filter((a) => a.admin_status !== 'disabled')
				.map((a) => ({ value: a.id, label: agentDisplayName(a) })),
		[agents],
	);

	const todoFilters = useMemo(
		() => ({
			project_id: projectId,
			assignee_id: ownerValues.length > 0 ? ownerValues.join(',') : undefined,
			search: debouncedSearch || undefined,
			sort: `${sortField}:${sortDir}`,
		}),
		[projectId, ownerValues, debouncedSearch, sortField, sortDir],
	);

	const { data: inProgressResult, isLoading: inProgressLoading } = useTasks(projectId, {
		project_id: projectId,
		status: PINNED_STATUS_PARAM,
		sort: 'updated_at:desc',
		page: '1',
		per_page: '200',
	});

	const todoListEnabled = statusValues.length > 0;

	const {
		data: infiniteData,
		isLoading: mainLoading,
		hasNextPage,
		isFetchingNextPage,
		fetchNextPage,
	} = useInfiniteTasks(
		projectId,
		{
			...todoFilters,
			status: statusValues.length > 0 ? statusValues.join(',') : undefined,
		},
		{ enabled: todoListEnabled },
	);

	const mainRows = useMemo(
		() => (infiniteData?.pages ?? []).flatMap((p) => p.data),
		[infiniteData],
	);
	const totalCount = infiniteData?.pages[0]?.meta.total ?? 0;

	const inProgressTasks = useMemo(
		() => nestTasksForDisplay(inProgressResult?.data ?? []),
		[inProgressResult?.data],
	);
	// Split the filtered main list into "Backlog" (open work) and "Done" (terminal:
	// done/closed/cancelled). Each group nests independently so a child whose parent
	// sits in the other group surfaces at the top level of its own section — the same
	// way the In-progress / Backlog split already behaves across separate queries.
	const { backlogTasks, doneTasks } = useMemo<{
		backlogTasks: TaskRow[];
		doneTasks: TaskRow[];
	}>(() => {
		if (!todoListEnabled) return { backlogTasks: [], doneTasks: [] };
		const rows = mainRows.filter((t) => !PINNED_STATUS_SET.has(t.status));
		return {
			backlogTasks: nestTasksForDisplay(rows.filter((t) => !TERMINAL_STATUS_SET.has(t.status))),
			// Finished work reads best as a recent-activity log: always most-recently
			// updated first, independent of the sort dropdown (which governs the
			// Backlog) — the same treatment the pinned In-progress section gets.
			// `updated_at` is trigger-maintained server-side, so it's a reliable key;
			// localeCompare on the ISO string keeps ties stable (falls back to the
			// server order). Sorting the full Task rows before nesting needs no type
			// change, and nestTasksForDisplay preserves this sibling order.
			doneTasks: nestTasksForDisplay(
				rows
					.filter((t) => TERMINAL_STATUS_SET.has(t.status))
					.sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
			),
		};
	}, [mainRows, todoListEnabled]);

	const hasNoTasksAtAll =
		!inProgressLoading &&
		!mainLoading &&
		inProgressTasks.length === 0 &&
		backlogTasks.length === 0 &&
		doneTasks.length === 0;

	const ownerLabelById = useMemo(() => {
		const map = new Map<string, string>();
		for (const o of ownerOptions) map.set(o.value, o.label);
		return map;
	}, [ownerOptions]);

	const statusLabel: string | null = (() => {
		if (statusValues.length === 0) return 'No statuses';
		if (statusValues.length === ALL_STATUSES.length) return 'All statuses';
		if (isDefaultTodoSelection(statusValues)) return 'Open & done';
		if (statusValues.length === 1) return `Status: ${formatTaskStatus(statusValues[0])}`;
		return `${statusValues.length} statuses`;
	})();

	const ownerLabel: string | null =
		ownerValues.length === 0
			? null
			: ownerValues.length === 1
				? `Owner: ${ownerLabelById.get(ownerValues[0]) ?? '1 owner'}`
				: `${ownerValues.length} owners`;

	const summaryBits: string[] = [
		sortLabels[`${sortField}:${sortDir}`],
		...(statusLabel ? [statusLabel] : []),
		...(ownerLabel ? [ownerLabel] : []),
		...(debouncedSearch ? [`Matching "${debouncedSearch}"`] : []),
	];

	function handleSearchChange(next: string) {
		setSearch(next);
		persistFilters({ search: next });
	}

	function handleStatusChange(next: string[]) {
		setStatusValues(next);
		persistFilters({ statusValues: next });
	}

	function handleOwnerChange(next: string[]) {
		setOwnerValues(next);
		persistFilters({ ownerValues: next });
	}

	function handleSortFieldChange(next: SortField) {
		setSortField(next);
		persistFilters({ sortField: next });
	}

	function handleSortDirChange(next: SortDir) {
		setSortDir(next);
		persistFilters({ sortDir: next });
	}

	function resetFilters() {
		setSearch('');
		setStatusValues([...DEFAULT_TODO_STATUSES]);
		setOwnerValues([]);
		setSortField('work_order');
		setSortDir('asc');
		clearStoredTaskFilters(projectId);
	}

	const columns: Column<TaskRow>[] = [
		{
			key: 'id',
			header: 'ID',
			width: '88px',
			// `whitespace-nowrap` lands on the <td> (DataTable appends col.className
			// last). It stops the identifier breaking at its hyphen, and — because the
			// table uses auto layout, where `width` is only a hint — it also raises the
			// column's min-content width to the real content width (dot + any badges +
			// identifier), so the wide Title column can no longer starve it.
			className: 'font-mono text-text-2 whitespace-nowrap',
			render: (row) => {
				const lastRunFailed = isLastRunFailed(row.has_active_run, row.last_run_status);
				return (
					<span className="inline-flex items-center gap-1.5">
						<TaskRunDot hasActiveRun={row.has_active_run} queuedWakeup={row.queued_wakeup} />
						{lastRunFailed && (
							<Tooltip content="Last run failed">
								<span
									role="img"
									aria-label="Last run failed"
									data-testid="task-failed-warning"
									className="inline-flex shrink-0 text-danger"
								>
									<AlertTriangle className="w-3 h-3" aria-hidden="true" />
								</span>
							</Tooltip>
						)}
						{row.has_unread_admin_mention && (
							<Tooltip content="Unread mention - needs your review">
								<AtSign
									role="img"
									aria-label="Unread mention"
									data-testid="task-mention-notice"
									className="w-3 h-3 text-info shrink-0"
								/>
							</Tooltip>
						)}
						<span data-testid="task-identifier">{row.identifier}</span>
					</span>
				);
			},
		},
		{
			key: 'title',
			header: 'Title',
			// The table uses auto layout, where a cell's min-content width is its
			// widest unbreakable content — so a `truncate` (nowrap) title made this
			// column demand the full title width, overflowing the table and starving
			// the fixed-width columns instead of ellipsising. `max-w-0` drops that
			// contribution and `w-full` claims whatever the other columns leave, which
			// is what actually lets the ellipsis engage.
			className: 'max-w-0 w-full',
			render: (row) => <TaskTitleCell row={row} />,
		},
		...(projectId
			? []
			: [
					{
						key: 'project' as const,
						header: 'Project',
						width: '100px',
						hideOnMobile: true,
						render: (row: TaskRow) =>
							row.project_name ? (
								<Badge color="info">{row.project_name}</Badge>
							) : (
								<span className="text-text-3">-</span>
							),
					},
				]),
		{
			key: 'status',
			header: 'Status',
			width: '100px',
			render: (row) => <TaskStatusBadge status={row.status} />,
		},
		{
			key: 'priority',
			header: 'Priority',
			width: '80px',
			hideOnMobile: true,
			render: (row) => <TaskPriorityBadge priority={row.priority} />,
		},
		{
			key: 'assignee',
			header: 'Assignee',
			width: '120px',
			hideOnMobile: true,
			render: (row) =>
				row.assignee_id && agentsByMemberId.get(row.assignee_id) ? (
					<AgentRef
						agent={agentsByMemberId.get(row.assignee_id)}
						fallbackName={row.assignee_name ?? undefined}
						className="block max-w-[140px] truncate text-text-2"
					/>
				) : (
					<span className="block max-w-[140px] truncate text-text-2">
						{row.assignee_name || '-'}
					</span>
				),
		},
	];

	const handleRowClick = useCallback(
		(row: TaskRow) => {
			navigate({
				to: '/projects/$projectId/tasks/$taskId',
				params: {
					projectId: row.project_slug ?? projectId,
					taskId: row.identifier.toLowerCase(),
				},
			});
		},
		[navigate, projectId],
	);

	const filterBar = (
		<div ref={filterBarRef} className="relative flex-1 min-w-0 h-10" data-testid="task-filter-bar">
			<div className="h-full rounded-md border border-border bg-surface">
				<button
					type="button"
					onClick={() => setExpanded((e) => !e)}
					aria-expanded={expanded}
					data-testid="task-filter-toggle"
					className="flex h-full items-center gap-2 w-full text-left cursor-pointer px-3"
				>
					<ChevronDown
						className={`w-3.5 h-3.5 text-text-3 shrink-0 transition-transform ${
							expanded ? '' : '-rotate-90'
						}`}
					/>
					<span className="truncate text-xs text-text-2">Showing {summaryBits.join(' · ')}</span>
				</button>
			</div>
			{expanded && (
				<div
					ref={filterPanelRef}
					data-testid="task-filter-panel"
					data-placement={filterSide}
					style={filterPanelStyle}
					className={`absolute left-0 right-0 z-20 ${filterSideClass} rounded-md border border-border bg-surface shadow-md overflow-y-auto px-3 py-3 flex flex-wrap items-end gap-3`}
				>
					<label className="flex flex-col gap-1 flex-1 min-w-0 sm:min-w-[180px]">
						<span className="text-[11px] uppercase tracking-wider text-text-3">Search</span>
						<div className="relative">
							<Search className="w-3.5 h-3.5 text-text-3 absolute left-2.5 top-1/2 -translate-y-1/2" />
							<input
								type="text"
								value={search}
								onChange={(e) => handleSearchChange(e.target.value)}
								placeholder="Filter by title..."
								data-testid="task-filter-search"
								className="w-full rounded-md border border-border bg-surface pl-8 pr-2.5 py-1.5 text-xs text-text-1 outline-none focus:border-border-strong"
							/>
						</div>
					</label>

					<label className="flex flex-col gap-1">
						<span className="text-[11px] uppercase tracking-wider text-text-3">Sort</span>
						<div className="flex gap-1">
							<select
								value={sortField}
								onChange={(e) => handleSortFieldChange(e.target.value as SortField)}
								data-testid="task-filter-sort-field"
								className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text-1 outline-none"
							>
								<option value="work_order">Work order</option>
								<option value="created_at">Created</option>
								<option value="updated_at">Updated</option>
							</select>
							{sortField !== 'work_order' && (
								<select
									value={sortDir}
									onChange={(e) => handleSortDirChange(e.target.value as SortDir)}
									data-testid="task-filter-sort-dir"
									className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text-1 outline-none"
								>
									<option value="desc">desc</option>
									<option value="asc">asc</option>
								</select>
							)}
						</div>
					</label>

					<div className="flex flex-col gap-1">
						<span className="text-[11px] uppercase tracking-wider text-text-3">Status</span>
						<MultiSelect
							label="Status"
							options={todoStatusOptions}
							value={statusValues}
							onChange={handleStatusChange}
							testId="task-filter-status"
						/>
					</div>

					<div className="flex flex-col gap-1">
						<span className="text-[11px] uppercase tracking-wider text-text-3">Owner</span>
						<MultiSelect
							label="Owner"
							options={ownerOptions}
							value={ownerValues}
							onChange={handleOwnerChange}
							testId="task-filter-owner"
						/>
					</div>

					<Button size="sm" variant="ghost" onClick={resetFilters} data-testid="task-filter-reset">
						Reset
					</Button>
				</div>
			)}
		</div>
	);

	return (
		<div>
			<AdminApprovalsBanner projectId={projectId} />

			<div className="mb-4 flex flex-row items-stretch gap-2">
				{filterBar}
				{/* Create button pinned to the filter bar's row, matching its height.
				    Icon-only on mobile/tablet to save space; the "New task" label
				    appears at the desktop breakpoint (lg+). The accessible name keeps
				    it discoverable at every width. */}
				<button
					type="button"
					onClick={() => setCreateOpen(true)}
					data-testid="task-list-new-task"
					aria-label="New task"
					title="New task"
					className="flex h-10 w-10 shrink-0 items-center justify-center gap-1.5 rounded-md bg-inverse text-inverse-fg transition-colors hover:opacity-90 outline-none focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:border-accent lg:w-auto lg:px-3"
				>
					<Plus className="w-4 h-4" />
					<span className="hidden text-[13px] font-medium whitespace-nowrap lg:inline">
						New task
					</span>
				</button>
			</div>

			{inProgressLoading ? (
				<div
					data-testid="task-list-in-progress-loading"
					className="text-text-2 text-[13px] py-4 text-center mb-6"
				>
					Loading in progress...
				</div>
			) : (
				<TaskListSection
					title="In progress"
					testId="task-list-in-progress"
					tasks={inProgressTasks}
					columns={columns}
					onRowClick={handleRowClick}
				/>
			)}

			{mainLoading ? (
				<div
					data-testid="task-list-loading"
					className="text-text-2 text-[13px] py-8 text-center mb-6"
				>
					{t('common.loading')}
				</div>
			) : hasNoTasksAtAll ? (
				<EmptyState
					variant="hero"
					icon={<ListPlus className="w-8 h-8" />}
					title="No tasks yet"
					description="Create a task to get the team moving."
					action={
						<Button
							size="lg"
							onClick={() => setCreateOpen(true)}
							data-testid="task-list-empty-create"
						>
							<Plus className="w-4 h-4" />
							Create a task
						</Button>
					}
				/>
			) : (
				<>
					{/* Open work and finished work each get their own section; an empty one
					    is omitted entirely (TaskListSection returns null). */}
					<TaskListSection
						title="Backlog"
						testId="task-list-main"
						tasks={backlogTasks}
						columns={columns}
						onRowClick={handleRowClick}
					/>
					<TaskListSection
						title="Done"
						testId="task-list-done"
						tasks={doneTasks}
						columns={columns}
						onRowClick={handleRowClick}
						faded
					/>

					{backlogTasks.length === 0 && doneTasks.length === 0 && (
						<p
							className="text-text-2 text-[13px] py-6 text-center"
							data-testid="task-list-todo-empty"
						>
							No matching tasks
						</p>
					)}

					{(backlogTasks.length > 0 || doneTasks.length > 0) && (
						<div className="mt-4 flex flex-col items-center gap-2 text-xs text-text-2">
							<span data-testid="task-list-count">
								Showing {backlogTasks.length + doneTasks.length} of {totalCount}
							</span>
							<InfiniteScrollSentinel
								hasNextPage={hasNextPage}
								isFetchingNextPage={isFetchingNextPage}
								onLoadMore={() => fetchNextPage()}
								testId="task-list"
							/>
						</div>
					)}
				</>
			)}

			<CreateTaskDialog projectId={projectId} open={createOpen} onOpenChange={setCreateOpen} />
		</div>
	);
}
