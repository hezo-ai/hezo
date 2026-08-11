import { describe, expect, it } from 'vitest';
import {
	AgentEffort,
	AgentRuntimeStatus,
	AiProvider,
	ArchiveFilter,
	assetBasename,
	assetContentDisposition,
	assetFolder,
	assetServeCsp,
	ChatChannel,
	ChatConversationKind,
	CredentialKind,
	claudeCodeModelArg,
	claudeCodeProviderUsesCustomEndpoint,
	credentialKindRequiresAllowedHosts,
	displayToolName,
	extensionOf,
	formatTaskStatus,
	isAgentEffort,
	isAllowedAttachmentExtension,
	isAllowedAttachmentMime,
	isArchiveAssetMime,
	isArchiveFilter,
	isBudgetPauseStatus,
	isChatChannel,
	isChatConversationKind,
	isMarkdownDocSlug,
	isReactionKind,
	isTextAssetMime,
	matchesArchiveFilter,
	normalizeAssetFilename,
	normalizeAssetFolder,
	normalizeAssetPath,
	opencodeModelArg,
	parseProviderModels,
	providerDirectUpstreamHosts,
	qualifiedMcpToolName,
	ReactionKind,
	resolveAttachmentContentType,
	splitAssetPath,
	TaskStatus,
	taskUploadsFolder,
} from '../src/types/common';

describe('enum guards', () => {
	it('isAgentEffort', () => {
		expect(isAgentEffort(AgentEffort.High)).toBe(true);
		expect(isAgentEffort('medium')).toBe(true);
		expect(isAgentEffort('bogus')).toBe(false);
		expect(isAgentEffort(3)).toBe(false);
		expect(isAgentEffort(null)).toBe(false);
	});

	it('isBudgetPauseStatus', () => {
		expect(isBudgetPauseStatus(AgentRuntimeStatus.OutOfAgentBudget)).toBe(true);
		expect(isBudgetPauseStatus(AgentRuntimeStatus.OutOfProjectBudget)).toBe(true);
		expect(isBudgetPauseStatus(AgentRuntimeStatus.Active)).toBe(false);
	});

	it('isReactionKind', () => {
		expect(isReactionKind(ReactionKind.Ack)).toBe(true);
		expect(isReactionKind('nope')).toBe(false);
		expect(isReactionKind(42)).toBe(false);
	});

	it('isChatChannel covers every channel including slack and discord', () => {
		expect(isChatChannel(ChatChannel.Web)).toBe(true);
		expect(isChatChannel(ChatChannel.Telegram)).toBe(true);
		expect(isChatChannel(ChatChannel.WhatsApp)).toBe(true);
		expect(isChatChannel(ChatChannel.Slack)).toBe(true);
		expect(isChatChannel(ChatChannel.Discord)).toBe(true);
		expect(isChatChannel('slack')).toBe(true);
		expect(isChatChannel('matrix')).toBe(false);
		expect(isChatChannel('')).toBe(false);
	});

	it('isChatConversationKind accepts exactly the two kinds', () => {
		expect(isChatConversationKind(ChatConversationKind.Assistant)).toBe(true);
		expect(isChatConversationKind(ChatConversationKind.Coworker)).toBe(true);
		expect(isChatConversationKind('assistant')).toBe(true);
		expect(isChatConversationKind('coworker')).toBe(true);
		expect(isChatConversationKind('mirror')).toBe(false);
		expect(isChatConversationKind('')).toBe(false);
	});

	it('credentialKindRequiresAllowedHosts', () => {
		expect(credentialKindRequiresAllowedHosts(CredentialKind.ApiKey)).toBe(true);
		expect(credentialKindRequiresAllowedHosts(CredentialKind.OauthToken)).toBe(true);
		expect(credentialKindRequiresAllowedHosts(CredentialKind.GithubPat)).toBe(true);
		expect(credentialKindRequiresAllowedHosts(CredentialKind.SshPrivateKey)).toBe(false);
		expect(credentialKindRequiresAllowedHosts(CredentialKind.Other)).toBe(false);
	});
});

describe('archive filter', () => {
	it('isArchiveFilter accepts exactly the three views', () => {
		expect(isArchiveFilter('active')).toBe(true);
		expect(isArchiveFilter('archived')).toBe(true);
		expect(isArchiveFilter('all')).toBe(true);
		expect(isArchiveFilter('deleted')).toBe(false);
		expect(isArchiveFilter('')).toBe(false);
		expect(isArchiveFilter(undefined)).toBe(false);
		expect(isArchiveFilter(1)).toBe(false);
	});

	it('matchesArchiveFilter partitions rows by archived_at', () => {
		const stamp = '2026-07-05T00:00:00Z';
		// Active view: only unarchived rows (null or undefined stamp).
		expect(matchesArchiveFilter(null, ArchiveFilter.Active)).toBe(true);
		expect(matchesArchiveFilter(undefined, ArchiveFilter.Active)).toBe(true);
		expect(matchesArchiveFilter(stamp, ArchiveFilter.Active)).toBe(false);
		// Archived view: only stamped rows.
		expect(matchesArchiveFilter(stamp, ArchiveFilter.Archived)).toBe(true);
		expect(matchesArchiveFilter(null, ArchiveFilter.Archived)).toBe(false);
		// All: everything.
		expect(matchesArchiveFilter(stamp, ArchiveFilter.All)).toBe(true);
		expect(matchesArchiveFilter(null, ArchiveFilter.All)).toBe(true);
	});
});

describe('formatTaskStatus', () => {
	it('maps known statuses to labels and passes through unknown', () => {
		expect(formatTaskStatus(TaskStatus.InProgress)).toBe('In Progress');
		expect(formatTaskStatus('weird')).toBe('weird');
	});
});

describe('asset / attachment helpers', () => {
	it('forces download only for inline-unsafe mime', () => {
		expect(assetContentDisposition('image/svg+xml')).toBe('attachment');
		expect(assetContentDisposition('image/png')).toBe('inline');
	});

	it('never serves an archive inline', () => {
		// The second reason to force a download, distinct from active content: an
		// archive has nothing to render, so `inline` would be a lie.
		for (const mime of [
			'application/zip',
			'application/x-tar',
			'application/gzip',
			'application/x-7z-compressed',
			'application/vnd.rar',
		]) {
			expect(assetContentDisposition(mime), mime).toBe('attachment');
			expect(isArchiveAssetMime(mime), mime).toBe(true);
		}
		expect(isArchiveAssetMime('image/png')).toBe(false);
		expect(isArchiveAssetMime('application/pdf')).toBe(false);
	});

	it('forces an attachment for any mime when download is requested', () => {
		expect(assetContentDisposition('image/png', true)).toBe('attachment');
		expect(assetContentDisposition('text/html', true)).toBe('attachment');
		// Default arg is unchanged from the single-arg behavior.
		expect(assetContentDisposition('image/png', false)).toBe('inline');
	});

	it('emits a sandbox CSP only for html', () => {
		const csp = assetServeCsp('text/html');
		expect(csp).toContain('sandbox');
		// A user-initiated in-page download must not be silently blocked.
		expect(csp).toContain('allow-downloads');
		expect(assetServeCsp('image/png')).toBeNull();
	});

	it('classifies text vs binary asset mime', () => {
		// Text assets round-trip inline (utf8); binary assets go through base64 / a signed URL.
		expect(isTextAssetMime('text/html')).toBe(true);
		expect(isTextAssetMime('text/plain')).toBe(true);
		expect(isTextAssetMime('text/markdown')).toBe(true);
		expect(isTextAssetMime('image/svg+xml')).toBe(true);
		expect(isTextAssetMime('image/png')).toBe(false);
		expect(isTextAssetMime('application/pdf')).toBe(false);
	});

	it('normalizeAssetFilename strips paths and unsafe chars', () => {
		expect(normalizeAssetFilename('foo/bar baz.png')).toBe('bar-baz.png');
		expect(normalizeAssetFilename('..\\weird@@name!.txt')).toBe('weird-name.txt');
		expect(normalizeAssetFilename('////')).toBe('file');
	});

	it('normalizeAssetPath keeps folders up to two levels', () => {
		expect(normalizeAssetPath('hero.png')).toBe('hero.png');
		expect(normalizeAssetPath('blog/hero.png')).toBe('blog/hero.png');
		expect(normalizeAssetPath('blog/images/hero.png')).toBe('blog/images/hero.png');
		expect(normalizeAssetPath('a/b/c/d.png')).toBeNull();
	});

	it('normalizeAssetPath cleans segments and drops literal empties', () => {
		expect(normalizeAssetPath('My Folder!/hero image.png')).toBe('My-Folder/hero-image.png');
		expect(normalizeAssetPath('a//b.png')).toBe('a/b.png');
		expect(normalizeAssetPath('/blog/hero.png/')).toBe('blog/hero.png');
		expect(normalizeAssetPath('blog\\hero.png')).toBe('blog/hero.png');
		// A segment that evaporates after cleanup rejects the whole path instead
		// of silently relocating the file.
		expect(normalizeAssetPath('###/hero.png')).toBeNull();
		expect(normalizeAssetPath('blog/###')).toBeNull();
		expect(normalizeAssetPath('')).toBeNull();
		expect(normalizeAssetPath('///')).toBeNull();
	});

	it('normalizeAssetFolder treats empty as root and bounds depth', () => {
		expect(normalizeAssetFolder('')).toBe('');
		expect(normalizeAssetFolder('/')).toBe('');
		expect(normalizeAssetFolder('blog')).toBe('blog');
		expect(normalizeAssetFolder('blog/images')).toBe('blog/images');
		expect(normalizeAssetFolder('a/b/c')).toBeNull();
		expect(normalizeAssetFolder('Launch Plan')).toBe('Launch-Plan');
		expect(normalizeAssetFolder('###')).toBeNull();
	});

	it('taskUploadsFolder names the folder after the task identifier', () => {
		expect(taskUploadsFolder('IN-42')).toBe('uploads/IN-42');
		// A stable identifier means the folder survives a task rename.
		expect(taskUploadsFolder('BE-7')).toBe('uploads/BE-7');
		// A stray separator is sanitized into the single segment, never a new level.
		expect(taskUploadsFolder('IN/42')).toBe('uploads/IN-42');
		// If nothing survives cleanup, fall back to the bare uploads root.
		expect(taskUploadsFolder('???')).toBe('uploads');
	});

	it('splitAssetPath / assetFolder / assetBasename', () => {
		expect(splitAssetPath('a/b/c.png')).toEqual({ folder: 'a/b', basename: 'c.png' });
		expect(splitAssetPath('c.png')).toEqual({ folder: '', basename: 'c.png' });
		expect(assetFolder('blog/hero.png')).toBe('blog');
		expect(assetFolder('hero.png')).toBe('');
		expect(assetBasename('blog/images/hero.png')).toBe('hero.png');
		expect(assetBasename('hero.png')).toBe('hero.png');
	});

	it('resolveAttachmentContentType coerces text/plain-mapped extensions', () => {
		expect(resolveAttachmentContentType('run.js', 'text/javascript')).toBe('text/plain');
		expect(resolveAttachmentContentType('data.json', 'application/json')).toBe('text/plain');
		expect(resolveAttachmentContentType('rows.csv', 'text/csv')).toBe('text/plain');
		expect(resolveAttachmentContentType('deploy.sh', '')).toBe('text/plain');
		expect(resolveAttachmentContentType('conf.yaml', 'application/octet-stream')).toBe(
			'text/plain',
		);
	});

	it('resolveAttachmentContentType keeps the original posture elsewhere', () => {
		// Declared allowlisted type wins.
		expect(resolveAttachmentContentType('photo.png', 'image/png')).toBe('image/png');
		// Blank / octet-stream falls back to the extension's canonical type.
		expect(resolveAttachmentContentType('notes.md', '')).toBe('text/markdown');
		expect(resolveAttachmentContentType('notes.md', 'application/octet-stream')).toBe(
			'text/markdown',
		);
		// A specific disallowed declared type is suspicious → reject.
		expect(resolveAttachmentContentType('photo.png', 'application/x-msdownload')).toBeNull();
		// Unsupported extension → reject.
		expect(resolveAttachmentContentType('virus.exe', 'text/plain')).toBeNull();
		expect(resolveAttachmentContentType('noext', 'text/plain')).toBeNull();
	});

	it('archive extensions are authoritative over whatever the browser declared', () => {
		// One archive format is spelled several ways depending on OS and browser, so
		// the extension decides and the declaration is ignored. Windows Chrome/Edge
		// send `application/x-zip-compressed`, which is not itself allowlisted - if
		// the declaration won, the most common desktop upload would be rejected.
		for (const declared of [
			'application/zip',
			'application/x-zip-compressed',
			'multipart/x-zip',
			'application/octet-stream',
			'',
			// Even a hostile declaration cannot change what gets stored.
			'application/x-msdownload',
		]) {
			expect(resolveAttachmentContentType('bundle.zip', declared), declared).toBe(
				'application/zip',
			);
		}
		expect(resolveAttachmentContentType('logs.tar', 'application/x-gtar')).toBe(
			'application/x-tar',
		);
		expect(resolveAttachmentContentType('dump.gz', 'application/x-gzip')).toBe('application/gzip');
		// A double extension resolves through its last segment and keeps its name.
		expect(resolveAttachmentContentType('backup.tar.gz', 'application/x-compressed-tar')).toBe(
			'application/gzip',
		);
		expect(resolveAttachmentContentType('backup.tgz', '')).toBe('application/gzip');
		expect(resolveAttachmentContentType('files.7z', '')).toBe('application/x-7z-compressed');
		expect(resolveAttachmentContentType('files.rar', 'application/x-rar-compressed')).toBe(
			'application/vnd.rar',
		);
	});

	it('only an archive extension is authoritative, never an archive declaration', () => {
		// The rule is one-directional. A .zip always stores application/zip (above),
		// but a non-archive extension still follows the long-standing declared-wins
		// rule - which has always let one allowlisted type be declared for another
		// (a .png could already be stored as application/pdf). Nothing here is
		// weakened by archives joining the allowlist: the mismatch is still served
		// as an inert download, and the reverse (a .zip stored as an image) is now
		// impossible.
		expect(resolveAttachmentContentType('photo.png', 'application/zip')).toBe('application/zip');
		// A non-allowlisted spelling is still rejected on a non-archive extension:
		// the authoritative rule never runs for it, so no alias can sneak through.
		expect(resolveAttachmentContentType('photo.png', 'application/x-zip-compressed')).toBeNull();
	});

	it('archive extensions are allowlisted attachments', () => {
		for (const name of ['a.zip', 'a.tar', 'a.gz', 'a.tgz', 'a.7z', 'a.rar']) {
			expect(isAllowedAttachmentExtension(name), name).toBe(true);
		}
		expect(isAllowedAttachmentMime('application/zip')).toBe(true);
	});

	it('script extensions are allowlisted attachments', () => {
		for (const name of ['a.sh', 'a.py', 'a.js', 'a.ts', 'a.json', 'a.csv', 'a.yaml', 'a.yml']) {
			expect(isAllowedAttachmentExtension(name)).toBe(true);
		}
	});

	it('extensionOf', () => {
		expect(extensionOf('a.PNG')).toBe('png');
		expect(extensionOf('a.b.c')).toBe('c');
		expect(extensionOf('noext')).toBeNull();
		expect(extensionOf('trailing.')).toBeNull();
	});

	it('attachment allowlists', () => {
		expect(isAllowedAttachmentExtension('photo.png')).toBe(true);
		expect(isAllowedAttachmentExtension('script.exe')).toBe(false);
		expect(isAllowedAttachmentMime('image/png')).toBe(true);
		expect(isAllowedAttachmentMime('application/x-evil')).toBe(false);
	});

	it('isMarkdownDocSlug', () => {
		expect(isMarkdownDocSlug('readme.md')).toBe(true);
		expect(isMarkdownDocSlug('Notes.MD')).toBe(true);
		expect(isMarkdownDocSlug('image.png')).toBe(false);
		expect(isMarkdownDocSlug('.md')).toBe(false);
	});
});

describe('provider helpers', () => {
	it('providerDirectUpstreamHosts uses the base-url host when set, else the default', () => {
		expect(providerDirectUpstreamHosts(AiProvider.Anthropic)).toEqual(['api.anthropic.com']);
		expect(providerDirectUpstreamHosts(AiProvider.DeepSeek)).toEqual(['api.deepseek.com']);
		expect(providerDirectUpstreamHosts(AiProvider.ZAi)).toEqual(['api.z.ai']);
	});

	it('claudeCodeModelArg strips the [1m] suffix only for DeepSeek', () => {
		expect(claudeCodeModelArg(AiProvider.DeepSeek, 'deepseek-v4-pro[1m]')).toBe('deepseek-v4-pro');
		expect(claudeCodeModelArg(AiProvider.Anthropic, 'claude-opus-4[1m]')).toBe('claude-opus-4[1m]');
	});

	it('opencodeModelArg qualifies bare ids for OpenRouter only', () => {
		expect(opencodeModelArg(AiProvider.OpenRouter, 'anthropic/claude')).toBe(
			'openrouter/anthropic/claude',
		);
		expect(opencodeModelArg(AiProvider.OpenRouter, 'openrouter/x')).toBe('openrouter/x');
		expect(opencodeModelArg(AiProvider.Anthropic, 'claude-opus-4')).toBe('claude-opus-4');
	});

	it('claudeCodeProviderUsesCustomEndpoint is true only for the third-party Claude Code providers', () => {
		// DeepSeek/Z.ai/Kimi route Claude Code at a custom ANTHROPIC_BASE_URL — the
		// run model is the single served model, so runtime-derived models track it.
		expect(claudeCodeProviderUsesCustomEndpoint(AiProvider.DeepSeek)).toBe(true);
		expect(claudeCodeProviderUsesCustomEndpoint(AiProvider.ZAi)).toBe(true);
		expect(claudeCodeProviderUsesCustomEndpoint(AiProvider.Kimi)).toBe(true);
		// Anthropic is a Claude Code provider but hits its own API (no base-url
		// override), so it keeps its stable constant judge/subagent models.
		expect(claudeCodeProviderUsesCustomEndpoint(AiProvider.Anthropic)).toBe(false);
		// Non-Claude-Code runtimes are always false.
		expect(claudeCodeProviderUsesCustomEndpoint(AiProvider.OpenAI)).toBe(false);
		expect(claudeCodeProviderUsesCustomEndpoint(AiProvider.Google)).toBe(false);
		expect(claudeCodeProviderUsesCustomEndpoint(AiProvider.OpenRouter)).toBe(false);
		expect(claudeCodeProviderUsesCustomEndpoint(AiProvider.XAi)).toBe(false);
	});
});

describe('parseProviderModels', () => {
	it('returns [] for non-object input', () => {
		expect(parseProviderModels(AiProvider.OpenAI, null)).toEqual([]);
		expect(parseProviderModels(AiProvider.OpenAI, 'nope')).toEqual([]);
	});

	it('parses Google models filtered by generateContent', () => {
		const out = parseProviderModels(AiProvider.Google, {
			models: [
				{
					name: 'models/gemini-1.5-pro',
					displayName: 'Gemini 1.5 Pro',
					supportedGenerationMethods: ['generateContent'],
				},
				{ name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
			],
		});
		expect(out).toEqual([{ id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' }]);
	});

	it('parses OpenAI-style data and filters non-chat ids', () => {
		const out = parseProviderModels(AiProvider.OpenAI, {
			data: [
				{ id: 'gpt-4o', display_name: 'GPT-4o' },
				{ id: 'text-embedding-3-small' },
				{ id: 'whisper-1' },
			],
		});
		expect(out).toEqual([{ id: 'gpt-4o', label: 'GPT-4o' }]);
	});

	it('falls back to the id when no display name is present', () => {
		const out = parseProviderModels(AiProvider.OpenRouter, {
			data: [{ id: 'anthropic/claude-sonnet' }],
		});
		expect(out).toEqual([{ id: 'anthropic/claude-sonnet', label: 'anthropic/claude-sonnet' }]);
	});
});

describe('displayToolName', () => {
	it('strips the mcp server namespace from a qualified tool name', () => {
		expect(displayToolName(qualifiedMcpToolName('hezo', 'list_tasks'))).toBe('list_tasks');
		expect(displayToolName('mcp__linear__save_issue')).toBe('save_issue');
	});

	it('keeps a native tool name as-is', () => {
		expect(displayToolName('Bash')).toBe('Bash');
		expect(displayToolName('Edit')).toBe('Edit');
	});

	it('keeps a double underscore inside the upstream tool name', () => {
		expect(displayToolName('mcp__linear__save__issue')).toBe('save__issue');
	});

	it('leaves a malformed name alone rather than guessing', () => {
		expect(displayToolName('mcp__hezo')).toBe('mcp__hezo');
		expect(displayToolName('')).toBe('');
	});
});
