import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { AiProvidersSection } from '../../components/ai-providers-section';
import { InfoTooltip } from '../../components/ui/info-tooltip';
import { useMe } from '../../hooks/use-me';

const settingsNav = [{ id: 'ai-providers', label: 'AI providers' }];

// Instance-level resources shared across every team — Admin (superuser) only.
const instanceNav = [
	{ to: '/settings/skills', label: 'Skills' },
	{ to: '/settings/connectors', label: 'Connectors' },
	{ to: '/settings/credentials', label: 'Credentials' },
	{ to: '/settings/audit-log', label: 'Activity' },
] as const;

function GlobalSettingsPage() {
	const { data: me } = useMe();
	const [activeSection, setActiveSection] = useState('ai-providers');

	function scrollTo(id: string) {
		setActiveSection(id);
		document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth' });
	}

	return (
		<div className="max-w-[1000px] w-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">
			<div className="flex items-center gap-1.5 mb-5">
				<h1 className="text-[22px] font-medium">Settings</h1>
				<InfoTooltip
					label="About settings"
					content="AI providers, plus instance-wide resources shared across teams (admin only)."
					data-testid="settings-info"
				/>
			</div>
			<div className="flex flex-col gap-4 md:grid md:grid-cols-[160px_1fr] md:gap-6">
				<nav className="flex flex-col gap-0.5 sticky top-0 md:self-start">
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
					{me?.is_superuser &&
						instanceNav.map((item, idx) => (
							<Link
								key={item.to}
								to={item.to}
								className={`text-left text-[13px] px-3 py-1.5 rounded-radius-md transition-colors text-text-muted hover:text-text hover:bg-bg-subtle ${
									idx === 0 ? 'mt-3' : ''
								}`}
							>
								{item.label}
							</Link>
						))}
				</nav>
				<div className="space-y-8">
					<div id="settings-ai-providers">
						<AiProvidersSection />
					</div>
				</div>
			</div>
		</div>
	);
}

export const Route = createFileRoute('/settings/')({
	component: GlobalSettingsPage,
});
