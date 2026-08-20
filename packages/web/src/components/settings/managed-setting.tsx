import { ExternalLink, Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { useInstanceSettings } from '../../hooks/use-instance-settings';
import { useI18n } from '../../lib/i18n';

/**
 * Rendering for a setting fixed by whoever deployed this instance.
 *
 * **Core never learns any deployment's name.** It renders `managed_by` and links
 * to `manage_url`; it never branches on either. A managed service fills those in,
 * and so does an IT department that fixes limits for a team - the feature is the
 * same one either way.
 *
 * The lock is an affordance, not the enforcement: `PATCH` of a pinned key is
 * refused with a 409 server-side, because whoever runs the instance is still its
 * superuser and can call the API directly. This exists so they find that out
 * before typing rather than after.
 */
export function ManagedSettingNotice({ pinned }: { pinned: boolean }) {
	const { t } = useI18n();
	const { data: settings } = useInstanceSettings();
	const policy = settings?.policy;
	if (!pinned || !policy) return null;

	return (
		<p
			className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[13px] text-text-3"
			data-testid="managed-setting-notice"
		>
			<Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
			<span>{t('settings.managed.by', { managedBy: policy.managed_by })}</span>
			{/* Validated at parse as https:, and again here - React does not reliably
			    block a `javascript:` href, and this string is operator-authored. No
			    query params and no token: the URL lands in access logs and in browser
			    history, and a top-level navigation already carries the session cookie. */}
			{policy.manage_url?.startsWith('https://') && (
				<a
					href={policy.manage_url}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1 text-accent hover:underline"
					data-testid="managed-setting-link"
				>
					{t('settings.managed.manage')}
					<ExternalLink className="h-3 w-3" aria-hidden />
				</a>
			)}
		</p>
	);
}

/**
 * Wraps a control that may be pinned: renders it inert with the notice beneath,
 * rather than each caller reimplementing "disabled plus an explanation".
 *
 * `inert` rather than `disabled` on each input, because a pinned control is a
 * whole block - inputs, save button, reset button - and disabling them one by one
 * is how one gets missed. The value stays visible and selectable, which is the
 * point: an operator needs to read what was fixed even though they cannot change
 * it.
 */
export function ManagedSetting({ pinned, children }: { pinned: boolean; children: ReactNode }) {
	if (!pinned) return <>{children}</>;
	return (
		<div data-testid="managed-setting">
			<div inert className="pointer-events-none opacity-60">
				{children}
			</div>
			<ManagedSettingNotice pinned />
		</div>
	);
}
