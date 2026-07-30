import { HQ_PROJECT_SLUG } from '@hezo/shared';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { ProjectBudgetPanel } from '../../../../components/budget/project-budget-panel';
import { ProjectIconSection } from '../../../../components/project-icon-section';
import { Button } from '../../../../components/ui/button';
import { ConfirmDialog } from '../../../../components/ui/confirm-dialog';
import { Input } from '../../../../components/ui/input';
import { Textarea } from '../../../../components/ui/textarea';
import { useInstanceSettings } from '../../../../hooks/use-instance-settings';
import { useMe } from '../../../../hooks/use-me';
import { useArchiveProject, useProject, useUpdateProject } from '../../../../hooks/use-projects';
import { useScrollToHash } from '../../../../hooks/use-scroll-to-hash';

function ProjectSettingsPage() {
	const { projectId } = Route.useParams();
	const { data: project } = useProject(projectId);
	const { data: me } = useMe();
	const { data: instanceSettings } = useInstanceSettings();
	const defaultRamCap = instanceSettings?.default_ram_cap_per_container_gb;
	const updateProject = useUpdateProject(projectId);
	const archiveProject = useArchiveProject(projectId);
	const navigate = useNavigate();
	// Deep link from the Budget page's "Edit" button lands on the budget section.
	const budgetSectionRef = useScrollToHash('budget');

	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	// '' = no override: the container inherits the instance-wide ram cap.
	const [memoryLimit, setMemoryLimit] = useState('');
	const [editing, setEditing] = useState(false);
	const [archiveOpen, setArchiveOpen] = useState(false);

	if (!project) return null;

	function startEditing() {
		if (!project) return;
		setName(project.name);
		setDescription(project.description ?? '');
		setMemoryLimit(project.memory_limit_gib === null ? '' : String(project.memory_limit_gib));
		setEditing(true);
	}

	async function handleSave(e: React.FormEvent) {
		e.preventDefault();
		const trimmedMemory = memoryLimit.trim();
		const parsedMemoryLimit = Number(trimmedMemory);
		await updateProject.mutateAsync({
			name: name.trim() || undefined,
			description: description.trim(),
			memory_limit_gib:
				trimmedMemory === ''
					? null
					: Number.isInteger(parsedMemoryLimit) && parsedMemoryLimit >= 1
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
							label="Container memory limit (GiB)"
							type="number"
							min={1}
							className="w-40"
							value={memoryLimit}
							onChange={(e) => setMemoryLimit(e.target.value)}
							placeholder={defaultRamCap ? `Default (${defaultRamCap} GB)` : 'Default'}
							data-testid="memory-limit-gib-input"
						/>
						<p className="text-xs text-text-3 -mt-1">
							Overrides the global RAM cap for this project's container. The container is
							auto-stopped when it exceeds this budget. Leave empty to use the global default from
							Settings → Concurrency.
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
						<div data-testid="memory-limit-gib-value">
							<span className="text-text-2">Container memory limit:</span>{' '}
							{project.memory_limit_gib === null
								? `Default${defaultRamCap ? ` (${defaultRamCap} GB)` : ''}`
								: `${project.memory_limit_gib} GiB`}
						</div>
						<p className="text-xs text-text-3">
							The concurrent-run limit is global - see Settings → Concurrency.
						</p>
						<Button variant="ghost" size="sm" onClick={startEditing} className="mt-2">
							Edit
						</Button>
					</div>
				)}
			</section>

			<ProjectBudgetPanel
				projectId={projectId}
				variant="limits"
				sectionRef={budgetSectionRef}
				sectionId="budget"
			/>

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

			{me?.is_superuser && (
				<section className="border-t border-border pt-6">
					<h2 className="text-sm font-medium text-danger mb-1">Danger zone</h2>
					<p className="text-xs text-text-3 mb-3 max-w-prose">
						Archiving removes this project from the project rail and stops its container. Its tasks
						and history are kept — you can restore it later from{' '}
						<span className="text-text-2">Settings → Archived projects</span>.
					</p>
					<Button
						variant="destructive"
						size="sm"
						onClick={() => setArchiveOpen(true)}
						data-testid="archive-project-button"
					>
						Archive this project
					</Button>
					<ConfirmDialog
						open={archiveOpen}
						onOpenChange={setArchiveOpen}
						title="Archive this project?"
						description={
							<>
								<strong>{project.name}</strong> will be hidden from the project rail and its
								container will be stopped. You can unarchive it later from global Settings.
							</>
						}
						confirmLabel="Archive"
						variant="danger"
						loading={archiveProject.isPending}
						onConfirm={async () => {
							await archiveProject.mutateAsync();
							await navigate({ to: '/' });
						}}
					/>
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
