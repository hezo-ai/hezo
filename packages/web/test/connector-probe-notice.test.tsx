import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { ConnectorProbeNotice } from '../src/components/connector-probe-notice';
import type { Connector } from '../src/hooks/use-connectors';
import { I18nProvider } from '../src/lib/i18n';

/**
 * What a failed probe is told to cost.
 *
 * The regression this pins: the notice said "so agents can't use it yet" for
 * every connector carrying a `probe_error`, including a connected one. That is
 * false for anything credentialed - `SAAS_CREDENTIALED_SQL` hands those rows to
 * a run whatever the last probe said - and it was the group most likely to be
 * reading it, since the scheduled sweep never re-probes a credentialed row and
 * so never clears a stale verdict.
 */
function connector(overrides: Partial<Connector>): Connector {
	return {
		id: 'c-1',
		name: 'typefully',
		display_name: 'typefully',
		kind: 'saas',
		config: { url: 'https://mcp.typefully.com/mcp' },
		oauth_connection_id: null,
		api_key_secret_id: null,
		project_id: 'p-1',
		install_status: 'installed',
		install_error: null,
		skill_id: null,
		created_by_task_id: null,
		created_by_task_identifier: null,
		created_by_task_title: null,
		activated_at: null,
		revoked_at: null,
		auth_error: null,
		probed_at: '2026-08-27T00:00:00Z',
		probe_error: null,
		created_at: '2026-08-01T00:00:00Z',
		updated_at: '2026-08-27T00:00:00Z',
		...overrides,
	} as Connector;
}

function noticeText(c: Connector): string {
	const { container } = render(
		<I18nProvider>
			<ConnectorProbeNotice connector={c} />
		</I18nProvider>,
	);
	return container.textContent ?? '';
}

test('an uncredentialed connector is told the failed check keeps it out of runs', () => {
	// True here, and the reason this notice exists: with no credential, probe
	// evidence is the only thing that lets the row reach a run at all.
	expect(noticeText(connector({ probe_error: 'unreachable' }))).toContain("can't use it yet");
	expect(noticeText(connector({ probe_error: 'auth_required' }))).toContain("can't use it yet");
});

test('a connected connector is not told that agents cannot use it', () => {
	const text = noticeText(
		connector({
			probe_error: 'unreachable',
			oauth_connection_id: 'oc-1',
			activated_at: '2026-08-20T00:00:00Z',
		}),
	);
	expect(text).not.toContain("can't use it yet");
	expect(text).toContain('still receive this connector');
});

test('every credential a run would send counts, including a placeholder header', () => {
	for (const overrides of [
		{ api_key_secret_id: 'sec-1' },
		{ config: { headers: { 'X-Api-Key': '__HEZO_SECRET_TYPEFULLY__' } } },
	]) {
		const text = noticeText(connector({ probe_error: 'auth_required', ...overrides }));
		expect(text).not.toContain("can't use it yet");
	}
});

test('renders nothing when the last check succeeded', () => {
	expect(noticeText(connector({ probe_error: null }))).toBe('');
});
