import { useI18n } from '../lib/i18n';
import { buyHoursHref } from '../lib/manage-href';
import {
	type ManualDispatchResult,
	manualDispatchNoticeKey,
	queuedOnSpentHours,
} from '../lib/manual-dispatch';
import { useInstanceSettings } from './use-instance-settings';
import { useMe } from './use-me';
import { toast } from './use-toast';

/**
 * Announces a manual dispatch that did not start a run. "Run now" and Retry
 * answer with the same outcome, so both announce it through this.
 *
 * **A spent allowance the deployment fixed carries the way to more hours.**
 * There the reset is not the only way out, and the one who can buy is the
 * superuser - the same caller the chat's hours banner links. Everyone else, and
 * every instance nobody manages, gets the notice alone.
 */
export function useManualDispatchNotice(): (data: ManualDispatchResult) => void {
	const { t } = useI18n();
	const { data: settings } = useInstanceSettings();
	const isSuperuser = useMe().data?.is_superuser === true;
	return (data) => {
		const notice = manualDispatchNoticeKey(data);
		if (!notice) return;
		const href = isSuperuser && queuedOnSpentHours(data) ? buyHoursHref(settings) : null;
		toast.info(
			t(notice),
			href ? { link: { label: t('budget.hours.allowance.buy'), href, external: true } } : undefined,
		);
	};
}
