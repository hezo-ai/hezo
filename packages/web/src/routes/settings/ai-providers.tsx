import { createFileRoute } from '@tanstack/react-router';
import { AiProvidersSection } from '../../components/ai-providers-section';
import { ModelPricingSection } from '../../components/model-pricing-section';

function AiProvidersPage() {
	return (
		<div className="max-w-[900px]">
			<AiProvidersSection />
			<ModelPricingSection />
		</div>
	);
}

export const Route = createFileRoute('/settings/ai-providers')({
	component: AiProvidersPage,
});
