import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft, GitBranch, Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { useIssues } from '../../../../hooks/use-issues';
import { useProject } from '../../../../hooks/use-projects';
import { useCreateRepo, useDeleteRepo, useRepos } from '../../../../hooks/use-repos';

function ProjectDetailPage() {
	const { companyId, projectId } = Route.useParams();
	const { data: project, isLoading } = useProject(companyId, projectId);
	const { data: repos } = useRepos(companyId, projectId);
	const { data: issues } = useIssues(companyId, { project_id: projectId });
	const createRepo = useCreateRepo(companyId, projectId);
	const deleteRepo = useDeleteRepo(companyId, projectId);

	const [showRepoForm, setShowRepoForm] = useState(false);
	const [repoName, setRepoName] = useState('');
	const [repoUrl, setRepoUrl] = useState('');

	if (isLoading || !project) return <div className="p-6 text-text-muted">Loading...</div>;

	async function handleAddRepo(e: React.FormEvent) {
		e.preventDefault();
		await createRepo.mutateAsync({ short_name: repoName, url: repoUrl });
		setRepoName('');
		setRepoUrl('');
		setShowRepoForm(false);
	}

	return (
		<div className="p-6 max-w-3xl">
			<Link
				to="/companies/$companyId/projects"
				params={{ companyId }}
				className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text mb-4"
			>
				<ArrowLeft className="w-3.5 h-3.5" /> Projects
			</Link>

			<h1 className="text-lg font-semibold mb-1">{project.name}</h1>
			{project.goal && <p className="text-sm text-text-muted mb-6">{project.goal}</p>}

			{/* Repos */}
			<div className="mb-8">
				<div className="flex items-center justify-between mb-3">
					<h2 className="text-sm font-medium text-text-muted flex items-center gap-1.5">
						<GitBranch className="w-4 h-4" /> Repositories
					</h2>
					<Button variant="ghost" size="sm" onClick={() => setShowRepoForm(!showRepoForm)}>
						<Plus className="w-3 h-3" /> Add Repo
					</Button>
				</div>
				{showRepoForm && (
					<form onSubmit={handleAddRepo} className="flex gap-2 mb-3">
						<Input
							placeholder="Short name"
							value={repoName}
							onChange={(e) => setRepoName(e.target.value)}
							required
							className="flex-1"
						/>
						<Input
							placeholder="GitHub URL"
							value={repoUrl}
							onChange={(e) => setRepoUrl(e.target.value)}
							required
							className="flex-1"
						/>
						<Button type="submit" size="sm" disabled={createRepo.isPending}>
							{createRepo.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Add'}
						</Button>
					</form>
				)}
				{createRepo.error && (
					<p className="text-sm text-danger mb-2">
						{(createRepo.error as { message: string }).message}
					</p>
				)}
				{repos?.length === 0 ? (
					<p className="text-sm text-text-subtle">No repositories yet.</p>
				) : (
					<div className="flex flex-col gap-2">
						{repos?.map((r) => (
							<div
								key={r.id}
								className="flex items-center justify-between rounded-md border border-border-subtle bg-bg px-3 py-2 text-sm"
							>
								<div className="flex items-center gap-2">
									<Badge color="gray">{r.host_type}</Badge>
									<span className="font-medium">{r.short_name}</span>
									<span className="text-text-muted">{r.repo_identifier}</span>
								</div>
								<button
									type="button"
									onClick={() => deleteRepo.mutate(r.id)}
									className="text-text-subtle hover:text-danger"
								>
									<Trash2 className="w-3.5 h-3.5" />
								</button>
							</div>
						))}
					</div>
				)}
			</div>

			{/* Issues */}
			<div>
				<h2 className="text-sm font-medium text-text-muted mb-3">Issues</h2>
				{issues?.data?.length === 0 ? (
					<p className="text-sm text-text-subtle">No issues for this project.</p>
				) : (
					<div className="flex flex-col gap-1">
						{issues?.data?.map((i) => (
							<Link
								key={i.id}
								to="/companies/$companyId/issues/$issueId"
								params={{ companyId, issueId: i.id }}
								className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-bg-muted/30"
							>
								<span className="font-mono text-xs text-text-muted">{i.identifier}</span>
								<span className="text-text">{i.title}</span>
								<Badge color="gray" className="ml-auto text-[10px]">
									{i.status}
								</Badge>
							</Link>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/projects/$projectId')({
	component: ProjectDetailPage,
});
