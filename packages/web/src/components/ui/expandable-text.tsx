import { ChevronDown } from 'lucide-react';
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

interface ExpandableTextProps {
	text: string;
	placeholder?: ReactNode;
	className?: string;
}

export function ExpandableText({ text, placeholder, className = '' }: ExpandableTextProps) {
	const [expanded, setExpanded] = useState(false);
	const [overflows, setOverflows] = useState(false);
	const textRef = useRef<HTMLParagraphElement>(null);
	const contentId = useId();

	const hasText = text?.trim().length > 0;

	useLayoutEffect(() => {
		const el = textRef.current;
		if (!el || !text?.trim()) {
			setOverflows(false);
			return;
		}

		const measure = () => {
			const wasClamped = el.classList.contains('line-clamp-1');
			if (!wasClamped) el.classList.add('line-clamp-1');
			const isOverflowing = el.scrollHeight > el.clientHeight + 1;
			if (!wasClamped) el.classList.remove('line-clamp-1');
			setOverflows(isOverflowing);
		};

		measure();

		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [text]);

	useEffect(() => {
		if (!overflows && expanded) setExpanded(false);
	}, [overflows, expanded]);

	if (!hasText) {
		return <div className={className}>{placeholder}</div>;
	}

	const showToggle = overflows;

	return (
		<div className={`flex items-start gap-2 ${className}`}>
			<p
				ref={textRef}
				id={contentId}
				className={`min-w-0 flex-1 whitespace-pre-wrap ${expanded ? '' : 'line-clamp-1'}`}
			>
				{text}
			</p>
			{showToggle && (
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
					aria-controls={contentId}
					aria-label={expanded ? 'Collapse' : 'Expand'}
					className="shrink-0 mt-0.5 text-text-muted hover:text-text"
				>
					<ChevronDown className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
				</button>
			)}
		</div>
	);
}
