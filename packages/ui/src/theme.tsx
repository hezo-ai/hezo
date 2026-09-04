import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useState,
} from 'react';
import { readStored, writeStored } from './safe-storage.js';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeContextValue {
	preference: ThemePreference;
	resolvedTheme: ResolvedTheme;
	setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * A layout effect in a browser, a passive one where there is no window.
 *
 * The theme class has to reach the document element before the browser paints
 * the app's first frame, and only a layout effect guarantees that - but it warns
 * where no effect runs at all.
 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const DARK_QUERY = '(prefers-color-scheme: dark)';

function getSystemTheme(): ResolvedTheme {
	if (typeof window === 'undefined') return 'light';
	return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function readPreference(storageKey: string): ThemePreference {
	if (typeof window === 'undefined') return 'system';
	const stored = readStored(storageKey);
	if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
	return 'system';
}

export interface ThemeProviderProps {
	children: ReactNode;
	/**
	 * Where this app's saved preference lives.
	 *
	 * **Required, because the package owns no key.** A default would be a name
	 * every consumer silently shares: two apps on one origin would fight over one
	 * preference, and an app whose pre-paint script reads a different key would
	 * flash on every load with nothing to say why.
	 */
	storageKey: string;
}

export function ThemeProvider({ children, storageKey }: ThemeProviderProps) {
	// A caller without types, or one passing a value that resolved to nothing,
	// would otherwise store the preference under the text "undefined" and read it
	// back forever - working, and wrong.
	if (!storageKey) {
		throw new Error('ThemeProvider: `storageKey` is required and must be a non-empty string.');
	}

	const [preference, setPreferenceState] = useState<ThemePreference>(() =>
		readPreference(storageKey),
	);
	const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme);

	// Derived rather than held: computed during render, so the effect below has the
	// right value on the first commit rather than one render later, and there is
	// one place that decides what gets applied.
	const resolvedTheme: ResolvedTheme = preference === 'system' ? systemTheme : preference;

	const setPreference = useCallback(
		(next: ThemePreference) => {
			setPreferenceState(next);
			writeStored(storageKey, next);
		},
		[storageKey],
	);

	// Setup applies and cleanup removes, so the class never outlives the provider
	// that owns it - one effect, one invariant, rather than a teardown to keep in
	// step by hand.
	useIsomorphicLayoutEffect(() => {
		const root = document.documentElement;
		root.classList.remove('light', 'dark');
		root.classList.add(resolvedTheme);
		return () => root.classList.remove('light', 'dark');
	}, [resolvedTheme]);

	useEffect(() => {
		if (preference !== 'system') return;
		const mediaQuery = window.matchMedia(DARK_QUERY);
		// Re-read on subscribe: the system may have changed while an explicit
		// preference was active and nothing was listening.
		setSystemTheme(mediaQuery.matches ? 'dark' : 'light');
		const handleChange = () => setSystemTheme(getSystemTheme());
		mediaQuery.addEventListener('change', handleChange);
		return () => mediaQuery.removeEventListener('change', handleChange);
	}, [preference]);

	return (
		<ThemeContext.Provider value={{ preference, resolvedTheme, setPreference }}>
			{children}
		</ThemeContext.Provider>
	);
}

export function useTheme() {
	const context = useContext(ThemeContext);
	if (!context) throw new Error('useTheme must be used within a ThemeProvider');
	return context;
}
