import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useIssue } from '../../../../hooks/use-issues';

function IssueShortUrlRedirect() {
	const { teamId, issueId } = Route.useParams();
	const { data: issue, isLoading, isError } = useIssue(teamId, issueId);

	if (isError)
		return <div className="text-text-muted text-[13px] py-8 text-center">Issue not found.</div>;

	if (isLoading || !issue || !issue.project_slug)
		return <div className="text-text-muted text-[13px] py-8 text-center">Loading...</div>;

	return (
		<Navigate
			to="/teams/$teamId/projects/$projectId/issues/$issueId"
			params={{
				teamId,
				projectId: issue.project_slug,
				issueId: issue.identifier.toLowerCase(),
			}}
			hash={typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : undefined}
			replace
		/>
	);
}

export const Route = createFileRoute('/teams/$teamId/issues/$issueId')({
	component: IssueShortUrlRedirect,
});
