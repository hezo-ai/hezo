import { ConnectorProbeError, connectorIsCredentialed } from '@hezo/shared';
import type { Connector } from '../hooks/use-connectors';
import { type MessageKey, useI18n } from '../lib/i18n';

/**
 * Why Hezo's last check of this server failed, one line per reason.
 *
 * A table rather than a branch, so a reason added to the enum is a compile
 * error here instead of a connector that silently explains nothing.
 *
 * The second axis is what the failure *costs*, which is not the same question:
 * an uncredentialed hosted connector reaches an agent run only on the evidence
 * of a probe that answered, so a failed check keeps it out; a credentialed one
 * reaches runs on its credential whatever the probe said. Saying "agents can't
 * use it yet" to the second group was simply false, and it was the group most
 * likely to be reading the notice - a connected connector whose server had a
 * bad day, with a `probe_error` no scheduled sweep will ever clear, because the
 * sweep only re-probes uncredentialed rows.
 */
const PROBE_MESSAGE: Record<
	ConnectorProbeError,
	Record<'credentialed' | 'uncredentialed', MessageKey>
> = {
	[ConnectorProbeError.AuthRequired]: {
		uncredentialed: 'connectors.probe.authRequired',
		credentialed: 'connectors.probe.authRequiredCredentialed',
	},
	[ConnectorProbeError.Unreachable]: {
		uncredentialed: 'connectors.probe.unreachable',
		credentialed: 'connectors.probe.unreachableCredentialed',
	},
};

/**
 * The result of Hezo's last check of a hosted MCP server, shown beside the
 * connector's own error.
 *
 * A failed check is why an uncredentialed connector is not reaching agent runs,
 * and without this the operator sees only a Pending badge with no cause. Warning
 * tone rather than danger: a server that wants a credential is a setup step, not
 * a fault.
 */
export function ConnectorProbeNotice({ connector }: { connector: Connector }) {
	const { t } = useI18n();
	if (!connector.probe_error) return null;
	const reach = connectorIsCredentialed(connector) ? 'credentialed' : 'uncredentialed';
	return (
		<p
			className="text-xs text-warning-soft-fg mt-1"
			data-testid={`connector-probe-error-${connector.id}`}
		>
			{t(PROBE_MESSAGE[connector.probe_error][reach])}
		</p>
	);
}
