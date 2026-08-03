import { createFileRoute, Link } from '@tanstack/react-router';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import {
	ProjectDiskLimitSection,
	ProjectMemoryLimitSection,
} from '../../../components/project-container-limits';
import { useProject } from '../../../hooks/use-projects';
import { useI18n } from '../../../lib/i18n';

/**
 * What *this project's* containers get.
 *
 * Settings only. A project no longer has "a" container - it holds as many as it
 * has concurrent runs - so a page showing one container's status, log and
 * lifecycle buttons was describing whichever one `projects.container_id`
 * happened to name, without being able to say which. All of that moved to the
 * global Containers page, where a container is addressed as itself.
 *
 * What stays is what is genuinely per project: the caps its containers are
 * provisioned with, the image they are built from, the ports they publish, and
 * the one warning an operator must act on.
 */
function ContainerPage() {
	const { t } = useI18n();
	const { projectId } = Route.useParams();
	const { data: project } = useProject(projectId);

	if (!project) return null;

	return (
		<div className="flex flex-col gap-5">
			{/* Committed work that reached no remote - the container is pinned, but
			    the work exists in exactly one place until a later run pushes it. */}
			{project.has_stranded_commits && (
				<div
					data-testid="stranded-commits-warning"
					className="flex gap-2 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm"
				>
					<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
					<div className="flex flex-col gap-1">
						<span className="font-medium">{t('container.strandedCommits.title')}</span>
						<span className="text-xs text-text-2">{t('container.strandedCommits.body')}</span>
					</div>
				</div>
			)}

			<div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
				<div>
					<span className="text-text-2">Image</span>
					<p className="font-mono text-xs mt-0.5">{project.docker_base_image ?? 'none'}</p>
				</div>
				{project.dev_ports?.length > 0 && (
					<div>
						<span className="text-text-2">Dev Ports</span>
						<div className="flex gap-2 flex-wrap mt-0.5">
							{project.dev_ports.map((p) => (
								<a
									key={p.host}
									href={`http://localhost:${p.host}`}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1 font-mono text-xs hover:text-text-1"
								>
									<ExternalLink className="w-3 h-3" />
									{p.container}→{p.host}
								</a>
							))}
						</div>
					</div>
				)}
			</div>

			<ProjectMemoryLimitSection projectId={projectId} />
			<ProjectDiskLimitSection projectId={projectId} />

			{/*
			 * Named rather than left to be discovered: an operator who came here
			 * looking for a container's state or its log needs to be told where both
			 * went, once.
			 */}
			<p className="text-[13px] text-text-2" data-testid="container-page-pointer">
				{t('container.seeAll')}{' '}
				<Link to="/settings/containers" params={{}} className="text-accent hover:underline">
					{t('containers.tab.list')}
				</Link>
				.
			</p>
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId/container')({
	component: ContainerPage,
});
