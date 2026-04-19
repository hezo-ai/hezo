import { createFileRoute } from '@tanstack/react-router';
import { ExternalLink, GitBranch, Loader2, Lock, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { RepoSetupWizard } from '../../../../../../components/repo-setup-wizard';
import { Badge } from '../../../../../../components/ui/badge';
import { Button } from '../../../../../../components/ui/button';
import { Input } from '../../../../../../components/ui/input';
import { Textarea } from '../../../../../../components/ui/textarea';
import { useProject, useUpdateProject } from '../../../../../../hooks/use-projects';
import { useDeleteRepo, useRepos } from '../../../../../../hooks/use-repos';

function ProjectSettingsPage() {
	const { companyId, projectId } = Route.useParams();
	const { data: project } = useProject(companyId, projectId);
	const { data: repos } = useRepos(companyId, projectId);
	const deleteRepo = useDeleteRepo(companyId, projectId);
	const updateProject = useUpdateProject(companyId, projectId);

	const [wizardOpen, setWizardOpen] = useState(false);
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [editing, setEditing] = useState(false);

	if (!project) return null;

	function startEditing() {
		if (!project) return;
		setName(project.name);
		setDescription(project.description ?? '');
		setEditing(true);
	}

	async function handleSave(e: React.FormEvent) {
		e.preventDefault();
		await updateProject.mutateAsync({
			name: name.trim() || undefined,
			description: description.trim(),
		});
		setEditing(false);
	}

	return (
		<div className="space-y-8">
			<section>
				<h2 className="text-sm font-medium text-text-muted mb-3">General</h2>
				{editing ? (
					<form onSubmit={handleSave} className="space-y-3">
						<Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
						<Textarea
							label="Description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							rows={4}
						/>
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
						{project.description && (
							<div>
								<span className="text-text-muted">Description:</span> {project.description}
							</div>
						)}
						<Button variant="ghost" size="sm" onClick={startEditing} className="mt-2">
							Edit
						</Button>
					</div>
				)}
			</section>

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

			<section>
				<div className="flex items-center justify-between mb-3">
					<h2 className="text-sm font-medium text-text-muted flex items-center gap-1.5">
						<GitBranch className="w-4 h-4" /> Repositories
					</h2>
					<Button variant="ghost" size="sm" onClick={() => setWizardOpen(true)}>
						<Plus className="w-3 h-3" /> Add Repo
					</Button>
				</div>
				<p className="text-xs text-text-subtle mb-3">
					The designated repository is where primary source code and per-project{' '}
					<code>AGENTS.md</code> live. It is set on the first repo you link and cannot be changed
					later.
				</p>
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
									{r.is_designated && <Badge color="blue">Designated</Badge>}
								</div>
								{r.is_designated ? (
									<span
										className="text-text-subtle"
										title="Designated repository cannot be removed"
										data-testid={`repo-locked-${r.short_name}`}
									>
										<Lock className="w-3.5 h-3.5" />
									</span>
								) : (
									<button
										type="button"
										onClick={() => deleteRepo.mutate(r.id)}
										className="text-text-subtle hover:text-accent-red"
									>
										<Trash2 className="w-3.5 h-3.5" />
									</button>
								)}
							</div>
						))}
					</div>
				)}
			</section>

			<RepoSetupWizard
				companyId={companyId}
				projectId={projectId}
				open={wizardOpen}
				onOpenChange={setWizardOpen}
			/>
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/projects/$projectId/settings/')({
	component: ProjectSettingsPage,
});
