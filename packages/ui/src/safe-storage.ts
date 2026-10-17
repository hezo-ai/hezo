/**
 * Web storage access that never throws. Reading or writing storage throws in
 * private-browsing modes, when the quota is exceeded, and where a browser blocks
 * storage for the page outright (touching `sessionStorage` itself throws there);
 * these helpers swallow those failures so storage being unavailable degrades
 * gracefully instead of crashing app initialization.
 *
 * The plain names are `localStorage`; the `Session` ones are `sessionStorage`,
 * for a value that must end with the browser session.
 */
type StorageArea = 'local' | 'session';

function storage(area: StorageArea): Storage {
	return area === 'session' ? sessionStorage : localStorage;
}

function read(area: StorageArea, key: string): string | null {
	try {
		return storage(area).getItem(key);
	} catch {
		return null;
	}
}

function write(area: StorageArea, key: string, value: string): void {
	try {
		storage(area).setItem(key, value);
	} catch {
		// storage unavailable — ignore
	}
}

function remove(area: StorageArea, key: string): void {
	try {
		storage(area).removeItem(key);
	} catch {
		// storage unavailable — ignore
	}
}

export function readStored(key: string): string | null {
	return read('local', key);
}

export function writeStored(key: string, value: string): void {
	write('local', key, value);
}

export function removeStored(key: string): void {
	remove('local', key);
}

export function readSessionStored(key: string): string | null {
	return read('session', key);
}

export function writeSessionStored(key: string, value: string): void {
	write('session', key, value);
}
