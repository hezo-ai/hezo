/**
 * The one beat every right-hand side panel opens and closes on.
 *
 * The value the browser animates on is `--panel-motion` in `index.css`; this
 * mirror exists because the timers that keep a closing panel mounted, and that
 * disarm the grid-track transition, need the number in JS. A timer shorter than
 * the animation flickers on every close, so `panel-motion.test.ts` fails if the
 * two ever drift apart.
 */
export const PANEL_MOTION_MS = 300;

/**
 * Timing for a panel that is always mounted and only slides - the two mobile
 * drawers. Pair it with the `transition-*` property utility; a panel that mounts
 * when it opens uses the `.panel-enter` / `.panel-exit` animations instead.
 * MUST stay a literal for Tailwind's JIT.
 */
export const PANEL_MOTION_TRANSITION =
	'duration-[var(--panel-motion)] ease-in-out motion-reduce:transition-none';

/**
 * Enter/exit animation for a panel that mounts when it opens. Below `lg` it
 * travels its full width in from the right edge; from `lg` up the grid track
 * widening beneath it carries the movement, so the panel only fades.
 * MUST stay a literal for Tailwind's JIT.
 */
export const PANEL_MOTION_TRAVEL = '[--panel-travel:100%] lg:[--panel-travel:0px]';
