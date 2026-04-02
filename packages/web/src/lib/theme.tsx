import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
	preference: ThemePreference;
	resolvedTheme: ResolvedTheme;
	setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'theme';

function getSystemTheme(): ResolvedTheme {
	if (typeof window === 'undefined') return 'light';
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
	if (preference === 'system') return getSystemTheme();
	return preference;
}

function applyTheme(theme: ResolvedTheme) {
	const root = document.documentElement;
	root.classList.remove('light', 'dark');
	root.classList.add(theme);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [preference, setPreferenceState] = useState<ThemePreference>(() => {
		if (typeof window === 'undefined') return 'system';
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
		return 'system';
	});

	const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(preference));

	const setPreference = useCallback((newPreference: ThemePreference) => {
		setPreferenceState(newPreference);
		localStorage.setItem(STORAGE_KEY, newPreference);
	}, []);

	useEffect(() => {
		const resolved = resolveTheme(preference);
		setResolvedTheme(resolved);
		applyTheme(resolved);
	}, [preference]);

	useEffect(() => {
		if (preference !== 'system') return;

		const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
		const handleChange = () => {
			const resolved = getSystemTheme();
			setResolvedTheme(resolved);
			applyTheme(resolved);
		};

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
