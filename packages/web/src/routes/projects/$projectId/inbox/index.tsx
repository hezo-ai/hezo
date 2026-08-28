import { createFileRoute } from '@tanstack/react-router';
import { InboxView } from '../../../../components/inbox-view';
import { InboxSortOrder, validateInboxSearch } from '../../../../lib/inbox-sort';

function InboxPage() {
	const { projectId } = Route.useParams();
	const { sort = InboxSortOrder.Newest } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<InboxView
			projectSlugs={[projectId]}
			scope="team"
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
	);
}

export const Route = createFileRoute('/projects/$projectId/inbox/')({
	component: InboxPage,
	validateSearch: validateInboxSearch,
});
