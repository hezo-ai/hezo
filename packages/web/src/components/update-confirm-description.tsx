import { Trans, useI18n } from '../lib/i18n';

interface UpdateConfirmDescriptionProps {
	version: string | null;
	runsInFlight?: number;
	autoUnlock: boolean;
}

/** Shared restart contract for every in-app update confirmation. */
export function UpdateConfirmDescription({
	version,
	runsInFlight = 0,
	autoUnlock,
}: UpdateConfirmDescriptionProps) {
	const { t, plural } = useI18n();

	return (
		<>
			<Trans
				k="updates.confirm.restart"
				vars={{ version: <span className="font-medium">{version}</span> }}
			/>{' '}
			{runsInFlight > 0 && <>{plural('updates.confirm.runsInFlight', runsInFlight)} </>}
			{t('updates.confirm.drain')}
			{!autoUnlock && (
				<>
					{' '}
					<span className="font-medium text-text-1">{t('updates.confirm.reunlock')}</span>
				</>
			)}
		</>
	);
}
