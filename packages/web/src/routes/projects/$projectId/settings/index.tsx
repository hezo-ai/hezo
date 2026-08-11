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
import { Trans, useI18n } from '../../../../lib/i18n';

function ProjectSettingsPage() {
	const { t } = useI18n();
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
	const [editing, setEditing] = useState(false);
	const [archiveOpen, setArchiveOpen] = useState(false);

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
						<div className="flex gap-2">
							<Button type="submit" size="sm" disabled={updateProject.isPending}>
								{updateProject.isPending ? (
									<Loader2 className="w-3 h-3 animate-spin" />
								) : (
									t('common.save')
								)}
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
						{/* Memory per container moved to the project's Container page: it is a
						    property of the containers and only means anything next to their
						    state. Filed here it read as project metadata, between the name and
						    the description. */}
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
					<h2 className="text-sm font-medium text-danger mb-1">
						{t('projectSettings.dangerZone')}
					</h2>
					<p className="text-xs text-text-3 mb-3 max-w-prose">
						<Trans
							k="projectSettings.archive.blurb"
							vars={{
								location: (
									<span className="text-text-2">
										{t('projectSettings.archive.restoreLocation')}
									</span>
								),
							}}
						/>
					</p>
					<Button
						variant="destructive"
						size="sm"
						onClick={() => setArchiveOpen(true)}
						data-testid="archive-project-button"
					>
						{t('projectSettings.archive.action')}
					</Button>
					<ConfirmDialog
						open={archiveOpen}
						onOpenChange={setArchiveOpen}
						title={t('projectSettings.archive.confirmTitle')}
						description={
							<Trans
								k="projectSettings.archive.confirmDescription"
								vars={{ name: <strong>{project.name}</strong> }}
							/>
						}
						confirmLabel={t('projectSettings.archive.confirmAction')}
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
