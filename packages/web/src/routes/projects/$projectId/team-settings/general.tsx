import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { ApplyTypeSection } from '../../../../components/settings/apply-type-section';
import { AutomationsSection } from '../../../../components/settings/automations-section';
import { BudgetSection } from '../../../../components/settings/budget-section';
import { GeneralSection } from '../../../../components/settings/general-section';
import { PreferencesSection } from '../../../../components/settings/preferences-section';
import { SaveAsTypeSection } from '../../../../components/settings/save-as-type-section';
import { SkillFileSection } from '../../../../components/settings/skill-file-section';
import { useMe } from '../../../../hooks/use-me';
import { useTeam } from '../../../../hooks/use-teams';

const settingsNav = [
	{ id: 'general', label: 'General' },
	{ id: 'automations', label: 'Automations' },
	{ id: 'budget', label: 'Budget' },
	{ id: 'preferences', label: 'Preferences' },
	{ id: 'skill-file', label: 'Skill file' },
	{ id: 'save-as-type', label: 'Save as type' },
	{ id: 'apply-type', label: 'Refresh from type' },
];

function SettingsPage() {
	const { projectId } = Route.useParams();
	const { data: team } = useTeam(projectId);
	const { data: me } = useMe();
	const [activeSection, setActiveSection] = useState('general');
	const nav = me?.is_superuser
		? settingsNav
		: settingsNav.filter((item) => item.id !== 'save-as-type' && item.id !== 'apply-type');

	function scrollTo(id: string) {
		setActiveSection(id);
		document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth' });
	}

	return (
		<div className="flex flex-col gap-4 md:grid md:grid-cols-[160px_1fr] md:gap-6">
			<nav className="flex flex-col gap-0.5 sticky top-0 md:self-start">
				{nav.map((item) => (
					<button
						key={item.id}
						type="button"
						onClick={() => scrollTo(item.id)}
						className={`text-left text-[13px] px-3 py-1.5 rounded-md transition-colors cursor-pointer ${
							activeSection === item.id
								? 'text-text-1 font-medium bg-surface-2'
								: 'text-text-2 hover:text-text-1 hover:bg-surface-2'
						}`}
					>
						{item.label}
					</button>
				))}
			</nav>

			<div className="space-y-8">
				<div id="settings-general">
					<GeneralSection team={team} />
				</div>
				<div id="settings-automations">
					<AutomationsSection projectId={projectId} team={team} />
				</div>
				<div id="settings-budget">
					<BudgetSection projectId={projectId} />
				</div>
				<div id="settings-preferences">
					<PreferencesSection projectId={projectId} />
				</div>
				<div id="settings-skill-file">
					<SkillFileSection />
				</div>
				<div id="settings-save-as-type">
					<SaveAsTypeSection projectId={projectId} />
				</div>
				<div id="settings-apply-type">
					<ApplyTypeSection projectId={projectId} />
				</div>
			</div>
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId/team-settings/general')({
	component: SettingsPage,
});
