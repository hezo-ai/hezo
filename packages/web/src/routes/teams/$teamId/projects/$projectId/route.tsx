import { createFileRoute, Outlet, useLocation, useParams, useSearch } from '@tanstack/react-router';
import { Breadcrumb } from '../../../../../components/ui/breadcrumb';
import { useIssueAncestors } from '../../../../../hooks/use-issues';
import { useProject } from '../../../../../hooks/use-projects';

const AGENTS_MD_KEY = '__agents_md__';

function ProjectLayout() {
	const { teamId, projectId } = Route.useParams();
	const { data: project } = useProject(teamId, projectId);
	const allParams = useParams({ strict: false }) as { issueId?: string };
	const search = useSearch({ strict: false }) as { file?: string };
	const { pathname } = useLocation();

	const base = `/teams/${teamId}/projects/${projectId}`;
	const onIssueDetail = pathname.startsWith(`${base}/issues`) && Boolean(allParams.issueId);
	const { data: ancestors } = useIssueAncestors(
		teamId,
		onIssueDetail ? allParams.issueId : undefined,
	);
	const projectParams = { teamId, projectId };

	const items: Array<{
		label: string;
		to?: string;
		params?: Record<string, string>;
		key?: string;
	}> = [
		{ label: 'Projects', to: '/teams/$teamId/projects', params: { teamId } },
		{
			label: project?.name ?? projectId,
			to: '/teams/$teamId/projects/$projectId',
			params: projectParams,
		},
	];

	if (pathname.startsWith(`${base}/issues`)) {
		items.push({
			label: 'Issues',
			to: '/teams/$teamId/projects/$projectId/issues',
			params: projectParams,
		});
		if (allParams.issueId) {
			for (const ancestor of ancestors ?? []) {
				items.push({
					key: `ancestor-${ancestor.id}`,
					label: ancestor.identifier.toUpperCase(),
					to: '/teams/$teamId/projects/$projectId/issues/$issueId',
					params: { ...projectParams, issueId: ancestor.identifier },
				});
			}
			items.push({ label: allParams.issueId.toUpperCase() });
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
			<Outlet />
		</div>
	);
}

export const Route = createFileRoute('/teams/$teamId/projects/$projectId')({
	component: ProjectLayout,
});
