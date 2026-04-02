import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { CreateIssueDialog } from '../../../../components/create-issue-dialog';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { type Column, DataTable } from '../../../../components/ui/data-table';
import { EmptyState } from '../../../../components/ui/empty-state';
import { FilterPills } from '../../../../components/ui/filter-pills';
import { type IssueFilters, useIssues } from '../../../../hooks/use-issues';

const statusColors: Record<string, string> = {
	backlog: 'neutral',
	open: 'info',
	in_progress: 'warning',
	review: 'purple',
	blocked: 'danger',
	done: 'success',
	closed: 'neutral',
	cancelled: 'neutral',
};

const priorityColors: Record<string, string> = {
	urgent: 'danger',
	high: 'warning',
	medium: 'info',
	low: 'neutral',
};

const statusFilters = [
	{ value: '', label: 'All' },
	{ value: 'open', label: 'Open' },
	{ value: 'in_progress', label: 'In progress' },
	{ value: 'review', label: 'Review' },
	{ value: 'blocked', label: 'Blocked' },
	{ value: 'done', label: 'Done' },
];

interface IssueRow {
	id: string;
	identifier: string;
	title: string;
	status: string;
	priority: string;
	project_name: string | null;
	assignee_name: string | null;
}

function IssueListPage() {
	const { companyId } = Route.useParams();
	const navigate = useNavigate();
	const [filters, setFilters] = useState<IssueFilters>({});
	const [statusFilter, setStatusFilter] = useState('');
	const [createOpen, setCreateOpen] = useState(false);

	const activeFilters: IssueFilters = {
		...filters,
		status: statusFilter || undefined,
	};
	const { data: result, isLoading } = useIssues(companyId, activeFilters);
	const issues = result?.data ?? [];

	const columns: Column<IssueRow>[] = [
		{
			key: 'id',
			header: 'ID',
			width: '72px',
			className: 'font-mono text-text-muted',
			render: (row) => row.identifier,
		},
		{
			key: 'title',
			header: 'Title',
			render: (row) => <span className="font-medium">{row.title}</span>,
		},
		{
			key: 'project',
			header: 'Project',
			width: '100px',
			render: (row) =>
				row.project_name ? (
					<Badge color="info">{row.project_name}</Badge>
				) : (
					<span className="text-text-subtle">—</span>
				),
		},
		{
			key: 'status',
			header: 'Status',
			width: '100px',
			render: (row) => (
				<Badge color={statusColors[row.status] as 'neutral'}>{row.status.replace('_', ' ')}</Badge>
			),
		},
		{
			key: 'priority',
			header: 'Priority',
			width: '80px',
			render: (row) => (
				<Badge color={priorityColors[row.priority] as 'neutral'}>{row.priority}</Badge>
			),
		},
		{
			key: 'assignee',
			header: 'Assignee',
			width: '100px',
			render: (row) => <span className="text-text-muted">{row.assignee_name || '—'}</span>,
		},
	];

	return (
		<div>
			<div className="flex items-center justify-end mb-4">
				<Button onClick={() => setCreateOpen(true)}>
					<Plus className="w-4 h-4" />
					New issue
				</Button>
			</div>

			<FilterPills options={statusFilters} value={statusFilter} onChange={setStatusFilter} />

			{isLoading ? (
				<div className="text-text-muted text-[13px] py-8 text-center">Loading...</div>
			) : issues.length === 0 ? (
				<EmptyState
					title="No issues"
					description="Create your first issue to get started."
					action={
						<Button onClick={() => setCreateOpen(true)}>
							<Plus className="w-4 h-4" />
							New Issue
						</Button>
					}
				/>
			) : (
				<DataTable
					columns={columns}
					data={issues}
					rowKey={(row) => row.id}
					onRowClick={(row) =>
						navigate({
							to: '/companies/$companyId/issues/$issueId',
							params: { companyId, issueId: row.id },
						})
					}
				/>
			)}

			{result?.meta && result.meta.total > result.meta.per_page && (
				<div className="flex items-center justify-between mt-4 text-xs text-text-muted">
					<span>
						Showing {issues.length} of {result.meta.total}
					</span>
					<div className="flex gap-2">
						<Button
							variant="secondary"
							size="sm"
							disabled={result.meta.page <= 1}
							onClick={() => setFilters((f) => ({ ...f, page: String(result.meta.page - 1) }))}
						>
							Previous
						</Button>
						<Button
							variant="secondary"
							size="sm"
							disabled={result.meta.page * result.meta.per_page >= result.meta.total}
							onClick={() => setFilters((f) => ({ ...f, page: String(result.meta.page + 1) }))}
						>
							Next
						</Button>
					</div>
				</div>
			)}

			<CreateIssueDialog companyId={companyId} open={createOpen} onOpenChange={setCreateOpen} />
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/issues/')({
	component: IssueListPage,
});
