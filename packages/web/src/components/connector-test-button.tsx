import { ConnectorTransport } from '@hezo/shared';
import { RefreshCw } from 'lucide-react';
import {
	type Connector,
	type ConnectorMethodsScope,
	useTestConnector,
} from '../hooks/use-connectors';
import { toast } from '../hooks/use-toast';
import { useI18n } from '../lib/i18n';
import { Button } from './ui/button';

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
 * Hosted servers only. A local (stdio) server has no endpoint to reach and an
 * API connector is called directly by the agent, so neither has anything to
 * hand-shake with; the route refuses both, and offering a button that always
 * fails would be worse than offering none.
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
	if (connector.kind !== ConnectorTransport.Saas) return null;

	const run = () => {
		test.mutate(connector.id, {
			// The note is authored server-side next to the outcomes it describes, so
			// it stays the single wording for a probe result across every surface.
			onSuccess: (result) => {
				const note = result.verdict?.note;
				if (!note) return;
				if (result.verdict?.reachable) toast.success(note);
				else toast.error(note);
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
