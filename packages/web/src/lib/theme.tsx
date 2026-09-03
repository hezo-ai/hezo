import { ThemeProvider as UiThemeProvider } from '@hezo/ui';
import type { ReactNode } from 'react';

export { type ResolvedTheme, type ThemePreference, useTheme } from '@hezo/ui';

/**
 * Where this app's saved theme preference lives.
 *
 * **Duplicated in `index.html`, on purpose and under guard.** The pre-paint
 * script has to read the key before any module loads, so it cannot import this;
 * `theme-first-paint.test.tsx` fails if the two ever drift apart.
 */
export const THEME_STORAGE_KEY = 'theme';

/** The shared provider, bound to this app's storage key. */
export function ThemeProvider({ children }: { children: ReactNode }) {
	return <UiThemeProvider storageKey={THEME_STORAGE_KEY}>{children}</UiThemeProvider>;
}
