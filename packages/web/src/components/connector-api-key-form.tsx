import { ExternalLink } from 'lucide-react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { useSetConnectorApiKey } from '../hooks/use-connectors';
import { Button } from './ui/button';

/** A "where to get this key" walkthrough shown above the paste field. */
export interface ApiKeyGuide {
	title: string;
	consoleUrl: string;
	consoleLabel: string;
	steps: string[];
}

/**
 * Provider-specific setup guidance for a static-key `api` connector, keyed off
 * the connector's allowed hosts / base URL (there is no stable provider id on a
 * pasted-key connector). Extend the host checks as more static-key recipes land;
 * an unrecognized host returns undefined and the form shows only its generic
 * vault-safety copy. Google is called out because a YouTube Data API key is the
 * canonical read-only case and its Cloud Console path is otherwise easy to miss.
 */
export function apiKeyGuideFor(
	config: Record<string, unknown> | undefined,
): ApiKeyGuide | undefined {
	const hosts = Array.isArray(config?.allowed_hosts)
		? (config.allowed_hosts as unknown[]).filter((h): h is string => typeof h === 'string')
		: [];
	const baseUrl = typeof config?.base_url === 'string' ? config.base_url : '';
	const targetsGoogle =
		hosts.some((h) => h.includes('googleapis.com')) || baseUrl.includes('googleapis.com');
	if (targetsGoogle) {
		return {
			title: 'How to get a YouTube Data API key',
			consoleUrl: 'https://console.cloud.google.com/apis/credentials',
			consoleLabel: 'Google Cloud Console → Credentials',
			steps: [
				'Pick or create a project in the Google Cloud Console.',
				'Enable the YouTube Data API v3 (APIs & Services → Library).',
				'Open Credentials → Create credentials → API key, then paste it below.',
				'No OAuth consent screen is needed — an API key covers public, read-only data.',
			],
		};
	}
	return undefined;
}

interface Props {
	projectId: string;
	connectorId: string;
	/** Optional "where to get this key" walkthrough rendered above the input. */
	guide?: ApiKeyGuide;
	/** Called after the key is stored and the connector goes active. */
	onSuccess?: () => void;
	/** Called when the user dismisses the form. */
	onCancel?: () => void;
}

/**
 * Paste-an-API-key form for connectors whose provider exposes no OAuth (e.g.
 * Typefully). The key is stored encrypted in the vault; the agent run only ever
 * receives a `__HEZO_SECRET_*__` placeholder. Defaults to `Authorization:
 * Bearer <key>`; the Advanced disclosure overrides the header/scheme for servers
 * that expect e.g. `X-API-Key: <key>`.
 */
export function ConnectorApiKeyForm({ projectId, connectorId, guide, onSuccess, onCancel }: Props) {
	const setApiKey = useSetConnectorApiKey(projectId);
	const [value, setValue] = useState('');
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [header, setHeader] = useState('');
	const [scheme, setScheme] = useState('Bearer ');
	const [error, setError] = useState<string | null>(null);

	const submit = (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		const key = value.trim();
		if (!key) {
			setError('Enter the API key.');
			return;
		}
		const payload: { value: string; header?: string; scheme?: string } = { value: key };
		if (showAdvanced) {
			if (header.trim()) payload.header = header.trim();
			payload.scheme = scheme; // may be '' for a raw-token header
		}
		setApiKey.mutate(
			{ connectorId, payload },
			{
				onSuccess: () => {
					setValue('');
					onSuccess?.();
				},
				onError: (err: unknown) =>
					setError(err instanceof Error ? err.message : 'Failed to save API key'),
			},
		);
	};

	const inputClass =
		'w-full rounded-md border border-border bg-surface-1 px-2.5 py-1.5 text-sm text-text-1';

	return (
		<form onSubmit={submit} className="flex flex-col gap-2" data-testid="connector-api-key-form">
			{guide && (
				<div
					className="rounded-md border border-border bg-surface-2/60 px-3 py-2.5"
					data-testid="connector-api-key-guide"
				>
					<div className="text-xs font-medium text-text-1 mb-1.5">{guide.title}</div>
					<ol className="list-decimal ml-4 space-y-1 text-xs text-text-2 marker:text-text-3">
						{guide.steps.map((step) => (
							<li key={step}>{step}</li>
						))}
					</ol>
					<a
						href={guide.consoleUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
					>
						Open {guide.consoleLabel}
						<ExternalLink className="size-3" />
					</a>
				</div>
			)}
			<input
				type="password"
				autoComplete="off"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				placeholder="Paste API key"
				className={inputClass}
				data-testid="connector-api-key-input"
			/>
			<p className="text-xs text-text-3">
				Stored encrypted in the Hezo vault and sent only to this server at egress. The agent never
				sees the raw key.
			</p>
			{showAdvanced && (
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
					<label className="flex flex-col gap-1 text-xs text-text-2">
						Header
						<input
							value={header}
							onChange={(e) => setHeader(e.target.value)}
							placeholder="Authorization"
							className={`${inputClass} font-mono`}
							data-testid="connector-api-key-header"
						/>
					</label>
					<label className="flex flex-col gap-1 text-xs text-text-2">
						Scheme prefix
						<input
							value={scheme}
							onChange={(e) => setScheme(e.target.value)}
							placeholder="Bearer "
							className={`${inputClass} font-mono`}
							data-testid="connector-api-key-scheme"
						/>
					</label>
				</div>
			)}
			{error && <p className="text-xs text-danger-soft-fg">{error}</p>}
			<div className="flex items-center gap-3">
				<Button
					type="submit"
					size="sm"
					disabled={setApiKey.isPending}
					data-testid="connector-api-key-save"
				>
					{setApiKey.isPending ? 'Saving…' : 'Save key'}
				</Button>
				<button
					type="button"
					className="text-xs text-text-2 hover:text-text-1 underline"
					onClick={() => setShowAdvanced((v) => !v)}
				>
					{showAdvanced ? 'Hide advanced' : 'Advanced'}
				</button>
				{onCancel && (
					<button
						type="button"
						className="ml-auto text-xs text-text-2 hover:text-text-1"
						onClick={onCancel}
					>
						Cancel
					</button>
				)}
			</div>
		</form>
	);
}
