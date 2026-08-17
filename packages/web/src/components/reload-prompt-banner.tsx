import { RefreshCw } from 'lucide-react';
import { useServerVersionChanged } from '../hooks/use-stale-bundle';
import { Button } from './ui/button';

/**
 * Full-width banner pinned below the nav when the connected server has moved to a
 * newer version than the one this tab loaded (see {@link useServerVersionChanged}).
 * The loaded bundle is then stale and may not render data the newer server pushes,
 * so we prompt a reload — one click loads the current bundle and the display heals.
 * Renders nothing in the common case (server version unchanged this session).
 */
export function ReloadPromptBanner() {
	const stale = useServerVersionChanged();
	if (!stale) return null;

	return (
		<div
			data-testid="reload-prompt-banner"
			className="shrink-0 flex flex-col sm:flex-row sm:items-center gap-2 px-4 py-2.5 text-[13px] bg-info-soft text-info-soft-fg border-b border-border"
		>
			<span className="flex-1">
				Hezo was updated in the background. Refresh to load the latest version - some items may not
				display correctly until you do.
			</span>
			<Button
				type="button"
				variant="primary"
				size="sm"
				data-testid="reload-prompt-refresh"
				onClick={() => window.location.reload()}
			>
				<RefreshCw className="w-3.5 h-3.5" /> Refresh
			</Button>
		</div>
	);
}
