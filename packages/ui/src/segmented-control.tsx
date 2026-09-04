import { useCallback, useEffect, useRef, useState } from 'react';
import { touchMinHeightClassName } from './density.js';
import { segmentedLabelsFit } from './segmented-fit.js';

export interface SegmentedOption<T extends string> {
	value: T;
	label: string;
	icon?: React.ComponentType<{ className?: string }>;
}

export interface SegmentedControlProps<T extends string> {
	options: readonly SegmentedOption<T>[];
	value: T;
	onChange: (value: T) => void;
	/** Accessible name for the group. */
	label: string;
	/**
	 * Drop the text labels when they cannot fit on one line, leaving the icons.
	 * Requires every option to carry an `icon` - there is nothing to fall back to
	 * otherwise. Off by default: a control with room does not need the machinery.
	 */
	collapseToIcons?: boolean;
	className?: string;
	testId?: string;
}

/**
 * A row of mutually exclusive options, each a real button carrying
 * `aria-pressed`. Options share the width evenly.
 *
 * With `collapseToIcons`, the control measures whether its labels fit and hides
 * them when they do not. The measurement is deliberate: the labels come from
 * the active language, so a CSS breakpoint tuned for one catalog clips or
 * over-collapses another (`segmentedLabelsFit` carries the reasoning). A
 * collapsed button is named by `aria-label` rather than by the hidden text, and
 * gains a tooltip for whoever is using a pointer.
 */
export function SegmentedControl<T extends string>({
	options,
	value,
	onChange,
	label,
	collapseToIcons = false,
	className,
	testId,
}: SegmentedControlProps<T>) {
	const ref = useRef<HTMLFieldSetElement>(null);
	const [iconsOnly, setIconsOnly] = useState(false);

	// Read what the labels need, then compare against the space the container
	// offers. Both halves have to be independent of the current state: measuring
	// the labels while forced visible keeps the requirement stable, and taking the
	// width from the parent rather than from this element keeps the space stable -
	// a content-sized fieldset shrinks when its labels hide, which would leave the
	// control latched to icons with no width at which it could ever expand again.
	const measure = useCallback(() => {
		const el = ref.current;
		if (!el) return;
		const buttons = Array.from(el.querySelectorAll<HTMLElement>('[data-seg-button]'));
		const labels = Array.from(el.querySelectorAll<HTMLElement>('[data-seg-label]'));
		if (buttons.length === 0) return;
		const container = el.parentElement;
		if (!container) return;
		const available = container.clientWidth;
		const savedFlex = buttons.map((b) => b.style.flex);
		const savedDisplay = labels.map((l) => l.style.display);
		for (const b of buttons) b.style.flex = '0 0 auto';
		for (const l of labels) l.style.display = 'inline';
		const required = buttons.reduce((sum, b) => sum + b.offsetWidth, 0);
		buttons.forEach((b, i) => {
			b.style.flex = savedFlex[i];
		});
		labels.forEach((l, i) => {
			l.style.display = savedDisplay[i];
		});
		setIconsOnly(!segmentedLabelsFit(required, available));
	}, []);

	// The labels themselves are what the measurement is about, so a language
	// change has to re-run it. Depending on their text (rather than the `options`
	// array, whose identity changes every render) re-measures exactly when the
	// words change and never merely because the parent re-rendered.
	const labelText = options.map((o) => o.label).join(' ');

	// `labelText` is a re-run trigger, not a value the effect reads: `measure`
	// takes the new words off the DOM. Dropping it leaves the control measured
	// against the previous language's labels.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on a language change
	useEffect(() => {
		if (!collapseToIcons) return;
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		const el = ref.current;
		if (!el) return;
		// Observe the container, not the fieldset: this callback changes the
		// fieldset's own width, and an observer watching what it resizes is how a
		// resize loop starts.
		const container = el.parentElement;
		if (!container) return;
		const ro = new ResizeObserver(measure);
		ro.observe(container);
		return () => ro.disconnect();
	}, [collapseToIcons, measure, labelText]);

	return (
		<fieldset
			ref={ref}
			aria-label={label}
			data-testid={testId}
			data-icons-only={collapseToIcons && iconsOnly ? 'true' : undefined}
			// `min-w-0` is load-bearing: a fieldset defaults to
			// `min-inline-size: min-content`, which stops it shrinking inside a narrow
			// rail - the exact case the icons-only fallback exists for.
			className={`flex min-w-0 overflow-hidden rounded-md border border-border p-0 ${className ?? ''}`}
		>
			{options.map(({ value: optionValue, label: optionLabel, icon: Icon }) => {
				const active = optionValue === value;
				return (
					<button
						key={optionValue}
						type="button"
						data-seg-button=""
						aria-pressed={active}
						// Once the label is hidden it leaves the accessibility tree with it, so
						// the name comes from `aria-label`. `title` is the pointer's version of
						// the same thing, and is no use on the touch screens that collapse most.
						aria-label={iconsOnly ? optionLabel : undefined}
						title={iconsOnly ? optionLabel : undefined}
						onClick={() => onChange(optionValue)}
						className={`flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 border-r border-border px-2 py-1.5 text-[11.5px] whitespace-nowrap transition-colors last:border-r-0 ${touchMinHeightClassName} ${
							active
								? 'bg-surface-3 text-text-1 font-semibold'
								: 'bg-surface text-text-2 hover:bg-surface-2 hover:text-text-1'
						}`}
					>
						{Icon && <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden />}
						<span data-seg-label="" className={iconsOnly ? 'hidden' : undefined}>
							{optionLabel}
						</span>
					</button>
				);
			})}
		</fieldset>
	);
}
