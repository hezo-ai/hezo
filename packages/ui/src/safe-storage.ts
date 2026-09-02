/**
 * localStorage access that never throws. Reading or writing storage throws in
 * private-browsing modes and when the quota is exceeded; these helpers swallow
 * those failures so storage being unavailable degrades gracefully instead of
 * crashing app initialization.
 */
export function readStored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function writeStored(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// storage unavailable — ignore
	}
}

export function removeStored(key: string): void {
	try {
		localStorage.removeItem(key);
	} catch {
		// storage unavailable — ignore
	}
}
