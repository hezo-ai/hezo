import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';

/**
 * Back-link shown at the top of every Settings subpage so it's one tap to
 * return to the main Settings page. The main page itself does not render it.
 */
export function SettingsBreadcrumb({ label }: { label: string }) {
	return (
		<nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-1 text-[13px] text-text-2">
			<Link to="/settings" className="hover:text-text-1 hover:underline transition-colors">
				Settings
			</Link>
			<ChevronRight className="w-3 h-3 shrink-0 text-text-3" />
			<span aria-current="page" className="text-text-1">
				{label}
			</span>
		</nav>
	);
}
