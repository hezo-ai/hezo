import { ConnectorProbeError } from '@hezo/shared';
import type { Connector } from '../hooks/use-connectors';
import { type MessageKey, useI18n } from '../lib/i18n';

/**
 * Why Hezo's last check of this server failed, one line per reason.
 *
 * A table rather than a branch, so a reason added to the enum is a compile
 * error here instead of a connector that silently explains nothing.
 */
const PROBE_MESSAGE: Record<ConnectorProbeError, MessageKey> = {
	[ConnectorProbeError.AuthRequired]: 'connectors.probe.authRequired',
	[ConnectorProbeError.Unreachable]: 'connectors.probe.unreachable',
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
	return (
		<p
			className="text-xs text-warning-soft-fg mt-1"
			data-testid={`connector-probe-error-${connector.id}`}
		>
			{t(PROBE_MESSAGE[connector.probe_error])}
		</p>
	);
}
