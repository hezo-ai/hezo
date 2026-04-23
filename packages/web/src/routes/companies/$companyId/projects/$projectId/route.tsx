import { createFileRoute, Outlet, useLocation, useParams, useSearch } from '@tanstack/react-router';
import { Breadcrumb } from '../../../../../components/ui/breadcrumb';
import { useProject } from '../../../../../hooks/use-projects';

const AGENTS_MD_KEY = '__agents_md__';

function ProjectLayout() {
	const { companyId, projectId } = Route.useParams();
	const { data: project } = useProject(companyId, projectId);
	const allParams = useParams({ strict: false }) as { issueId?: string };
	const search = useSearch({ strict: false }) as { file?: string };
	const { pathname } = useLocation();

	const base = `/companies/${companyId}/projects/${projectId}`;
	const projectParams = { companyId, projectId };

	const items: Array<{
		label: string;
		to?: string;
		params?: Record<string, string>;
	}> = [
		{ label: 'Projects', to: '/companies/$companyId/projects', params: { companyId } },
		{
			label: project?.name ?? projectId,
			to: '/companies/$companyId/projects/$projectId',
			params: projectParams,
		},
	];

	if (pathname.startsWith(`${base}/issues`)) {
		items.push({
			label: 'Issues',
			to: '/companies/$companyId/projects/$projectId/issues',
			params: projectParams,
		});
		if (allParams.issueId) {
			items.push({ label: allParams.issueId.toUpperCase() });
		}
	} else if (pathname.startsWith(`${base}/documents`)) {
		items.push({
			label: 'Documents',
			to: '/companies/$companyId/projects/$projectId/documents',
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

export const Route = createFileRoute('/companies/$companyId/projects/$projectId')({
	component: ProjectLayout,
});
