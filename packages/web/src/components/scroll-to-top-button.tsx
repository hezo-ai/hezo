import { ChevronUp } from 'lucide-react';
import { Tooltip } from './ui/tooltip';

/**
 * A thin "jump to top" pill: an upward chevron on the theme's inverse fill,
 * mirroring `ScrollToBottomButton`. Rendered by the app shell over the <main>
 * scroller on every page — `positionClassName` supplies the positioning. Hides
 * itself and leaves the tab order once the content is scrolled to the top (or
 * never overflowed in the first place).
 */
export function ScrollToTopButton({
	onClick,
	atTop,
	testId,
	positionClassName,
}: {
	onClick: () => void;
	atTop: boolean;
	testId: string;
	positionClassName: string;
}) {
	return (
		<Tooltip content="Scroll to top">
			<button
				type="button"
				onClick={onClick}
				data-testid={testId}
				aria-label="Scroll to top"
				aria-hidden={atTop}
				tabIndex={atTop ? -1 : 0}
				className={`flex h-6 items-center justify-center rounded-md bg-inverse px-5 text-inverse-fg shadow-lg transition-opacity hover:opacity-90 ${positionClassName} ${atTop ? 'invisible pointer-events-none opacity-0' : ''}`}
			>
				<ChevronUp className="h-4 w-4" />
			</button>
		</Tooltip>
	);
}
