import { formatTaskStatus, TaskStatus, TERMINAL_TASK_STATUSES } from '@hezo/shared';
import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, ListPlus, Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAgents } from '../hooks/use-agents';
import { type TaskFilters, useTasks } from '../hooks/use-tasks';
import { CreateTaskDialog } from './create-task-dialog';
import { TaskStatusBadge } from './task-status-badge';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { type Column, DataTable } from './ui/data-table';
import { EmptyState } from './ui/empty-state';
import { MultiSelect, type MultiSelectOption } from './ui/multi-select';

const priorityColors: Record<string, string> = {
	urgent: 'danger',
	high: 'warning',
	medium: 'info',
	low: 'neutral',
};

const ALL_STATUSES = Object.values(TaskStatus) as string[];
const TERMINAL_STATUS_SET = new Set<string>(TERMINAL_TASK_STATUSES);
const DEFAULT_OPEN_STATUSES: string[] = ALL_STATUSES.filter((s) => !TERMINAL_STATUS_SET.has(s));

const statusOptions: MultiSelectOption[] = ALL_STATUSES.map((s) => ({
	value: s,
	label: formatTaskStatus(s),
}));

type SortField = 'created_at' | 'updated_at';
type SortDir = 'asc' | 'desc';

const sortLabels: Record<`${SortField}:${SortDir}`, string> = {
	'created_at:desc': 'Newest first',
	'created_at:asc': 'Oldest first',
	'updated_at:desc': 'Recently updated',
	'updated_at:asc': 'Oldest updates',
};

function isDefaultOpenSelection(values: string[]): boolean {
	if (values.length !== DEFAULT_OPEN_STATUSES.length) return false;
	const set = new Set(values);
	return DEFAULT_OPEN_STATUSES.every((s) => set.has(s));
}

interface TaskRow {
	id: string;
	identifier: string;
	title: string;
	status: string;
	priority: string;
	project_name: string | null;
	project_slug: string | null;
	assignee_name: string | null;
	assignee_type: 'agent' | 'user' | null;
	has_active_run: boolean;
}

interface TaskListProps {
	teamId: string;
	projectId?: string;
}

export function TaskList({ teamId, projectId }: TaskListProps) {
	const navigate = useNavigate();
	const { data: agents } = useAgents(teamId);
	const [expanded, setExpanded] = useState(false);
	const [search, setSearch] = useState('');
	const [debouncedSearch, setDebouncedSearch] = useState('');
	const [statusValues, setStatusValues] = useState<string[]>(() => [...DEFAULT_OPEN_STATUSES]);
	const [ownerValues, setOwnerValues] = useState<string[]>([]);
	const [sortField, setSortField] = useState<SortField>('created_at');
	const [sortDir, setSortDir] = useState<SortDir>('desc');
	const [page, setPage] = useState(1);
	const [createOpen, setCreateOpen] = useState(false);

	useEffect(() => {
		const handle = setTimeout(() => {
			setDebouncedSearch(search.trim());
			setPage(1);
		}, 250);
		return () => clearTimeout(handle);
	}, [search]);

	const ownerOptions: MultiSelectOption[] = useMemo(
		() =>
			(agents ?? [])
				.filter((a) => a.admin_status !== 'disabled')
				.map((a) => ({ value: a.id, label: a.title })),
		[agents],
	);

	const activeFilters: TaskFilters = {
		project_id: projectId,
		status: statusValues.length > 0 ? statusValues.join(',') : undefined,
		assignee_id: ownerValues.length > 0 ? ownerValues.join(',') : undefined,
		search: debouncedSearch || undefined,
		sort: `${sortField}:${sortDir}`,
		page: String(page),
	};
	const { data: result, isLoading } = useTasks(teamId, activeFilters);
	const tasks = result?.data ?? [];

	const ownerLabelById = useMemo(() => {
		const map = new Map<string, string>();
		for (const o of ownerOptions) map.set(o.value, o.label);
		return map;
	}, [ownerOptions]);

	const statusLabel: string | null = (() => {
		if (statusValues.length === 0) return 'No statuses';
		if (statusValues.length === ALL_STATUSES.length) return 'All statuses';
		if (isDefaultOpenSelection(statusValues)) return 'Open tasks';
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

	function handleStatusChange(next: string[]) {
		setStatusValues(next);
		setPage(1);
	}

	function handleOwnerChange(next: string[]) {
		setOwnerValues(next);
		setPage(1);
	}

	function handleSortFieldChange(next: SortField) {
		setSortField(next);
		setPage(1);
	}

	function handleSortDirChange(next: SortDir) {
		setSortDir(next);
		setPage(1);
	}

	function resetFilters() {
		setSearch('');
		setStatusValues([...DEFAULT_OPEN_STATUSES]);
		setOwnerValues([]);
		setSortField('created_at');
		setSortDir('desc');
		setPage(1);
	}

	const columns: Column<TaskRow>[] = [
		{
			key: 'id',
			header: 'ID',
			width: '88px',
			className: 'font-mono text-text-muted',
			render: (row) => (
				<span className="inline-flex items-center gap-1.5">
					{row.has_active_run && (
						<span
							data-testid="task-running-dot"
							title="Agent run in progress"
							className="inline-block w-2 h-2 rounded-full bg-accent-amber animate-pulse shrink-0"
						/>
					)}
					{row.identifier}
				</span>
			),
		},
		{
			key: 'title',
			header: 'Title',
			render: (row) => <span className="font-medium">{row.title}</span>,
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
								<span className="text-text-subtle">—</span>
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
			render: (row) => (
				<Badge color={priorityColors[row.priority] as 'neutral'}>{row.priority}</Badge>
			),
		},
		{
			key: 'assignee',
			header: 'Assignee',
			width: '100px',
			hideOnMobile: true,
			render: (row) => <span className="text-text-muted">{row.assignee_name || '—'}</span>,
		},
	];

	return (
		<div>
			<div className="mb-4 flex flex-col sm:flex-row items-stretch sm:items-start gap-2">
				<div
					data-testid="task-filter-bar"
					className="flex-1 min-w-0 rounded-md border border-border bg-bg-elevated overflow-hidden"
				>
					<button
						type="button"
						onClick={() => setExpanded((e) => !e)}
						aria-expanded={expanded}
						data-testid="task-filter-toggle"
						className="flex items-center gap-2 w-full text-left cursor-pointer px-3 py-2"
					>
						<ChevronDown
							className={`w-3.5 h-3.5 text-text-subtle shrink-0 transition-transform ${
								expanded ? '' : '-rotate-90'
							}`}
						/>
						<span className="truncate text-xs text-text-muted">
							Showing {summaryBits.join(' · ')}
						</span>
					</button>
					{expanded && (
						<div
							data-testid="task-filter-panel"
							className="px-3 py-3 border-t border-border flex flex-wrap items-end gap-3 bg-bg-subtle"
						>
							<label className="flex flex-col gap-1 flex-1 min-w-0 sm:min-w-[180px]">
								<span className="text-[11px] uppercase tracking-wider text-text-subtle">
									Search
								</span>
								<div className="relative">
									<Search className="w-3.5 h-3.5 text-text-subtle absolute left-2.5 top-1/2 -translate-y-1/2" />
									<input
										type="text"
										value={search}
										onChange={(e) => setSearch(e.target.value)}
										placeholder="Filter by title..."
										data-testid="task-filter-search"
										className="w-full rounded-radius-md border border-border bg-bg pl-8 pr-2.5 py-1.5 text-xs text-text outline-none focus:border-border-hover"
									/>
								</div>
							</label>

							<label className="flex flex-col gap-1">
								<span className="text-[11px] uppercase tracking-wider text-text-subtle">Sort</span>
								<div className="flex gap-1">
									<select
										value={sortField}
										onChange={(e) => handleSortFieldChange(e.target.value as SortField)}
										data-testid="task-filter-sort-field"
										className="rounded-radius-md border border-border bg-bg px-2 py-1.5 text-xs text-text outline-none"
									>
										<option value="created_at">Created</option>
										<option value="updated_at">Updated</option>
									</select>
									<select
										value={sortDir}
										onChange={(e) => handleSortDirChange(e.target.value as SortDir)}
										data-testid="task-filter-sort-dir"
										className="rounded-radius-md border border-border bg-bg px-2 py-1.5 text-xs text-text outline-none"
									>
										<option value="desc">desc</option>
										<option value="asc">asc</option>
									</select>
								</div>
							</label>

							<div className="flex flex-col gap-1">
								<span className="text-[11px] uppercase tracking-wider text-text-subtle">
									Status
								</span>
								<MultiSelect
									label="Status"
									options={statusOptions}
									value={statusValues}
									onChange={handleStatusChange}
									testId="task-filter-status"
								/>
							</div>

							<div className="flex flex-col gap-1">
								<span className="text-[11px] uppercase tracking-wider text-text-subtle">Owner</span>
								<MultiSelect
									label="Owner"
									options={ownerOptions}
									value={ownerValues}
									onChange={handleOwnerChange}
									testId="task-filter-owner"
								/>
							</div>

							<Button
								size="sm"
								variant="ghost"
								onClick={resetFilters}
								data-testid="task-filter-reset"
							>
								Reset
							</Button>
						</div>
					)}
				</div>
				<Button
					size="sm"
					onClick={() => setCreateOpen(true)}
					data-testid="task-list-new-task"
					className="sm:shrink-0"
				>
					<Plus className="w-3.5 h-3.5" />
					New task
				</Button>
			</div>

			{isLoading ? (
				<div className="text-text-muted text-[13px] py-8 text-center">Loading...</div>
			) : tasks.length === 0 ? (
				<EmptyState
					variant="hero"
					icon={<ListPlus className="w-8 h-8" />}
					title="No tasks yet"
					description="Create the first task to get the team moving."
					action={
						<Button
							size="lg"
							onClick={() => setCreateOpen(true)}
							data-testid="task-list-empty-create"
						>
							<Plus className="w-4 h-4" />
							Create your first task
						</Button>
					}
				/>
			) : (
				<DataTable
					columns={columns}
					data={tasks}
					rowKey={(row) => row.id}
					onRowClick={(row) => {
						const rowProjectSlug = row.project_slug ?? projectId;
						if (rowProjectSlug) {
							navigate({
								to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
								params: {
									teamId,
									projectId: rowProjectSlug,
									taskId: row.identifier.toLowerCase(),
								},
							});
						} else {
							navigate({
								to: '/teams/$teamId/tasks/$taskId',
								params: { teamId, taskId: row.identifier.toLowerCase() },
							});
						}
					}}
				/>
			)}

			{result?.meta && result.meta.total > result.meta.per_page && (
				<div className="flex items-center justify-between mt-4 text-xs text-text-muted">
					<span>
						Showing {tasks.length} of {result.meta.total}
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

			<CreateTaskDialog
				teamId={teamId}
				open={createOpen}
				onOpenChange={setCreateOpen}
				defaultProjectId={projectId}
			/>
		</div>
	);
}
