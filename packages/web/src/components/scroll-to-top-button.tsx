import { ChevronUp } from 'lucide-react';
import { Tooltip } from './ui/tooltip';

/**
 * A thin "jump to top" pill: an upward chevron on the theme's inverse fill,
 * mirroring `ScrollToBottomButton`. Rendered by the app shell over the <main>
 * scroller on every page — `positionClassName` supplies the positioning. Only
 * shown (`visible`) while the user is actively scrolling up; hidden — and out of
 * the tab order — otherwise.
 */
export function ScrollToTopButton({
	onClick,
	visible,
	testId,
	positionClassName,
}: {
	onClick: () => void;
	visible: boolean;
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
				aria-hidden={!visible}
				tabIndex={visible ? 0 : -1}
				className={`flex h-6 items-center justify-center rounded-md bg-inverse px-5 text-inverse-fg shadow-lg transition-opacity hover:opacity-90 ${positionClassName} ${visible ? '' : 'invisible pointer-events-none opacity-0'}`}
			>
				<ChevronUp className="h-4 w-4" />
			</button>
		</Tooltip>
	);
}
