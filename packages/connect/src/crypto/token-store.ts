import { randomUUID } from 'node:crypto';

const CODE_TTL_MS = 60_000; // 1 minute

export interface StoredToken {
	accessToken: string;
	scopes: string;
	metadata: string;
	platform: string;
}

/**
 * Short-lived store for OAuth tokens keyed by one-time exchange codes.
 * Tokens are stored in memory and expire after 1 minute.
 * Each code can only be consumed once.
 */
export class TokenCodeStore {
	private codes = new Map<string, { token: StoredToken; expiresAt: number }>();

	/** Store a token and return a one-time exchange code. */
	store(token: StoredToken): string {
		this.cleanup();
		const code = randomUUID();
		this.codes.set(code, { token, expiresAt: Date.now() + CODE_TTL_MS });
		return code;
	}

	/** Exchange a code for the stored token. Returns null if expired or already consumed. */
	consume(code: string): StoredToken | null {
		this.cleanup();
		const entry = this.codes.get(code);
		if (!entry) return null;
		this.codes.delete(code);
		return entry.token;
	}

	private cleanup(): void {
		const now = Date.now();
		for (const [code, entry] of this.codes) {
			if (entry.expiresAt < now) this.codes.delete(code);
		}
	}
}
