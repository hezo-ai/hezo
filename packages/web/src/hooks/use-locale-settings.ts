import type { LocaleSettings } from '@hezo/shared';
import { useMutation } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

/**
 * Save the instance locale.
 *
 * The locale is a **global** instance setting, so the server is the source of
 * truth and this is the only write path (the same route the onboarding step
 * uses). Response-driven rather than optimistic: the server validates, and the
 * whole UI re-renders in the new language on success, so there is nothing to
 * gain from preempting it.
 *
 * **Why an unauthorized save is not simply an error.** The locale control is
 * permanently available in the header, including on the pre-auth gates. In two
 * of those states - an initialized instance that is locked after a restart, and
 * the password login screen - there is no session to authorize a global write
 * with. Rather than showing a button that cannot work, an unauthorized save
 * still applies the choice to this browser (the provider's render hint) and
 * reports that it is local-only. Nothing about the global default changes, so
 * the "global only" model holds; the operator just isn't stuck reading a
 * language they don't speak while they sign in.
 */
export type LocaleSaveScope = 'global' | 'browser-only';

export function useSaveLocale() {
	const { applyServerLocale } = useI18n();
	const [scope, setScope] = useState<LocaleSaveScope | null>(null);

	const mutation = useMutation({
		mutationFn: async (locale: LocaleSettings) => {
			const result = await api.patch<{ locale: LocaleSettings; configured: boolean }>(
				'/api/instance-settings/locale',
				locale,
			);
			return result.locale;
		},
		onSuccess: (locale) => {
			setScope('global');
			applyServerLocale(locale);
			// The gate reads `localeConfigured` off /api/status, so the onboarding
			// step advances only once the write has actually landed.
			queryClient.invalidateQueries({ queryKey: queryKeys.status() });
			queryClient.invalidateQueries({ queryKey: queryKeys.instanceSettings() });
		},
	});

	const save = useCallback(
		async (locale: LocaleSettings) => {
			setScope(null);
			try {
				await mutation.mutateAsync(locale);
			} catch (error) {
				const status = error instanceof ApiError ? error.status : 0;
				// 401/403 means "no session on this gate", not "invalid locale" - the
				// shared validator would have produced a 400 for a bad value, which
				// stays a real error.
				if (status === 401 || status === 403) {
					applyServerLocale(locale);
					setScope('browser-only');
					return;
				}
				throw error;
			}
		},
		[mutation, applyServerLocale],
	);

	return {
		save,
		scope,
		isPending: mutation.isPending,
		/** Set only for a genuine failure; an unauthorized save degrades instead. */
		error: mutation.error && scope !== 'browser-only' ? mutation.error : null,
	};
}
