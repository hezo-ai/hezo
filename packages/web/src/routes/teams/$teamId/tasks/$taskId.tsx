import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useTask } from '../../../../hooks/use-tasks';

function TaskShortUrlRedirect() {
	const { teamId, taskId } = Route.useParams();
	const { data: task, isLoading, isError } = useTask(teamId, taskId);

	if (isError)
		return <div className="text-text-muted text-[13px] py-8 text-center">Task not found.</div>;

	if (isLoading || !task || !task.project_slug)
		return <div className="text-text-muted text-[13px] py-8 text-center">Loading...</div>;

	return (
		<Navigate
			to="/teams/$teamId/projects/$projectId/tasks/$taskId"
			params={{
				teamId,
				projectId: task.project_slug,
				taskId: task.identifier.toLowerCase(),
			}}
			hash={typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : undefined}
			replace
		/>
	);
}

export const Route = createFileRoute('/teams/$teamId/tasks/$taskId')({
	component: TaskShortUrlRedirect,
});
