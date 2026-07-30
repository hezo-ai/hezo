import { ArrowLeft } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

interface BackLinkProps {
	onClick: () => void;
	/** Link text after the arrow. Defaults to the translated "Back". */
	label?: string;
	className?: string;
}

/**
 * Standard top-left "← Back" affordance for the onboarding / setup screens. A
 * quiet arrow-and-text link rather than a full-width button, so it reads as
 * secondary navigation above the card's centered heading.
 */
export function BackLink({ onClick, label, className = '' }: BackLinkProps) {
	// Defaulted here rather than in the parameter list - a default value cannot
	// call a hook. The prop stays an optional string.
	const { t } = useI18n();
	return (
		<button
			type="button"
			onClick={onClick}
			className={`inline-flex items-center gap-1 text-[13px] text-text-2 hover:text-text-1 transition-colors ${className}`}
		>
			<ArrowLeft className="w-4 h-4" />
			{label ?? t('common.back')}
		</button>
	);
}
