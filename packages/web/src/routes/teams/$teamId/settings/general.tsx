import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiKeysSection } from '../../../../components/settings/api-keys-section';
import { AutomationsSection } from '../../../../components/settings/automations-section';
import { BudgetSection } from '../../../../components/settings/budget-section';
import { GeneralSection } from '../../../../components/settings/general-section';
import { McpServersSection } from '../../../../components/settings/mcp-section';
import { PreferencesSection } from '../../../../components/settings/preferences-section';
import { SecretsSection } from '../../../../components/settings/secrets-section';
import { SkillFileSection } from '../../../../components/settings/skill-file-section';
import { useTeam } from '../../../../hooks/use-teams';

const settingsNav = [
	{ id: 'general', label: 'General' },
	{ id: 'automations', label: 'Automations' },
	{ id: 'secrets', label: 'Secrets vault' },
	{ id: 'api-keys', label: 'API keys' },
	{ id: 'mcp', label: 'MCP servers' },
	{ id: 'budget', label: 'Budget' },
	{ id: 'preferences', label: 'Preferences' },
	{ id: 'skill-file', label: 'Skill file' },
];

function SettingsPage() {
	const { teamId } = Route.useParams();
	const { data: team } = useTeam(teamId);
	const [activeSection, setActiveSection] = useState('general');

	function scrollTo(id: string) {
		setActiveSection(id);
		document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth' });
	}

	return (
		<div className="flex flex-col gap-4 md:grid md:grid-cols-[160px_1fr] md:gap-6">
			<nav className="flex flex-col gap-0.5 sticky top-0">
				{settingsNav.map((item) => (
					<button
						key={item.id}
						type="button"
						onClick={() => scrollTo(item.id)}
						className={`text-left text-[13px] px-3 py-1.5 rounded-radius-md transition-colors cursor-pointer ${
							activeSection === item.id
								? 'text-text font-medium bg-bg-subtle'
								: 'text-text-muted hover:text-text hover:bg-bg-subtle'
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
					<AutomationsSection teamId={teamId} team={team} />
				</div>
				<div id="settings-secrets">
					<SecretsSection teamId={teamId} />
				</div>
				<div id="settings-api-keys">
					<ApiKeysSection teamId={teamId} />
				</div>
				<div id="settings-mcp">
					<McpServersSection teamId={teamId} />
				</div>
				<div id="settings-budget">
					<BudgetSection teamId={teamId} />
				</div>
				<div id="settings-preferences">
					<PreferencesSection teamId={teamId} />
				</div>
				<div id="settings-skill-file">
					<SkillFileSection />
				</div>
			</div>
		</div>
	);
}

export const Route = createFileRoute('/teams/$teamId/settings/general')({
	component: SettingsPage,
});
