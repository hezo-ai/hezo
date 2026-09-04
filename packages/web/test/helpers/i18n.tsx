import { TooltipProvider } from '@hezo/ui';
import type { ReactNode } from 'react';
import { I18nProvider } from '../../src/lib/i18n';

/**
 * Wrap a tree in the contexts the app shell always supplies.
 *
 * `renderApp` already provides these, so this is only for specs that render a
 * component directly with a bare `render()`. Two of them are needed by anything
 * drawn from the shared primitives: the message catalog, because the app's
 * wrappers resolve their label defaults through `t()`, and the tooltip provider,
 * which owns the delay grouping and which `main.tsx` mounts once at the root.
 * Without either, the tree throws rather than degrading.
 *
 * The default locale is English, so assertions on English copy are unaffected.
 */
export function withI18n(ui: ReactNode) {
	return (
		<I18nProvider>
			<TooltipProvider>{ui}</TooltipProvider>
		</I18nProvider>
	);
}
