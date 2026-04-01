import { createFileRoute, Link } from '@tanstack/react-router';
import { ListFilter, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { CreateIssueDialog } from '../../../../components/create-issue-dialog';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { EmptyState } from '../../../../components/ui/empty-state';
import { useAgents } from '../../../../hooks/use-agents';
import { type IssueFilters, useIssues } from '../../../../hooks/use-issues';
import { useProjects } from '../../../../hooks/use-projects';

const statusColors: Record<string, string> = {
	backlog: 'gray',
	open: 'blue',
	in_progress: 'purple',
	review: 'yellow',
	blocked: 'red',
	done: 'green',
	closed: 'gray',
	cancelled: 'gray',
};

const priorityColors: Record<string, string> = {
	urgent: 'red',
	high: 'yellow',
	medium: 'blue',
	low: 'gray',
};

function IssueListPage() {
	const { companyId } = Route.useParams();
	const [filters, setFilters] = useState<IssueFilters>({});
	const [search, setSearch] = useState('');
	const [createOpen, setCreateOpen] = useState(false);
	const [showFilters, setShowFilters] = useState(false);
	const { data: projects } = useProjects(companyId);
	const { data: agents } = useAgents(companyId);

	const activeFilters: IssueFilters = {
		...filters,
		search: search || undefined,
	};
	const { data: result, isLoading } = useIssues(companyId, activeFilters);
	const issues = result?.data ?? [];

	return (
		<div className="p-6">
			<div className="flex items-center justify-between mb-4">
				<h1 className="text-lg font-semibold">Issues</h1>
				<div className="flex gap-2">
					<Button variant="ghost" size="sm" onClick={() => setShowFilters(!showFilters)}>
						<ListFilter className="w-4 h-4" />
					</Button>
					<Button size="sm" onClick={() => setCreateOpen(true)}>
						<Plus className="w-4 h-4" />
						New Issue
					</Button>
				</div>
			</div>

			<div className="flex items-center gap-3 mb-4">
				<div className="relative flex-1 max-w-xs">
					<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-subtle" />
					<input
						placeholder="Search issues..."
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						className="w-full rounded-md border border-border bg-bg-subtle pl-8 pr-3 py-1.5 text-sm text-text placeholder:text-text-subtle outline-none focus:border-primary"
					/>
				</div>
			</div>

			{showFilters && (
				<div className="flex flex-wrap gap-3 mb-4 p-3 rounded-lg border border-border-subtle bg-bg-subtle">
					<select
						value={filters.status ?? ''}
						onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value || undefined }))}
						className="rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text outline-none"
					>
						<option value="">All statuses</option>
						{Object.keys(statusColors).map((s) => (
							<option key={s} value={s}>
								{s.replace('_', ' ')}
							</option>
						))}
					</select>
					<select
						value={filters.priority ?? ''}
						onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value || undefined }))}
						className="rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text outline-none"
					>
						<option value="">All priorities</option>
						{Object.keys(priorityColors).map((p) => (
							<option key={p} value={p}>
								{p}
							</option>
						))}
					</select>
					<select
						value={filters.project_id ?? ''}
						onChange={(e) => setFilters((f) => ({ ...f, project_id: e.target.value || undefined }))}
						className="rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text outline-none"
					>
						<option value="">All projects</option>
						{projects?.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
					<select
						value={filters.assignee_id ?? ''}
						onChange={(e) =>
							setFilters((f) => ({ ...f, assignee_id: e.target.value || undefined }))
						}
						className="rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text outline-none"
					>
						<option value="">All assignees</option>
						{agents?.map((a) => (
							<option key={a.id} value={a.id}>
								{a.title}
							</option>
						))}
					</select>
				</div>
			)}

			{isLoading ? (
				<div className="text-text-muted text-sm py-8 text-center">Loading...</div>
			) : issues.length === 0 ? (
				<EmptyState
					title="No issues"
					description="Create your first issue to get started."
					action={
						<Button size="sm" onClick={() => setCreateOpen(true)}>
							<Plus className="w-4 h-4" />
							New Issue
						</Button>
					}
				/>
			) : (
				<div className="border border-border rounded-lg overflow-hidden">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-border bg-bg-subtle text-text-muted text-left">
								<th className="px-3 py-2 font-medium">ID</th>
								<th className="px-3 py-2 font-medium">Title</th>
								<th className="px-3 py-2 font-medium">Status</th>
								<th className="px-3 py-2 font-medium">Priority</th>
								<th className="px-3 py-2 font-medium">Project</th>
								<th className="px-3 py-2 font-medium">Assignee</th>
							</tr>
						</thead>
						<tbody>
							{issues.map((issue) => (
								<tr
									key={issue.id}
									className="border-b border-border-subtle hover:bg-bg-muted/30 transition-colors"
								>
									<td className="px-3 py-2">
										<Link
											to="/companies/$companyId/issues/$issueId"
											params={{ companyId, issueId: issue.id }}
											className="font-mono text-xs text-primary hover:underline"
										>
											{issue.identifier}
										</Link>
									</td>
									<td className="px-3 py-2">
										<Link
											to="/companies/$companyId/issues/$issueId"
											params={{ companyId, issueId: issue.id }}
											className="text-text hover:text-primary"
										>
											{issue.title}
										</Link>
									</td>
									<td className="px-3 py-2">
										<Badge color={statusColors[issue.status] as 'gray'}>
											{issue.status.replace('_', ' ')}
										</Badge>
									</td>
									<td className="px-3 py-2">
										<Badge color={priorityColors[issue.priority] as 'gray'}>{issue.priority}</Badge>
									</td>
									<td className="px-3 py-2 text-text-muted">{issue.project_name || '—'}</td>
									<td className="px-3 py-2 text-text-muted">{issue.assignee_name || '—'}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{result?.meta && result.meta.total > result.meta.per_page && (
				<div className="flex items-center justify-between mt-4 text-sm text-text-muted">
					<span>
						Showing {issues.length} of {result.meta.total}
					</span>
					<div className="flex gap-2">
						<Button
							variant="ghost"
							size="sm"
							disabled={result.meta.page <= 1}
							onClick={() => setFilters((f) => ({ ...f, page: String(result.meta.page - 1) }))}
						>
							Previous
						</Button>
						<Button
							variant="ghost"
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
