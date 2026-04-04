import { createFileRoute } from '@tanstack/react-router';
import { ExternalLink, GitBranch, Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../../../../../../components/ui/badge';
import { Button } from '../../../../../../components/ui/button';
import { Input } from '../../../../../../components/ui/input';
import { useProject, useUpdateProject } from '../../../../../../hooks/use-projects';
import { useCreateRepo, useDeleteRepo, useRepos } from '../../../../../../hooks/use-repos';

function ProjectSettingsPage() {
	const { companyId, projectId } = Route.useParams();
	const { data: project } = useProject(companyId, projectId);
	const { data: repos } = useRepos(companyId, projectId);
	const createRepo = useCreateRepo(companyId, projectId);
	const deleteRepo = useDeleteRepo(companyId, projectId);
	const updateProject = useUpdateProject(companyId, projectId);

	const [showRepoForm, setShowRepoForm] = useState(false);
	const [repoName, setRepoName] = useState('');
	const [repoUrl, setRepoUrl] = useState('');
	const [name, setName] = useState('');
	const [goal, setGoal] = useState('');
	const [editing, setEditing] = useState(false);

	if (!project) return null;

	async function handleAddRepo(e: React.FormEvent) {
		e.preventDefault();
		await createRepo.mutateAsync({ short_name: repoName, url: repoUrl });
		setRepoName('');
		setRepoUrl('');
		setShowRepoForm(false);
	}

	function startEditing() {
		if (!project) return;
		setName(project.name);
		setGoal(project.goal ?? '');
		setEditing(true);
	}

	async function handleSave(e: React.FormEvent) {
		e.preventDefault();
		await updateProject.mutateAsync({
			name: name.trim() || undefined,
			goal: goal.trim() || undefined,
		});
		setEditing(false);
	}

	return (
		<div className="space-y-8">
			{/* General */}
			<section>
				<h2 className="text-sm font-medium text-text-muted mb-3">General</h2>
				{editing ? (
					<form onSubmit={handleSave} className="space-y-3">
						<Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
						<Input label="Goal" value={goal} onChange={(e) => setGoal(e.target.value)} />
						<div className="flex gap-2">
							<Button type="submit" size="sm" disabled={updateProject.isPending}>
								{updateProject.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save'}
							</Button>
							<Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
								Cancel
							</Button>
						</div>
					</form>
				) : (
					<div className="space-y-1 text-sm">
						<div>
							<span className="text-text-muted">Name:</span> {project.name}
						</div>
						{project.goal && (
							<div>
								<span className="text-text-muted">Goal:</span> {project.goal}
							</div>
						)}
						<Button variant="ghost" size="sm" onClick={startEditing} className="mt-2">
							Edit
						</Button>
					</div>
				)}
			</section>

			{/* Dev Ports */}
			{project.container_status === 'running' && project.dev_ports?.length > 0 && (
				<section>
					<h2 className="text-sm font-medium text-text-muted mb-2">Dev Preview</h2>
					<div className="flex gap-2 flex-wrap">
						{project.dev_ports.map((p) => (
							<a
								key={p.host}
								href={`http://localhost:${p.host}`}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg px-3 py-1.5 text-sm hover:border-border-hover transition-colors"
							>
								<ExternalLink className="w-3 h-3" />:{p.container} → :{p.host}
							</a>
						))}
					</div>
				</section>
			)}

			{/* Repos */}
			<section>
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
					<p className="text-sm text-accent-red mb-2">
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
									className="text-text-subtle hover:text-accent-red"
								>
									<Trash2 className="w-3.5 h-3.5" />
								</button>
							</div>
						))}
					</div>
				)}
			</section>
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/projects/$projectId/settings/')({
	component: ProjectSettingsPage,
});
