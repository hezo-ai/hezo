import { createFileRoute } from '@tanstack/react-router';
import { InboxView } from '../../../components/inbox-view';
import { useAllVisibleProjects } from '../../../hooks/use-projects';

function GlobalInboxPage() {
	const { projects } = useAllVisibleProjects();
	const projectSlugs = projects.map((p) => p.slug);
	return (
		<div className="px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">
			<InboxView projectSlugs={projectSlugs} scope="global" />
		</div>
	);
}

export const Route = createFileRoute('/home/inbox/')({
	component: GlobalInboxPage,
});
