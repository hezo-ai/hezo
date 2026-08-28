import { ConnectorProbeError, ConnectorTransport } from '@hezo/shared';
import { RefreshCw } from 'lucide-react';
import {
	type Connector,
	type ConnectorMethodsScope,
	type ConnectorProbeVerdict,
	useTestConnector,
} from '../hooks/use-connectors';
import { toast } from '../hooks/use-toast';
import { useI18n } from '../lib/i18n';
import { Button } from './ui/button';

/**
 * How loudly each probe outcome is reported.
 *
 * Keyed on the outcome itself, never on `reachable`, which conflates two unlike
 * things: an `unverifiable` connector is one that works and that Hezo cannot
 * check from where it stands, and reporting it in red under "Something went
 * wrong" contradicted the last sentence of the note it was carrying.
 *
 * A table so a value added to {@link ConnectorProbeError} is a compile error
 * here rather than a silent demotion to whatever the fallback happened to be.
 */
const REPORT_PROBE: Record<NonNullable<ConnectorProbeVerdict['probe']>, (note: string) => void> = {
	ok: (note) => toast.success(note),
	unverifiable: (note) => toast.info(note),
	[ConnectorProbeError.AuthRequired]: (note) => toast.error(note),
	[ConnectorProbeError.Unreachable]: (note) => toast.error(note),
};

/**
 * Re-check this connector's server now, from the connector card.
 *
 * Every connector, at any time, without opening a disclosure first. Before
 * this, the only probe a human could trigger was the method-list refresh buried
 * in Settings - so a card reading "Connected" under an amber "Hezo couldn't
 * reach this server" notice had no way forward, and the scheduled sweep skips
 * credentialed connectors entirely, meaning that notice could outlive the
 * outage indefinitely.
 *
 * Hosted servers only, and not once revoked. A local (stdio) server has no
 * endpoint to reach, an API connector is called directly by the agent, and a
 * revoked row's credential is already gone - the probe refuses all three, and
 * offering a button that always fails would be worse than offering none.
 */
export function ConnectorTestButton({
	connector,
	scope,
}: {
	connector: Connector;
	/** The project slug the card is rendered under, or null on the admin page. */
	scope: ConnectorMethodsScope;
}) {
	const { t } = useI18n();
	const test = useTestConnector(scope);
	if (connector.kind !== ConnectorTransport.Saas || connector.revoked_at) return null;

	const run = () => {
		test.mutate(connector.id, {
			// The note is authored server-side next to the outcomes it describes, so
			// it stays the single wording for a probe result across every surface.
			onSuccess: ({ verdict }) => {
				if (!verdict?.note) return;
				// A null outcome is a refusal that never reached the server - locked,
				// not connected, gone - so it is a fault, and reported as one.
				const report = verdict.probe ? REPORT_PROBE[verdict.probe] : toast.error;
				report(verdict.note);
			},
			onError: (e) => toast.error((e as Error).message),
		});
	};

	return (
		<Button
			size="sm"
			variant="outline"
			onClick={run}
			disabled={test.isPending}
			data-testid="connector-test"
		>
			<RefreshCw className={`size-3.5 mr-1 ${test.isPending ? 'animate-spin' : ''}`} />
			{test.isPending ? t('connectors.testing') : t('connectors.test')}
		</Button>
	);
}
