import { createFileRoute, Outlet, useLocation, useParams, useSearch } from '@tanstack/react-router';
import { Info } from 'lucide-react';
import { ContainerStatusBanner } from '../../../components/container-status-banner';
import { Breadcrumb } from '../../../components/ui/breadcrumb';
import { useProjectMeta } from '../../../hooks/use-projects';
import { useTaskAncestors } from '../../../hooks/use-tasks';

const AGENTS_MD_KEY = '__agents_md__';

function ProjectLayout() {
	const { projectId } = Route.useParams();
	const project = useProjectMeta(projectId);
	const allParams = useParams({ strict: false }) as { taskId?: string };
	const search = useSearch({ strict: false }) as { file?: string };
	const { pathname } = useLocation();

	const base = `/projects/${projectId}`;
	const onTaskDetail = pathname.startsWith(`${base}/tasks`) && Boolean(allParams.taskId);
	const { data: ancestors } = useTaskAncestors(
		projectId,
		onTaskDetail ? allParams.taskId : undefined,
	);
	const projectParams = { projectId };
	const isInternal = project?.is_internal ?? false;
	const showBanner =
		isInternal && (pathname === `${base}/tasks` || pathname === `${base}/container`);

	// Breadcrumbs are project-centric: the rail and sidebar already name the
	// active project and its team, so crumbs carry only the in-project section
	// and leaf (e.g. Tasks / OP-42, Documents / spec.md).
	const items: Array<{
		label: React.ReactNode;
		to?: string;
		params?: Record<string, string>;
		key?: string;
	}> = [];

	if (pathname.startsWith(`${base}/tasks`)) {
		items.push({
			label: 'Tasks',
			to: '/projects/$projectId/tasks',
			params: projectParams,
		});
		if (allParams.taskId) {
			for (const ancestor of ancestors ?? []) {
				items.push({
					key: `ancestor-${ancestor.id}`,
					label: ancestor.identifier.toUpperCase(),
					to: '/projects/$projectId/tasks/$taskId',
					params: { ...projectParams, taskId: ancestor.identifier },
				});
			}
			items.push({ label: allParams.taskId.toUpperCase() });
		}
	} else if (pathname.startsWith(`${base}/documents`)) {
		items.push({
			label: 'Documents',
			to: '/projects/$projectId/documents',
			params: projectParams,
		});
		if (search.file) {
			items.push({
				label: search.file === AGENTS_MD_KEY ? 'AGENTS.md' : search.file,
			});
		}
	} else if (pathname.startsWith(`${base}/container`)) {
		items.push({ label: 'Container' });
	} else if (pathname.startsWith(`${base}/settings`)) {
		items.push({ label: 'Settings' });
	}

	return (
		<div>
			<ContainerStatusBanner projectId={projectId} />
			{items.length > 0 && <Breadcrumb items={items} />}
			{showBanner && (
				<div className="flex items-start gap-2 mb-4 px-3 py-2 rounded-radius-md bg-bg-subtle text-text-muted text-[13px]">
					<Info className="w-4 h-4 mt-px shrink-0" aria-hidden="true" />
					<span>
						Internal team coordination project, used for onboarding and team-level changes.
					</span>
				</div>
			)}
			<Outlet />
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId')({
	component: ProjectLayout,
});
