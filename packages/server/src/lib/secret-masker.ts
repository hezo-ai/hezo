/**
 * Masks a run's own secret values out of text the server stores or broadcasts.
 *
 * A run carries a few plaintext values in its process environment: its access
 * token, its egress-proxy password, its signing-bridge token, and the run CLI's
 * model-provider credential. Anything the agent prints - a process list, an
 * `env` dump, a failed request echoing its headers - lands in the run log,
 * which is persisted, broadcast to the web UI and readable by other agents.
 * Every value registered here is replaced with {@link SECRET_MASK} before that.
 *
 * Matching is by exact value. A value the server never saw (a token the CLI
 * refreshed inside the container) cannot be masked, and neither can a fragment
 * of a value that the output itself cut short.
 */

export const SECRET_MASK = '***';

/**
 * Shorter values are not registered: a short string matches ordinary log text
 * far more often than it leaks anything. Every real per-run secret is longer.
 */
const MIN_SECRET_CHARS = 12;

export class SecretMasker {
	/** Longest first, so a value that contains another is replaced whole. */
	private secrets: string[] = [];
	/** Per stream: a tail held back because it may be the start of a secret. */
	private carry = new Map<string, string>();

	/** Register one value. Ignores empty, short and already-registered values. */
	add(value: string | null | undefined): void {
		if (!value || value.length < MIN_SECRET_CHARS || this.secrets.includes(value)) return;
		this.secrets.push(value);
		this.secrets.sort((a, b) => b.length - a.length);
	}

	addAll(values: Iterable<string | null | undefined>): void {
		for (const value of values) this.add(value);
	}

	get size(): number {
		return this.secrets.length;
	}

	/** Replace every registered value in a complete piece of text. */
	mask(text: string): string {
		let out = text;
		for (const secret of this.secrets) {
			if (out.includes(secret)) out = out.split(secret).join(SECRET_MASK);
		}
		return out;
	}

	/**
	 * Mask the next chunk of a stream and return what is safe to emit now.
	 *
	 * A secret can arrive split across two chunks. Only the tail that is itself
	 * the start of a registered value is held back, so a chunk ending in a
	 * newline (which no secret contains) is returned whole. The held tail is
	 * always shorter than the longest value, so the carry is bounded.
	 */
	push(stream: string, chunk: string): string {
		const text = (this.carry.get(stream) ?? '') + chunk;
		if (this.secrets.length === 0) {
			this.carry.delete(stream);
			return text;
		}
		const masked = this.mask(text);
		const held = this.heldTailLength(masked);
		if (held === 0) {
			this.carry.delete(stream);
			return masked;
		}
		this.carry.set(stream, masked.slice(masked.length - held));
		return masked.slice(0, masked.length - held);
	}

	/** Release whatever a stream is holding back, at the end of the stream. */
	flush(stream: string): string {
		const held = this.carry.get(stream) ?? '';
		this.carry.delete(stream);
		return held;
	}

	/** Length of the longest suffix of `text` that is a proper prefix of a secret. */
	private heldTailLength(text: string): number {
		let held = 0;
		for (const secret of this.secrets) {
			const from = Math.max(0, text.length - (secret.length - 1));
			// Scanning left to right, the first hit is this secret's longest tail.
			for (let i = text.indexOf(secret[0], from); i !== -1; i = text.indexOf(secret[0], i + 1)) {
				const tail = text.length - i;
				if (tail <= held) break;
				if (secret.startsWith(text.slice(i))) {
					held = tail;
					break;
				}
			}
		}
		return held;
	}
}

/**
 * Every value a stored credential could put in front of the agent: the stored
 * value itself, and when it is a JSON blob (a subscription's auth file), each
 * string inside it, since the CLI writes those out individually.
 */
export function credentialSecretValues(raw: string): string[] {
	const out = [raw];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return out;
	}
	const walk = (node: unknown): void => {
		if (typeof node === 'string') out.push(node);
		else if (Array.isArray(node)) for (const item of node) walk(item);
		else if (node && typeof node === 'object') for (const item of Object.values(node)) walk(item);
	};
	walk(parsed);
	return out;
}
