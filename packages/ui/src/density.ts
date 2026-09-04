/**
 * The touch-target contract.
 *
 * **Density is the consumer's choice, made once.** Setting
 * `data-density="touch"` on `<html>` gives every stacked control a 44px floor;
 * without it the package keeps this app's desktop density. The attribute goes
 * on `<html>`, not on an app root, so content Radix portals under `<body>`
 * (dialogs, menus, popovers) is covered too. There is no `pointer-coarse`
 * branch and no context: one attribute, read by one Tailwind variant.
 *
 * Two class families implement it, and which one a control takes is decided
 * by whether it stacks against another:
 *
 * - **An isolated control** (a close button, a menu trigger, a switch) takes
 *   `hitAreaClassName` in every density. A centred pseudo-element grows the
 *   target to 44px while the visual stays as drawn.
 * - **A stacked or in-flow control** (a button in a row, an option in a list,
 *   a segment, a field) takes `touchMinHeightClassName`. In a zero-gap stack
 *   the next row's pseudo-element paints over this row's bottom 8px and steals
 *   the tap, so there the floor has to be real height, and only under touch.
 *
 * Every class is a full literal: Tailwind generates a utility only where it
 * reads the whole class string, so a variant prefix is never interpolated.
 */

/** The attribute a consumer sets on `<html>` to choose touch density. */
export const DENSITY_ATTRIBUTE = 'data-density';

/** Its value for touch density: `document.documentElement.dataset.density = TOUCH_DENSITY`. */
export const TOUCH_DENSITY = 'touch';

/**
 * A 44px target for an isolated control, in every density.
 *
 * Pseudo-element only: the host supplies its own `relative` or `absolute`, so
 * a close button that is already positioned takes it unchanged. `w-full` with
 * `min-w-11` gives a wide host a full-width band and a narrow one 44x44.
 * Never put this on a control that stacks against another.
 */
export const hitAreaClassName =
	"after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-full after:min-w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']";

/** A 44px floor for a stacked or in-flow control, only under touch density. */
export const touchMinHeightClassName = 'in-data-[density=touch]:min-h-11';

/**
 * The table-cell form. `min-height` is ignored on a cell by every engine, and
 * a `<tr>` can host neither class; `height` on a cell is a floor the row grows
 * past, so it is the one that works. Applied per `<td>` of a clickable row.
 */
export const touchCellHeightClassName = 'in-data-[density=touch]:h-11';
