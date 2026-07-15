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
	CredentialKind,
	claudeCodeModelArg,
	credentialKindRequiresAllowedHosts,
	extensionOf,
	formatTaskStatus,
	isAgentEffort,
	isAllowedAttachmentExtension,
	isAllowedAttachmentMime,
	isArchiveFilter,
	isBudgetPauseStatus,
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
