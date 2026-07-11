import type { FormEvent } from 'react';
import { useState } from 'react';
import { useSetConnectorApiKey } from '../hooks/use-connectors';
import { Button } from './ui/button';

interface Props {
	projectId: string;
	connectorId: string;
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
export function ConnectorApiKeyForm({ projectId, connectorId, onSuccess, onCancel }: Props) {
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
