import type { KeyObject } from 'node:crypto';

export interface KeyEntry {
	keyBlob: Buffer;
	comment: string;
	privateKey: KeyObject;
}

export interface RunIdentity {
	runId: string;
	companyId: string;
	agentId: string;
}

export interface RegistryEntry {
	identity: RunIdentity;
	socketHostPath: string;
	resolveKeys: () => Promise<KeyEntry[]>;
}

export class Registry {
	private entries = new Map<string, RegistryEntry>();

	set(runId: string, entry: RegistryEntry): void {
		this.entries.set(runId, entry);
	}

	get(runId: string): RegistryEntry | undefined {
		return this.entries.get(runId);
	}

	getBySocketPath(path: string): RegistryEntry | undefined {
		for (const entry of this.entries.values()) {
			if (entry.socketHostPath === path) return entry;
		}
		return undefined;
	}

	delete(runId: string): boolean {
		return this.entries.delete(runId);
	}

	all(): RegistryEntry[] {
		return [...this.entries.values()];
	}
}
