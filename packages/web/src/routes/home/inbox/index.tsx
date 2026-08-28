import { createFileRoute } from '@tanstack/react-router';
import { InboxView } from '../../../components/inbox-view';
import { useAllVisibleProjects } from '../../../hooks/use-projects';
import { InboxSortOrder, validateInboxSearch } from '../../../lib/inbox-sort';

function GlobalInboxPage() {
	const { projects } = useAllVisibleProjects();
	const projectSlugs = projects.map((p) => p.slug);
	const { sort = InboxSortOrder.Newest } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<div className="px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">
			<InboxView
				projectSlugs={projectSlugs}
				scope="global"
				sort={sort}
				onSortChange={(next) =>
					navigate({
						// The default is written as absent so it leaves no URL noise.
						search: (prev) => ({
							...prev,
							sort: next === InboxSortOrder.Newest ? undefined : next,
						}),
						replace: true,
					})
				}
			/>
		</div>
	);
}

export const Route = createFileRoute('/home/inbox/')({
	component: GlobalInboxPage,
	validateSearch: validateInboxSearch,
});
