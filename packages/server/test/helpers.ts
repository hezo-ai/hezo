import { waitForBackground } from '../src/lib/background';

export async function safeClose(db: { close: () => Promise<void> }) {
	await waitForBackground();
	try {
		await db.close();
	} catch {
		// PGlite 0.2 can throw on close in some environments
	}
}
