import { useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useProjectsIndex } from './use-projects';

/**
 * Keep a project page on its project across a rename.
 *
 * Renaming a project rewrites its slug, and the server resolves only the
 * current one - there is no slug history - so every request the page makes
 * under the old slug fails from that moment. The projects index refetches
 * after any rename (the settings save invalidates it; a rename made elsewhere
 * reaches it through the team room's `projects` row change), so the page
 * follows the project there: while the route's handle resolves, remember which
 * project it named; once it stops resolving, swap the new slug into the
 * address in place, keeping the rest of the path, the search and the hash.
 *
 * The memory is keyed by the handle, so a typed unknown slug never jumps to the
 * project viewed before it. A project that left the index (archived, deleted)
 * is not followed.
 */
export function useFollowProjectRename(projectId: string): void {
	const { data: projects } = useProjectsIndex();
	const location = useLocation();
	const navigate = useNavigate();
	const knownRef = useRef<{ handle: string; id: string } | null>(null);

	useEffect(() => {
		if (!projects) return;
		const current = projects.find((p) => p.slug === projectId || p.id === projectId);
		if (current) {
			knownRef.current = { handle: projectId, id: current.id };
			return;
		}
		const known = knownRef.current;
		if (known?.handle !== projectId) return;
		const renamed = projects.find((p) => p.id === known.id);
		if (!renamed) return;
		const prefix = `/projects/${encodeURIComponent(projectId)}`;
		if (!location.pathname.startsWith(prefix)) return;
		const pathname = `/projects/${encodeURIComponent(renamed.slug)}${location.pathname.slice(prefix.length)}`;
		navigate({
			href: `${pathname}${location.searchStr}${location.hash ? `#${location.hash}` : ''}`,
			replace: true,
		});
	}, [projects, projectId, location, navigate]);
}
