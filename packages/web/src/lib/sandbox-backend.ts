import { SandboxBackend } from '@hezo/shared';
import type { MessageKey } from './i18n';

/**
 * How each backend is named in the UI, in one place.
 *
 * Two surfaces show it - the Storage card and the Concurrency page - and they
 * disagreed: one rendered the literal `'Daytona'` for anything that was not
 * Docker, which would have named the wrong provider the moment a second one
 * existed.
 *
 * Provider names are proper nouns and stay untranslated, so they are literals;
 * the local-daemon wording is a phrase and goes through the catalog. The two are
 * distinguished structurally so neither can be mistaken for the other.
 */
export const BACKEND_NAME: Record<SandboxBackend, { key: MessageKey } | { literal: string }> = {
	[SandboxBackend.Docker]: { key: 'settings.sandboxBackend.docker' },
	[SandboxBackend.Daytona]: { literal: 'Daytona' },
};

/**
 * Resolve a backend's display name, tolerating one this build does not know.
 *
 * A server ahead of the bundle can report a backend the enum has no entry for
 * (an upgrade in flight, a stale cached bundle). Rendering the raw identifier is
 * honest and readable; the alternative - indexing a `Record` and reading a
 * property off `undefined` - takes the whole settings page down over a label.
 */
export function backendDisplayName(
	backend: SandboxBackend,
	t: (key: MessageKey) => string,
): string {
	const named = BACKEND_NAME[backend];
	if (!named) return backend;
	return 'key' in named ? t(named.key) : named.literal;
}
