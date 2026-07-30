import type { ReactNode } from 'react';
import { I18nProvider } from '../../src/lib/i18n';

/**
 * Wrap a tree in the message-catalog context.
 *
 * `renderApp` already provides this, so it is only for specs that render a
 * component directly with a bare `render()`. Shared UI primitives resolve their
 * label defaults through `t()` (ConfirmDialog's cancel, DialogContent's and
 * InPlaceForm's close, BackLink's label), so any tree containing one needs the
 * provider the app shell always supplies - without it `useI18n` throws.
 *
 * The default locale is English, so assertions on English copy are unaffected.
 */
export function withI18n(ui: ReactNode) {
	return <I18nProvider>{ui}</I18nProvider>;
}
