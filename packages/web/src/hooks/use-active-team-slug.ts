import { DEFAULT_TEAM_SLUG } from '@hezo/shared';
import { useEffect, useState } from 'react';

const ACTIVE_TEAM_SLUG_KEY = 'hezo:activeTeamSlug';

function readStoredTeamSlug(): string | null {
	if (typeof window === 'undefined') return null;
	try {
		return sessionStorage.getItem(ACTIVE_TEAM_SLUG_KEY);
	} catch {
		return null;
	}
}

export function useActiveTeamSlug(): string {
	const [slug, setSlug] = useState<string>(() => readStoredTeamSlug() ?? DEFAULT_TEAM_SLUG);

	useEffect(() => {
		const stored = readStoredTeamSlug();
		if (stored && stored !== slug) setSlug(stored);
	}, [slug]);

	return slug;
}
