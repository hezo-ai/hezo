import { randomBytes, randomUUID } from 'node:crypto';

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_OUTSTANDING = 1000;

interface ChallengeEntry {
	nonce: string;
	expiresAt: number;
}

/**
 * Single-use login/unlock challenges, in memory. The server is a single
 * process, and a restart locks it anyway — losing outstanding challenges on
 * restart is semantically correct (the client just requests a new one). The
 * nonce is never echoed back by the client: /auth/verify reconstructs the
 * signed message from the stored copy, so the Ed25519 signature is the sole
 * authenticator and no timing-sensitive comparison exists here.
 */
export class AuthChallengeStore {
	private readonly ttlMs: number;
	private readonly maxOutstanding: number;
	private readonly entries = new Map<string, ChallengeEntry>();

	constructor(opts?: { ttlMs?: number; maxOutstanding?: number }) {
		this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
		this.maxOutstanding = opts?.maxOutstanding ?? DEFAULT_MAX_OUTSTANDING;
	}

	issue(): { challengeId: string; nonce: string; expiresInSeconds: number } {
		this.sweep();
		// Bound memory against unauthenticated spam: evict oldest-first (Map
		// preserves insertion order) once the cap is reached.
		while (this.entries.size >= this.maxOutstanding) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
		const challengeId = randomUUID();
		const nonce = randomBytes(32).toString('hex');
		this.entries.set(challengeId, { nonce, expiresAt: Date.now() + this.ttlMs });
		return { challengeId, nonce, expiresInSeconds: Math.floor(this.ttlMs / 1000) };
	}

	/**
	 * Single-use: the entry is deleted on lookup regardless of what the caller
	 * does next, so a failed verification burns the challenge. Returns null for
	 * unknown, already-consumed, or expired ids.
	 */
	consume(challengeId: string): { nonce: string } | null {
		const entry = this.entries.get(challengeId);
		if (!entry) return null;
		this.entries.delete(challengeId);
		if (entry.expiresAt < Date.now()) return null;
		return { nonce: entry.nonce };
	}

	private sweep(): void {
		const now = Date.now();
		for (const [id, entry] of this.entries) {
			if (entry.expiresAt < now) this.entries.delete(id);
		}
	}
}
