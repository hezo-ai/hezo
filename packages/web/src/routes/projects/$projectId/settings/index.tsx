import { HQ_PROJECT_SLUG } from '@hezo/shared';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { ProjectBudgetPanel } from '../../../../components/budget/project-budget-panel';
import { ProjectIconSection } from '../../../../components/project-icon-section';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Textarea } from '../../../../components/ui/textarea';
import { useProject, useUpdateProject } from '../../../../hooks/use-projects';

function ProjectSettingsPage() {
	const { projectId } = Route.useParams();
	const { data: project } = useProject(projectId);
	const updateProject = useUpdateProject(projectId);

	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [maxRuns, setMaxRuns] = useState('1');
	const [memoryLimit, setMemoryLimit] = useState('16');
	const [editing, setEditing] = useState(false);

	if (!project) return null;

	function startEditing() {
		if (!project) return;
		setName(project.name);
		setDescription(project.description ?? '');
		setMaxRuns(String(project.max_concurrent_runs));
		setMemoryLimit(String(project.memory_limit_gib));
		setEditing(true);
	}

	async function handleSave(e: React.FormEvent) {
		e.preventDefault();
		const parsedMaxRuns = Number(maxRuns);
		const parsedMemoryLimit = Number(memoryLimit);
		await updateProject.mutateAsync({
			name: name.trim() || undefined,
			description: description.trim(),
			max_concurrent_runs:
				Number.isInteger(parsedMaxRuns) && parsedMaxRuns >= 1 ? parsedMaxRuns : undefined,
			memory_limit_gib:
				Number.isInteger(parsedMemoryLimit) && parsedMemoryLimit >= 1
					? parsedMemoryLimit
					: undefined,
		});
		setEditing(false);
	}

	return (
		<div className="space-y-8">
			<ProjectIconSection project={project} />

			<section>
				<h2 className="text-sm font-medium text-text-2 mb-3">General</h2>
				{editing ? (
					<form onSubmit={handleSave} className="space-y-3">
						<Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
						<Textarea
							label="Description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							rows={4}
						/>
						<Input
							label="Max concurrent runs"
							type="number"
							min={1}
							className="w-28"
							value={maxRuns}
							onChange={(e) => setMaxRuns(e.target.value)}
							data-testid="max-concurrent-runs-input"
						/>
						<p className="text-xs text-text-3 -mt-1">
							Agents that may run at once in this project. Different agents work different tickets
							in parallel; one ticket still runs a single agent at a time.
						</p>
						<Input
							label="Container memory limit (GiB)"
							type="number"
							min={1}
							className="w-28"
							value={memoryLimit}
							onChange={(e) => setMemoryLimit(e.target.value)}
							data-testid="memory-limit-gib-input"
						/>
						<p className="text-xs text-text-3 -mt-1">
							The container is auto-stopped when it exceeds this RSS budget. Raise it on
							memory-heavy projects; lower it to fail fast on runaway workloads.
						</p>
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
							<span className="text-text-2">Name:</span> {project.name}
						</div>
						{project.description && (
							<div>
								<span className="text-text-2">Description:</span> {project.description}
							</div>
						)}
						<div data-testid="max-concurrent-runs-value">
							<span className="text-text-2">Max concurrent runs:</span>{' '}
							{project.max_concurrent_runs}
						</div>
						<div data-testid="memory-limit-gib-value">
							<span className="text-text-2">Container memory limit:</span>{' '}
							{project.memory_limit_gib} GiB
						</div>
						<Button variant="ghost" size="sm" onClick={startEditing} className="mt-2">
							Edit
						</Button>
					</div>
				)}
			</section>

			<ProjectBudgetPanel projectId={projectId} variant="limits" />

			{project.container_status === 'running' && project.dev_ports?.length > 0 && (
				<section>
					<h2 className="text-sm font-medium text-text-2 mb-2">Dev Preview</h2>
					<div className="flex gap-2 flex-wrap">
						{project.dev_ports.map((p) => (
							<a
								key={p.host}
								href={`http://localhost:${p.host}`}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface px-3 py-1.5 text-sm hover:border-border-strong transition-colors"
							>
								<ExternalLink className="w-3 h-3" />:{p.container} → :{p.host}
							</a>
						))}
					</div>
				</section>
			)}
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId/settings/')({
	beforeLoad: ({ params }) => {
		// Internal projects (slug `internal-<teamSlug>`) have no settings page.
		if (params.projectId === HQ_PROJECT_SLUG) {
			throw redirect({
				to: '/projects/$projectId/tasks',
				params,
				replace: true,
			});
		}
	},
	component: ProjectSettingsPage,
});
