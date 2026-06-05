import { DEFAULT_TEAM_SLUG } from '@hezo/shared';
import { useEffect, useState } from 'react';

const ACTIVE_TEAM_SLUG_KEY = 'hezo:activeTeamSlug';
const CHANGE_EVENT = 'hezo:activeTeamSlugChanged';

function readStoredTeamSlug(): string | null {
	if (typeof window === 'undefined') return null;
	try {
		return sessionStorage.getItem(ACTIVE_TEAM_SLUG_KEY);
	} catch {
		return null;
	}
}

/**
 * Persists the last team the user selected (rail switch / team creation) so
 * team-agnostic surfaces like /home know which team to default to. Dispatches a
 * window event so any mounted `useActiveTeamSlug` updates immediately.
 */
export function setActiveTeamSlug(slug: string): void {
	if (typeof window === 'undefined') return;
	try {
		sessionStorage.setItem(ACTIVE_TEAM_SLUG_KEY, slug);
	} catch {
		// ignore storage failures (private mode, quota, etc.)
	}
	window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: slug }));
}

export function useActiveTeamSlug(): string {
	const [slug, setSlug] = useState<string>(() => readStoredTeamSlug() ?? DEFAULT_TEAM_SLUG);

	useEffect(() => {
		const handler = () => {
			const stored = readStoredTeamSlug();
			if (stored) setSlug(stored);
		};
		window.addEventListener(CHANGE_EVENT, handler);
		return () => window.removeEventListener(CHANGE_EVENT, handler);
	}, []);

	return slug;
}
