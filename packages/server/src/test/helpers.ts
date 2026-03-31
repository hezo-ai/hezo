export async function safeClose(db: { close: () => Promise<void> }) {
	try {
		await db.close();
	} catch {
		// PGlite 0.2 can throw on close in some environments
	}
}
