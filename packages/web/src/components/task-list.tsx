import { formatTaskStatus, TaskStatus, TERMINAL_TASK_STATUSES } from '@hezo/shared';
import { useNavigate } from '@tanstack/react-router';
import { AlertTriangle, AtSign, ChevronDown, ListPlus, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAgents } from '../hooks/use-agents';
import { useProjectMeta } from '../hooks/use-projects';
import { type Task, type TaskFilters, useTasks } from '../hooks/use-tasks';
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
import { CreateTaskDialog } from './create-task-dialog';
import { ProjectTaskListHeader } from './project-task-list-header';
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
const DEFAULT_TODO_STATUSES: string[] = DEFAULT_OPEN_STATUSES.filter(
	(s) => !PINNED_STATUS_SET.has(s),
);

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
}

function TaskListSection({ title, testId, tasks, columns, onRowClick }: TaskListSectionProps) {
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
			/>
		</section>
	);
}

export function TaskList({ projectId }: TaskListProps) {
	const navigate = useNavigate();
	const project = useProjectMeta(projectId);
	const showProjectProgress = project != null && !project.is_internal;
	const { data: agents } = useAgents(projectId);
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
	const [page, setPage] = useState(1);
	const [createOpen, setCreateOpen] = useState(false);

	useEffect(() => {
		const handle = setTimeout(() => {
			setDebouncedSearch(search.trim());
			setPage(1);
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
		setPage(1);
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
				.map((a) => ({ value: a.id, label: a.title })),
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

	const { data: result, isLoading: mainLoading } = useTasks(
		projectId,
		{
			...todoFilters,
			status: statusValues.length > 0 ? statusValues.join(',') : undefined,
			page: String(page),
		},
		{ enabled: todoListEnabled },
	);

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
		const rows = (result?.data ?? []).filter((t) => !PINNED_STATUS_SET.has(t.status));
		return {
			backlogTasks: nestTasksForDisplay(rows.filter((t) => !TERMINAL_STATUS_SET.has(t.status))),
			doneTasks: nestTasksForDisplay(rows.filter((t) => TERMINAL_STATUS_SET.has(t.status))),
		};
	}, [result?.data, todoListEnabled]);

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
		if (isDefaultTodoSelection(statusValues)) return 'Open tasks';
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
		setPage(1);
	}

	function handleOwnerChange(next: string[]) {
		setOwnerValues(next);
		persistFilters({ ownerValues: next });
		setPage(1);
	}

	function handleSortFieldChange(next: SortField) {
		setSortField(next);
		persistFilters({ sortField: next });
		setPage(1);
	}

	function handleSortDirChange(next: SortDir) {
		setSortDir(next);
		persistFilters({ sortDir: next });
		setPage(1);
	}

	function resetFilters() {
		setSearch('');
		setStatusValues([...DEFAULT_TODO_STATUSES]);
		setOwnerValues([]);
		setSortField('work_order');
		setSortDir('asc');
		setPage(1);
		clearStoredTaskFilters(projectId);
	}

	const columns: Column<TaskRow>[] = [
		{
			key: 'id',
			header: 'ID',
			width: '88px',
			className: 'font-mono text-text-2',
			render: (row) => {
				const lastRunFailed =
					!row.has_active_run &&
					(row.last_run_status === 'failed' || row.last_run_status === 'timed_out');
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
							<Tooltip content="Unread mention — needs your review">
								<AtSign
									role="img"
									aria-label="Unread mention"
									data-testid="task-mention-notice"
									className="w-3 h-3 text-info shrink-0"
								/>
							</Tooltip>
						)}
						{row.identifier}
					</span>
				);
			},
		},
		{
			key: 'title',
			header: 'Title',
			render: (row) => (
				<span className="font-medium inline-flex items-center gap-1.5 min-w-0">
					{row.depth > 0 && (
						<span className="text-text-3 shrink-0" aria-hidden="true">
							↳
						</span>
					)}
					<span className="truncate">{row.title}</span>
				</span>
			),
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
								<span className="text-text-3">—</span>
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
			render: (row) => (
				<span className="block max-w-[140px] truncate text-text-2">{row.assignee_name || '—'}</span>
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
		<div className="relative flex-1 min-w-0 h-9" data-testid="task-filter-bar">
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
					data-testid="task-filter-panel"
					className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md border border-border bg-surface shadow-md px-3 py-3 flex flex-wrap items-end gap-3"
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
			{showProjectProgress && <ProjectTaskListHeader projectId={projectId} />}

			<div className="mb-4 flex flex-col sm:flex-row items-stretch gap-2">
				{filterBar}
				<Button
					size="sm"
					onClick={() => setCreateOpen(true)}
					data-testid="task-list-new-task"
					className="h-9 sm:shrink-0"
				>
					<Plus className="w-3.5 h-3.5" />
					New task
				</Button>
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
					Loading...
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
					/>

					{backlogTasks.length === 0 && doneTasks.length === 0 && (
						<p
							className="text-text-2 text-[13px] py-6 text-center"
							data-testid="task-list-todo-empty"
						>
							No matching tasks
						</p>
					)}

					{result?.meta && result.meta.total > result.meta.per_page && (
						<div className="flex items-center justify-between mt-4 text-xs text-text-2">
							<span>
								Showing {backlogTasks.length + doneTasks.length} of {result.meta.total}
							</span>
							<div className="flex gap-2">
								<Button
									variant="secondary"
									size="sm"
									disabled={result.meta.page <= 1}
									onClick={() => setPage((p) => Math.max(1, p - 1))}
								>
									Previous
								</Button>
								<Button
									variant="secondary"
									size="sm"
									disabled={result.meta.page * result.meta.per_page >= result.meta.total}
									onClick={() => setPage((p) => p + 1)}
								>
									Next
								</Button>
							</div>
						</div>
					)}
				</>
			)}

			<CreateTaskDialog projectId={projectId} open={createOpen} onOpenChange={setCreateOpen} />
		</div>
	);
}
