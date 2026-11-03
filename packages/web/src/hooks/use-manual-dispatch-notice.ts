import { useI18n } from '../lib/i18n';
import {
	type ManualDispatchResult,
	manualDispatchNoticeKey,
	queuedOnSpentHours,
} from '../lib/manual-dispatch';
import { useBuyHoursHref } from './use-buy-hours-href';
import { toast } from './use-toast';

/**
 * Announces a manual dispatch that did not start a run. "Run now" and Retry
 * answer with the same outcome, so both announce it through this.
 *
 * **A spent allowance the deployment fixed carries the way to more hours**,
 * there being the one way out other than the reset. Whoever cannot buy, and
 * every instance nobody manages, gets the notice alone.
 */
export function useManualDispatchNotice(): (data: ManualDispatchResult) => void {
	const { t } = useI18n();
	const buyHref = useBuyHoursHref();
	return (data) => {
		const notice = manualDispatchNoticeKey(data);
		if (!notice) return;
		const href = queuedOnSpentHours(data) ? buyHref : null;
		toast.info(
			t(notice),
			href ? { link: { label: t('budget.hours.allowance.buy'), href, external: true } } : undefined,
		);
	};
}
