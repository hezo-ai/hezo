import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import {
	type InstanceSettings,
	useInstanceSettings,
	useUpdateInstanceSettings,
} from '../hooks/use-instance-settings';
import { useMe } from '../hooks/use-me';
import type { ApiError } from '../lib/api';
import { Button } from './ui/button';
import { Input } from './ui/input';

export function InstanceSettingsSection() {
	const { data: me } = useMe();
	const { data: settings } = useInstanceSettings();

	return (
		<section>
			<div className="mb-4">
				<h2 className="text-base font-medium">Instance</h2>
				<p className="text-[13px] text-text-2 mt-1">
					Public base URL of this Hezo instance, used to build absolute links to tasks and documents
					in external channels (e.g. Telegram). Captured automatically the first time the instance
					is unlocked.
				</p>
			</div>
			<div className="border border-border rounded-md p-3 bg-surface">
				<label className="block text-[13px] font-medium mb-1.5" htmlFor="instance-base-url-input">
					Base URL
				</label>
				{settings === undefined ? null : me?.is_superuser ? (
					<BaseUrlForm settings={settings} />
				) : (
					<p className="text-[13px] text-text-2" data-testid="instance-base-url-readonly">
						{settings.base_url ?? 'Not configured'}
					</p>
				)}
			</div>
		</section>
	);
}

function BaseUrlForm({ settings }: { settings: InstanceSettings }) {
	const updateSettings = useUpdateInstanceSettings();
	const [baseUrl, setBaseUrl] = useState(settings.base_url ?? '');
	const [error, setError] = useState<string | null>(null);

	async function handleSave() {
		setError(null);
		try {
			const result = await updateSettings.mutateAsync({
				base_url: baseUrl.trim() === '' ? null : baseUrl.trim(),
			});
			// Reflect the server-normalized origin (response-driven, never preempted).
			setBaseUrl(result.base_url ?? '');
		} catch (e) {
			setError((e as ApiError).message);
		}
	}

	const dirty = baseUrl.trim() !== (settings.base_url ?? '');

	return (
		<>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<Input
					id="instance-base-url-input"
					data-testid="instance-base-url-input"
					type="url"
					inputMode="url"
					placeholder="https://hezo.example.com"
					value={baseUrl}
					onChange={(e) => setBaseUrl(e.target.value)}
					className="sm:w-96"
				/>
				<Button
					size="sm"
					data-testid="instance-base-url-save"
					onClick={handleSave}
					disabled={!dirty || updateSettings.isPending}
				>
					{updateSettings.isPending && <Loader2 className="w-3 h-3 animate-spin" />} Save
				</Button>
			</div>
			{error && (
				<p className="text-[13px] text-danger mt-1.5" data-testid="instance-base-url-error">
					{error}
				</p>
			)}
		</>
	);
}
