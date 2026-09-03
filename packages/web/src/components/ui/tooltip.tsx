/**
 * Now ships from `@hezo/ui`.
 *
 * Re-exported from its old path so every call site keeps the import it had.
 * `TooltipProvider` is mounted once in `main.tsx`; a tooltip rendered outside it
 * fails loudly rather than quietly losing its delay grouping.
 */
export { Tooltip, type TooltipProps, TooltipProvider } from '@hezo/ui';
