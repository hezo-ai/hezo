import { createFileRoute } from '@tanstack/react-router';
import { TeamPanel, useHireChooserVisibility } from '../../../../components/team-panel';

/**
 * The Team tab of the Team & Budget page: the roster as an org chart plus the
 * member-card grid. `?hire` opens the hire chooser on arrival - it is how the
 * hire form's back link returns to the fork.
 */
function TeamTab() {
	const { projectId } = Route.useParams();
	const { hire } = Route.useSearch();
	const [hireOpen, setHireOpen] = useHireChooserVisibility(projectId, hire);
	return <TeamPanel projectId={projectId} hireOpen={hireOpen} onHireOpenChange={setHireOpen} />;
}

interface TeamTabSearch {
	/** Open the hire chooser on arrival (the hire form's back link). */
	hire?: boolean;
}

export const Route = createFileRoute('/projects/$projectId/budget/team')({
	validateSearch: (search: Record<string, unknown>): TeamTabSearch => ({
		hire: search.hire === true || search.hire === 'true' ? true : undefined,
	}),
	component: TeamTab,
});
