import { useEffect, useState } from 'react';
import { readStored, writeStored } from '../lib/safe-storage';

const COLLAPSED_KEY = 'hezo:projectMenuCollapsed';
const CHANGE_EVENT = 'hezo:projectMenuCollapsedChanged';

function readCollapsed(): boolean {
	return readStored(COLLAPSED_KEY) === '1';
}

/**
 * Persist whether the project menu (the panel beside the project rail) is
 * collapsed. Dispatches a window event so every mounted `useProjectMenuCollapsed`
 * updates immediately — the collapse control lives in the menu header and the
 * expand tab beside the rail, which are separate subtrees.
 */
export function setProjectMenuCollapsed(collapsed: boolean): void {
	writeStored(COLLAPSED_KEY, collapsed ? '1' : '0');
	if (typeof window !== 'undefined') {
		window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: collapsed }));
	}
}

/**
 * Reads the persisted collapsed state and stays in sync with it. Returns a
 * `[collapsed, setCollapsed]` tuple mirroring `useState`; the setter persists to
 * localStorage and broadcasts to other readers. Defaults to expanded.
 */
export function useProjectMenuCollapsed(): [boolean, (collapsed: boolean) => void] {
	const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed());

	useEffect(() => {
		const handler = () => setCollapsed(readCollapsed());
		window.addEventListener(CHANGE_EVENT, handler);
		return () => window.removeEventListener(CHANGE_EVENT, handler);
	}, []);

	return [collapsed, setProjectMenuCollapsed];
}
