import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { AiProvidersSection } from '../../components/ai-providers-section';

function AiProvidersPage() {
	return (
		<div className="max-w-[900px] mx-auto w-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">
			<div className="flex items-center gap-3 mb-6">
				<Link
					to="/companies"
					className="text-text-muted hover:text-text inline-flex items-center gap-1 text-[13px]"
				>
					<ArrowLeft className="w-3.5 h-3.5" /> Back
				</Link>
			</div>
			<AiProvidersSection />
		</div>
	);
}

export const Route = createFileRoute('/settings/ai-providers')({
	component: AiProvidersPage,
});
