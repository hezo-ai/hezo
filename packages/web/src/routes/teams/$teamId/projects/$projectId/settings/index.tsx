import { INTERNAL_PROJECT_SLUG } from '@hezo/shared';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { GitHubSection } from '../../../../../../components/github-section';
import { Button } from '../../../../../../components/ui/button';
import { Input } from '../../../../../../components/ui/input';
import { Textarea } from '../../../../../../components/ui/textarea';
import { useProject, useUpdateProject } from '../../../../../../hooks/use-projects';

function ProjectSettingsPage() {
	const { teamId, projectId } = Route.useParams();
	const { data: project } = useProject(teamId, projectId);
	const updateProject = useUpdateProject(teamId, projectId);

	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [maxRuns, setMaxRuns] = useState('1');
	const [editing, setEditing] = useState(false);

	if (!project) return null;

	function startEditing() {
		if (!project) return;
		setName(project.name);
		setDescription(project.description ?? '');
		setMaxRuns(String(project.max_concurrent_runs));
		setEditing(true);
	}

	async function handleSave(e: React.FormEvent) {
		e.preventDefault();
		const parsedMaxRuns = Number(maxRuns);
		await updateProject.mutateAsync({
			name: name.trim() || undefined,
			description: description.trim(),
			max_concurrent_runs:
				Number.isInteger(parsedMaxRuns) && parsedMaxRuns >= 1 ? parsedMaxRuns : undefined,
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
						<Input
							label="Max concurrent runs"
							type="number"
							min={1}
							className="w-28"
							value={maxRuns}
							onChange={(e) => setMaxRuns(e.target.value)}
							data-testid="max-concurrent-runs-input"
						/>
						<p className="text-xs text-text-subtle -mt-1">
							Agents that may run at once in this project. Different agents work different tickets
							in parallel; one ticket still runs a single agent at a time.
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
							<span className="text-text-muted">Name:</span> {project.name}
						</div>
						{project.description && (
							<div>
								<span className="text-text-muted">Description:</span> {project.description}
							</div>
						)}
						<div data-testid="max-concurrent-runs-value">
							<span className="text-text-muted">Max concurrent runs:</span>{' '}
							{project.max_concurrent_runs}
						</div>
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

			<GitHubSection teamId={teamId} projectId={projectId} />
		</div>
	);
}

export const Route = createFileRoute('/teams/$teamId/projects/$projectId/settings/')({
	beforeLoad: ({ params }) => {
		if (params.projectId === INTERNAL_PROJECT_SLUG) {
			throw redirect({
				to: '/teams/$teamId/projects/$projectId/tasks',
				params,
				replace: true,
			});
		}
	},
	component: ProjectSettingsPage,
});
