import { INTERNAL_PROJECT_SLUG } from '@hezo/shared';
import { createFileRoute, Outlet, useLocation, useParams, useSearch } from '@tanstack/react-router';
import { Info } from 'lucide-react';
import { Breadcrumb } from '../../../../../components/ui/breadcrumb';
import { useProject } from '../../../../../hooks/use-projects';
import { useTaskAncestors } from '../../../../../hooks/use-tasks';

const AGENTS_MD_KEY = '__agents_md__';

function ProjectLayout() {
	const { teamId, projectId } = Route.useParams();
	const { data: project } = useProject(teamId, projectId);
	const allParams = useParams({ strict: false }) as { taskId?: string };
	const search = useSearch({ strict: false }) as { file?: string };
	const { pathname } = useLocation();

	const base = `/teams/${teamId}/projects/${projectId}`;
	const onTaskDetail = pathname.startsWith(`${base}/tasks`) && Boolean(allParams.taskId);
	const { data: ancestors } = useTaskAncestors(teamId, onTaskDetail ? allParams.taskId : undefined);
	const projectParams = { teamId, projectId };
	const isInternal = project?.slug === INTERNAL_PROJECT_SLUG;
	const showBanner =
		isInternal && (pathname === `${base}/tasks` || pathname === `${base}/container`);

	const items: Array<{
		label: React.ReactNode;
		to?: string;
		params?: Record<string, string>;
		key?: string;
	}> = [
		{
			label: isInternal ? (
				<span className="italic">{project?.name}</span>
			) : (
				(project?.name ?? projectId)
			),
			to: '/teams/$teamId/projects/$projectId',
			params: projectParams,
		},
	];

	if (pathname.startsWith(`${base}/tasks`)) {
		items.push({
			label: 'Tasks',
			to: '/teams/$teamId/projects/$projectId/tasks',
			params: projectParams,
		});
		if (allParams.taskId) {
			for (const ancestor of ancestors ?? []) {
				items.push({
					key: `ancestor-${ancestor.id}`,
					label: ancestor.identifier.toUpperCase(),
					to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
					params: { ...projectParams, taskId: ancestor.identifier },
				});
			}
			items.push({ label: allParams.taskId.toUpperCase() });
		}
	} else if (pathname.startsWith(`${base}/documents`)) {
		items.push({
			label: 'Documents',
			to: '/teams/$teamId/projects/$projectId/documents',
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
			<Breadcrumb items={items} />
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

export const Route = createFileRoute('/teams/$teamId/projects/$projectId')({
	component: ProjectLayout,
});
