import { ChevronDown } from 'lucide-react';
import { Tooltip } from './ui/tooltip';

/**
 * A thin "jump to latest" pill: a downward chevron on the theme's inverse fill
 * (black in light theme, the light inverse in dark theme, matching the CEO chat
 * launcher). Rendered by the app shell over the <main> scroller on every page,
 * and by full-viewport pages (e.g. the standalone document preview) over their
 * own scroller — `positionClassName` supplies the positioning. Hides itself and
 * leaves the tab order once the content is scrolled to the bottom (or never
 * overflowed in the first place).
 */
export function ScrollToBottomButton({
	onClick,
	atBottom,
	testId,
	positionClassName,
}: {
	onClick: () => void;
	atBottom: boolean;
	testId: string;
	positionClassName: string;
}) {
	return (
		<Tooltip content="Scroll to bottom">
			<button
				type="button"
				onClick={onClick}
				data-testid={testId}
				aria-label="Scroll to bottom"
				aria-hidden={atBottom}
				tabIndex={atBottom ? -1 : 0}
				className={`flex h-6 items-center justify-center rounded-md bg-inverse px-5 text-inverse-fg shadow-lg transition-opacity hover:opacity-90 ${positionClassName} ${atBottom ? 'invisible pointer-events-none opacity-0' : ''}`}
			>
				<ChevronDown className="h-4 w-4" />
			</button>
		</Tooltip>
	);
}
