import {
	type AgentRuntime,
	AI_PROVIDER_INFO,
	AiAuthMethod,
	AiProvider,
	providerHasGuidedSignIn,
} from '@hezo/shared';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
	type AiProviderConfig,
	useAiProviders,
	useCreateAiProvider,
	useUpdateAiProviderConfig,
} from '../hooks/use-ai-providers';
import { useI18n } from '../lib/i18n';
import { AgentCliPicker, providerHasCliChoice } from './agent-cli-picker';
import { ApiKeyInstructions } from './api-key-instructions';
import { SubscriptionLoginPanel } from './subscription-login-panel';
import { SUBSCRIPTION_INSTRUCTIONS, SubscriptionInstructions } from './subscription-paste-form';
import { Button } from './ui/button';
import { Input } from './ui/input';

// Display order mirrors the catalogue order used elsewhere in the app. Shared by
// every surface that renders the provider card grid (onboarding + settings), so
// a provider missing here is unreachable in the UI even though the API accepts
// it — keep it in sync with the AiProvider enum.
//
// Hosted providers first, then the self-hosted runners, which are a different
// kind of choice: the operator supplies a server URL instead of a key.
export const ADD_PROVIDER_ORDER: readonly AiProvider[] = [
	AiProvider.DeepSeek,
	AiProvider.ZAi,
	AiProvider.Anthropic,
	AiProvider.OpenAI,
	AiProvider.Google,
	AiProvider.Kimi,
	AiProvider.XAi,
	AiProvider.OpenRouter,
	AiProvider.Ollama,
	AiProvider.LmStudio,
];

/**
 * Warn when a local provider's server URL points at loopback. Agents run inside
 * a container, where `localhost` is the container itself rather than the host
 * running the model server, so this is the most likely way to configure a local
 * provider that verifies fine from the browser and then fails at run time.
 * Returns null when the host is fine (including `host.docker.internal`, which
 * the runner already exempts from the egress proxy).
 */
export function loopbackHostWarning(rawUrl: string): string | null {
	let host: string;
	try {
		host = new URL(rawUrl).hostname.toLowerCase();
	} catch {
		return null; // Not a URL yet - the server validates on submit.
	}
	const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
	if (!isLoopback) return null;
	return "Agents run in a container, where this address means the container itself. Use host.docker.internal to reach a server on this machine, or the machine's LAN address.";
}

/**
 * Friendly default name for a new config, skipping labels already used for that
 * provider so the `UNIQUE(provider, label)` constraint never trips on the
 * suggested default.
 */
export function defaultLabel(
	provider: AiProvider,
	configs: AiProviderConfig[] | undefined,
): string {
	const info = AI_PROVIDER_INFO[provider];
	const used = new Set((configs ?? []).filter((c) => c.provider === provider).map((c) => c.label));
	if (!used.has(info.name)) return info.name;
	let n = 2;
	while (used.has(`${info.name} ${n}`)) n++;
	return `${info.name} ${n}`;
}

/** Read the stored server URL off a config's metadata, if it has one. */
function storedBaseUrl(config: AiProviderConfig): string | null {
	const raw = config.metadata?.base_url;
	return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

interface ProviderConfigFormProps {
	provider: AiProvider;
	/** Called after the credential is successfully created or saved. */
	onDone: () => void;
	/** Called when the user cancels out of the form. */
	onCancel: () => void;
	/** Show an editable, auto-prefilled name field (settings flow). */
	showName?: boolean;
	/** Submit-button label. */
	submitLabel?: string;
	/**
	 * Edit this existing config instead of creating a new one. Every field is
	 * seeded from it except the credential, which stays blank and means "keep the
	 * stored one" — so a rename never requires re-pasting a key.
	 */
	editing?: AiProviderConfig;
}

/**
 * The provider credential form, shared by the onboarding picker, the settings
 * "Add provider" modal and the settings "Edit provider" modal. Renders only the
 * inputs the selected provider supports — an API key, or (where available) a
 * runtime-subscription paste — plus an optional name field. Owns no surrounding
 * chrome (heading, stepper, back affordance); the caller supplies that so the
 * same form works in both an onboarding page and a modal. Mount with a
 * `key={provider}` (or `key={config.id}`) so switching subject resets the
 * in-progress credential.
 */
export function ProviderConfigForm({
	provider,
	onDone,
	onCancel,
	showName = false,
	submitLabel = 'Add provider',
	editing,
}: ProviderConfigFormProps) {
	const { t } = useI18n();
	const { data: configs } = useAiProviders();
	const createProvider = useCreateAiProvider();
	const updateProvider = useUpdateAiProviderConfig(editing?.id ?? '');
	const info = AI_PROVIDER_INFO[provider];

	const [authMethod, setAuthMethod] = useState<AiAuthMethod>(
		(editing?.auth_method as AiAuthMethod) ?? AiAuthMethod.ApiKey,
	);
	const [name, setName] = useState(() => editing?.label ?? defaultLabel(provider, configs));
	const [nameEdited, setNameEdited] = useState(false);
	const [apiKey, setApiKey] = useState('');
	const [authJson, setAuthJson] = useState('');
	const [baseUrl, setBaseUrl] = useState(
		() => (editing && storedBaseUrl(editing)) || info.local?.defaultBaseUrl || '',
	);
	const [error, setError] = useState<string | null>(null);
	// null = follow the provider default, which is what the picker preselects.
	// Only sent when the operator actually opened Advanced and picked something.
	const [runtime, setRuntime] = useState<AgentRuntime | null>(editing?.runtime ?? null);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	// The guided sign-in panel is mounted only after an explicit click, because
	// starting a flow creates a container.
	const [signingIn, setSigningIn] = useState(false);
	const [manualOpen, setManualOpen] = useState(false);
	// Set when a sign-in could not start - no driver for this CLI, or the
	// installed version dropped the flag. The paste form takes over with no
	// message: a vendor's beta flag disappearing is not something the operator
	// can act on. The server still names and logs it.
	const [pasteFallback, setPasteFallback] = useState(false);

	// Keep the name pinned to the generated default until the user edits it
	// (also re-syncs once the async configs query resolves). Never when editing —
	// it would rename the row out from under the operator.
	useEffect(() => {
		if (!editing && !nameEdited) setName(defaultLabel(provider, configs));
	}, [configs, editing, nameEdited, provider]);

	const credential = authMethod === AiAuthMethod.Subscription ? authJson : apiKey;
	// A local runner needs a reachable server URL, not a credential: it either
	// ignores the token or only checks one when the operator has enabled auth.
	const isLocal = Boolean(info.local);
	// What Advanced holds: the CLI picker where the provider runs on more than one,
	// and a local runner's API key — optional, because a self-hosted server usually
	// has no auth, so a prominent key field reads as a requirement it is not.
	// Nothing to disclose means no trigger, rather than one opening on an empty box.
	const hasCliChoice = providerHasCliChoice(provider);
	const hasAdvanced = hasCliChoice || isLocal;
	// Whether this provider's CLI can be driven at all, resolved from the same
	// table the server uses so the button never appears for a runtime with no
	// driver. Editing an existing config keeps the paste form: rotating a
	// credential in place is a different act from minting a new one.
	const canGuidedSignIn =
		!editing && Boolean(info.supportsSubscription) && providerHasGuidedSignIn(provider, runtime);
	// Editing already has a stored credential, so name or CLI alone is a valid save —
	// except when the auth method is being switched, where the stored credential is
	// the wrong shape for the new one and a replacement is the whole point.
	const switchingAuth = Boolean(editing) && authMethod !== editing?.auth_method;
	const canSubmit = editing
		? Boolean(name.trim()) && (!switchingAuth || Boolean(credential.trim()))
		: isLocal
			? Boolean(baseUrl.trim())
			: Boolean(credential.trim());
	const loopbackWarning = isLocal ? loopbackHostWarning(baseUrl) : null;
	const pending = editing ? updateProvider.isPending : createProvider.isPending;

	const apiKeyField = (
		<>
			<Input
				label={isLocal ? t('settings.provider.apiKeyOptional') : 'API key'}
				type="password"
				placeholder={info.keyPlaceholder}
				value={apiKey}
				onChange={(e) => setApiKey(e.target.value)}
			/>
			{editing && (
				<p className="text-[13px] text-text-3">{t('settings.provider.credentialUnchangedHint')}</p>
			)}
		</>
	);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!canSubmit) return;
		try {
			if (editing) {
				const rotating = Boolean(credential.trim());
				await updateProvider.mutateAsync({
					label: name.trim(),
					runtime,
					// A blank credential means "keep the stored one" — sending it would ask
					// the server to store an empty key.
					...(rotating ? { api_key: credential, auth_method: authMethod } : {}),
					...(isLocal ? { base_url: baseUrl.trim() } : {}),
				});
			} else {
				await createProvider.mutateAsync({
					provider,
					api_key: credential,
					label: showName ? name.trim() || undefined : undefined,
					auth_method: authMethod,
					...(isLocal ? { base_url: baseUrl.trim() } : {}),
					...(runtime ? { runtime } : {}),
				});
			}
			onDone();
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: editing
						? t('settings.provider.editFailed')
						: 'Failed to add provider',
			);
		}
	}

	// A running sign-in replaces the form entirely: the fields behind it are not
	// editable mid-flow (the label is already committed to the flow), and leaving
	// them on screen would invite an edit that silently does nothing.
	if (signingIn) {
		return (
			<SubscriptionLoginPanel
				provider={provider}
				label={showName ? name.trim() || undefined : undefined}
				runtime={runtime}
				onDone={onDone}
				onUnavailable={() => {
					setSigningIn(false);
					setPasteFallback(true);
				}}
				onCancel={() => setSigningIn(false)}
			/>
		);
	}

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4">
			{info.supportsSubscription && (
				<div className="flex flex-col gap-1.5">
					<span className="text-eyebrow text-text-2">Authentication</span>
					<div className="flex gap-2">
						<Button
							type="button"
							size="sm"
							variant={authMethod === AiAuthMethod.ApiKey ? 'primary' : 'secondary'}
							onClick={() => {
								setAuthMethod(AiAuthMethod.ApiKey);
								setError(null);
							}}
						>
							API key
						</Button>
						<Button
							type="button"
							size="sm"
							variant={authMethod === AiAuthMethod.Subscription ? 'primary' : 'secondary'}
							onClick={() => {
								setAuthMethod(AiAuthMethod.Subscription);
								setError(null);
							}}
						>
							{info.runtimeLabel} subscription
						</Button>
					</div>
				</div>
			)}

			{showName && (
				<Input
					label="Name"
					value={name}
					placeholder={info.name}
					onChange={(e) => {
						setName(e.target.value);
						setNameEdited(true);
					}}
				/>
			)}

			{authMethod === AiAuthMethod.Subscription ? (
				<div className="flex flex-col gap-3">
					{/* Guided sign-in is offered only where a driver exists. Where it does
					    not (Gemini today), the paste form is simply the whole branch -
					    there is no button that would start something and hang. */}
					{canGuidedSignIn && !pasteFallback ? (
						<>
							<div className="rounded-md border border-border bg-surface-2 px-3 py-2.5">
								<p className="text-sm font-medium text-text-1 mb-1">
									{t('settings.provider.signIn.heading', { provider: info.name })}
								</p>
								<p className="text-[13px] text-text-2">{t('settings.provider.signIn.blurb')}</p>
							</div>
							<Button type="button" onClick={() => setSigningIn(true)}>
								{t('settings.provider.signIn.action', { cli: info.runtimeLabel })}
							</Button>
							<button
								type="button"
								aria-expanded={manualOpen}
								onClick={() => setManualOpen((open) => !open)}
								className="flex items-center gap-1.5 self-start border-t border-border pt-3 w-full text-eyebrow text-text-2 hover:text-text-1"
							>
								{manualOpen ? (
									<ChevronDown className="w-3.5 h-3.5" />
								) : (
									<ChevronRight className="w-3.5 h-3.5" />
								)}
								{t('settings.provider.signIn.manual')}
							</button>
						</>
					) : null}
					{(!canGuidedSignIn || pasteFallback || manualOpen) && (
						<div className="flex flex-col gap-2">
							<SubscriptionInstructions provider={provider} />
							<textarea
								required={!editing && !canGuidedSignIn}
								aria-label="Subscription credential"
								value={authJson}
								onChange={(e) => setAuthJson(e.target.value)}
								placeholder={SUBSCRIPTION_INSTRUCTIONS[provider]?.placeholder}
								rows={6}
								spellCheck={false}
								className="w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 text-xs font-mono text-text-1 outline-none focus:border-border-strong"
							/>
						</div>
					)}
				</div>
			) : (
				<div className="flex flex-col gap-2">
					<ApiKeyInstructions provider={provider} />
					{isLocal && (
						<div className="flex flex-col gap-1.5">
							<Input
								label="Server URL"
								type="url"
								inputMode="url"
								placeholder={info.local?.defaultBaseUrl}
								value={baseUrl}
								onChange={(e) => setBaseUrl(e.target.value)}
							/>
							{loopbackWarning && (
								<p className="text-[13px] text-warning break-words">{loopbackWarning}</p>
							)}
						</div>
					)}
					{!isLocal && apiKeyField}
				</div>
			)}

			{hasAdvanced && (
				<div className="flex flex-col gap-2.5 border-t border-border pt-3">
					<button
						type="button"
						aria-expanded={advancedOpen}
						onClick={() => setAdvancedOpen((open) => !open)}
						className="flex items-center gap-1.5 self-start text-eyebrow text-text-2 hover:text-text-1"
					>
						{advancedOpen ? (
							<ChevronDown className="w-3.5 h-3.5" />
						) : (
							<ChevronRight className="w-3.5 h-3.5" />
						)}
						{t('settings.provider.advanced')}
					</button>
					{advancedOpen && (
						<div className="ml-1 flex flex-col gap-3 border-l-2 border-border pl-3">
							{hasCliChoice && (
								<AgentCliPicker provider={provider} value={runtime} onChange={setRuntime} />
							)}
							{isLocal && authMethod !== AiAuthMethod.Subscription && apiKeyField}
						</div>
					)}
				</div>
			)}

			{error && <p className="text-[13px] text-danger">{error}</p>}

			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
				<Button type="submit" disabled={!canSubmit || pending}>
					{pending && <Loader2 className="w-4 h-4 animate-spin" />}
					{submitLabel}
				</Button>
			</div>
		</form>
	);
}
