import { ArrowLeft } from 'lucide-react';

interface BackLinkProps {
	onClick: () => void;
	/** Link text after the arrow. English default; the app passes its own. */
	label?: string;
	className?: string;
}

/**
 * Standard top-left "← Back" affordance for the onboarding / setup screens. A
 * quiet arrow-and-text link rather than a full-width button, so it reads as
 * secondary navigation above the card's centered heading.
 */
export function BackLink({ onClick, label = 'Back', className = '' }: BackLinkProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`inline-flex items-center gap-1 text-[13px] text-text-2 hover:text-text-1 transition-colors ${className}`}
		>
			<ArrowLeft className="w-4 h-4" />
			{label}
		</button>
	);
}
