import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { AiProvidersSection } from '../../components/ai-providers-section';

const settingsNav = [{ id: 'ai-providers', label: 'AI providers' }];

function GlobalSettingsPage() {
	const [activeSection, setActiveSection] = useState('ai-providers');

	function scrollTo(id: string) {
		setActiveSection(id);
		document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth' });
	}

	return (
		<div className="max-w-[1000px] mx-auto w-full px-8 py-6">
			<h1 className="text-[22px] font-medium mb-5">Settings</h1>
			<div className="grid grid-cols-[160px_1fr] gap-6">
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
