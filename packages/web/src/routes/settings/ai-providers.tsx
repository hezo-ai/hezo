import { createFileRoute } from '@tanstack/react-router';
import { AiProvidersSection } from '../../components/ai-providers-section';
import { SettingsBreadcrumb } from '../../components/settings-breadcrumb';

function AiProvidersPage() {
	return (
		<div className="max-w-[900px] w-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">
			<SettingsBreadcrumb label="AI providers" />
			<AiProvidersSection />
		</div>
	);
}

export const Route = createFileRoute('/settings/ai-providers')({
	component: AiProvidersPage,
});
