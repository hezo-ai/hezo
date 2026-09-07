/**
 * The semantic tones, and the class pairs each one is drawn with.
 *
 * **One home, so two shapes cannot disagree.** A tone reaches the screen as a
 * pill (`Badge`) and as a block of prose (`Callout`), and a consumer composing a
 * third shape reads the same tables rather than restating the pairs - which is
 * what a second consumer had to do while these were module-private.
 */

/** The semantic tones the design system defines. */
export type Tone =
	| 'neutral'
	| 'accent'
	| 'success'
	| 'warning'
	| 'danger'
	| 'info'
	| 'live'
	| 'purple'
	| 'pink';

/** Variant A "quiet tint" - soft bg + soft fg. The default. */
export const toneTintClassName: Record<Tone, string> = {
	neutral: 'bg-neutral-soft text-neutral-soft-fg',
	accent: 'bg-accent-soft text-accent-soft-fg',
	success: 'bg-success-soft text-success-soft-fg',
	warning: 'bg-warning-soft text-warning-soft-fg',
	danger: 'bg-danger-soft text-danger-soft-fg',
	info: 'bg-info-soft text-info-soft-fg',
	live: 'bg-live-soft text-live-soft-fg',
	purple: 'bg-purple-soft text-purple-soft-fg',
	pink: 'bg-pink-soft text-pink-soft-fg',
};

/** Variant B "solid signal" - solid bg + on-solid fg. */
export const toneSolidClassName: Record<Tone, string> = {
	neutral: 'bg-inverse text-inverse-fg',
	accent: 'bg-accent-solid text-accent-solid-fg',
	success: 'bg-success text-success-solid-fg',
	warning: 'bg-warning text-warning-solid-fg',
	danger: 'bg-danger text-danger-solid-fg',
	info: 'bg-info text-info-solid-fg',
	live: 'bg-live text-live-solid-fg',
	purple: 'bg-purple-soft text-purple-soft-fg',
	pink: 'bg-pink text-pink-fg',
};

/** Dot colour for the "dot + label" variant (the inbox type tag). */
export const toneDotClassName: Record<Tone, string> = {
	neutral: 'bg-text-3',
	accent: 'bg-accent',
	success: 'bg-success',
	warning: 'bg-warning',
	danger: 'bg-danger',
	info: 'bg-info',
	live: 'bg-live',
	purple: 'bg-purple-soft-fg',
	pink: 'bg-pink',
};
