import { buyHoursHref } from '../lib/manage-href';
import { useInstanceSettings } from './use-instance-settings';
import { useMe } from './use-me';

/**
 * Where this viewer can buy more container-hours, or null when they cannot.
 *
 * The superuser only: the allowance is instance-wide and the page buying more
 * belongs to whoever pays for the instance, so anyone else would land on a
 * sign-in they cannot pass. Everyone else is told the wait and who can end it.
 */
export function useBuyHoursHref(): string | null {
	const { data: settings } = useInstanceSettings();
	const isSuperuser = useMe().data?.is_superuser === true;
	return isSuperuser ? buyHoursHref(settings) : null;
}
