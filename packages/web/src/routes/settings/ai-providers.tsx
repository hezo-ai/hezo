import { createFileRoute } from '@tanstack/react-router';
import { AiProvidersSection } from '../../components/ai-providers-section';

function AiProvidersPage() {
	return (
		<div className="max-w-[900px]">
			<AiProvidersSection />
		</div>
	);
}

export const Route = createFileRoute('/settings/ai-providers')({
	component: AiProvidersPage,
});
