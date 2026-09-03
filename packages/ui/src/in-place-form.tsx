import { X } from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { type HeadingLevel, headingTag } from './heading.js';

export interface InPlaceFormProps {
	/** Panel heading, e.g. "Add connector" or "Edit credential". */
	title: string;
	/** Fired by the top-right close button — hide the panel and reset its state. */
	onClose: () => void;
	/** The close button's accessible name. English default; the app passes its own. */
	closeLabel?: string;
	/** When set, children render inside a <form> wired to this handler. */
	onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
	children: ReactNode;
	/**
	 * Rendered inside the panel but outside the <form>, for widgets whose own
	 * buttons must not submit it (e.g. the skill editor's revisions panel).
	 */
	footer?: ReactNode;
	/** The heading rank this panel sits at in the page's outline. */
	headingLevel?: HeadingLevel;
	className?: string;
	'data-testid'?: string;
}

/**
 * In-place add/edit panel toggled by a page-header action (the "+ Add" button
 * pattern on the settings list pages). A filled, rounded card makes the form
 * stand out from the list it edits, and the always-present top-right close
 * button gives every one of these forms the same dismissal affordance.
 * Children are the form fields plus their submit/cancel row.
 */
export function InPlaceForm({
	title,
	onClose,
	closeLabel = 'Close',
	onSubmit,
	children,
	footer,
	headingLevel = 2,
	className = '',
	'data-testid': testId = 'in-place-form',
}: InPlaceFormProps) {
	const Heading = headingTag(headingLevel);
	return (
		<section
			className={`mb-4 rounded-lg border border-border bg-surface-2 p-3 sm:p-4 ${className}`}
			data-testid={testId}
		>
			<div className="mb-3 flex items-center justify-between gap-2">
				<Heading className="text-[13px] font-medium text-text-1">{title}</Heading>
				<button
					type="button"
					onClick={onClose}
					aria-label={closeLabel}
					data-testid="in-place-form-close"
					className="-m-1 p-1 text-text-3 hover:text-text-1 transition-colors"
				>
					<X className="w-4 h-4" aria-hidden />
				</button>
			</div>
			{onSubmit ? (
				<form onSubmit={onSubmit} className="flex flex-col gap-2">
					{children}
				</form>
			) : (
				<div className="flex flex-col gap-2">{children}</div>
			)}
			{footer}
		</section>
	);
}
