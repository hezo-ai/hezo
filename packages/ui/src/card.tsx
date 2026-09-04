import type { HTMLAttributes, ReactNode } from 'react';

/** The elements a card can be drawn as: `section`, `article` or `li` where it is page structure. */
export type CardElement = 'div' | 'section' | 'article' | 'li';

export interface CardProps extends HTMLAttributes<HTMLElement> {
	children: ReactNode;
	/** The element drawn. Defaults to `div`. */
	as?: CardElement;
	/**
	 * Highlight the border under the pointer.
	 *
	 * Defaults to whether an `onClick` is present, since a card that highlights
	 * and does nothing reads as broken. A card wrapped in a link or a button,
	 * where the click lives on the wrapper, says so explicitly.
	 */
	interactive?: boolean;
}

// Wire's `.hz-card`: surface + hairline border + xs elevation, lg radius.
export function Card({
	as: Tag = 'div',
	interactive,
	onClick,
	className = '',
	children,
	...props
}: CardProps) {
	const isInteractive = interactive ?? onClick != null;
	return (
		<Tag
			onClick={onClick}
			className={`rounded-lg border border-border bg-surface p-4 shadow-xs transition-[border-color] duration-150 ${
				isInteractive ? 'hover:border-border-strong' : ''
			} ${className}`}
			{...props}
		>
			{children}
		</Tag>
	);
}
