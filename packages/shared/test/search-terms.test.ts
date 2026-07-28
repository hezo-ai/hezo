import { describe, expect, it } from 'vitest';
import {
	extractTerms,
	generateTeamKeywords,
	MAX_TEAM_KEYWORD_LENGTH,
	MAX_TEAM_KEYWORDS,
	normalizeKeywords,
	stemTerm,
	teamKeywordsError,
	uniqueTerms,
} from '../src/search/terms';

describe('stemTerm', () => {
	it('folds plurals onto the singular stem', () => {
		expect(stemTerm('apps')).toBe(stemTerm('app'));
		expect(stemTerm('analysts')).toBe(stemTerm('analyst'));
		expect(stemTerm('publishes')).toBe(stemTerm('publish'));
		expect(stemTerm('verifies')).toBe(stemTerm('verify'));
		expect(stemTerm('modes')).toBe(stemTerm('mode'));
	});

	it('folds verb and agent endings onto the same stem', () => {
		expect(stemTerm('marketing')).toBe(stemTerm('market'));
		expect(stemTerm('tracking')).toBe(stemTerm('tracked'));
		expect(stemTerm('researchers')).toBe(stemTerm('research'));
		// Two stripping passes: engineering → engineer → engin.
		expect(stemTerm('engineering')).toBe(stemTerm('engineer'));
	});

	it('leaves short words and non-plural s-endings intact', () => {
		// The guard that matters: "app" is never rewritten into something longer,
		// and nothing rewrites "approval" down to it. That precision is the whole
		// point of stemming rather than substring matching.
		expect(stemTerm('app')).toBe('app');
		expect(stemTerm('approval')).toBe('approval');
		expect(stemTerm('appetite')).toBe('appetite');
		expect(stemTerm('business')).toBe('business');
		expect(stemTerm('status')).toBe('status');
	});
});

describe('extractTerms', () => {
	it('drops short tokens and function words', () => {
		expect(extractTerms('a todo list app for me and my team')).toEqual([
			'todo',
			'list',
			'app',
			'team',
		]);
	});

	it('drops function words that only surface after stemming', () => {
		// "uses" → "use", "wants" → "want", "this" → "thi": all stopwords.
		expect(extractTerms('this uses and wants')).toEqual([]);
	});

	it('splits keyword phrases into their terms', () => {
		expect(extractTerms('todo list')).toEqual(['todo', 'list']);
		expect(extractTerms('due diligence')).toEqual(['due', 'diligence']);
	});

	it('is symmetric — the same word normalizes the same on both sides', () => {
		expect(extractTerms('Mobile Apps!')).toEqual(extractTerms('mobile app'));
	});

	it('uniqueTerms de-duplicates while preserving order', () => {
		expect(uniqueTerms('app apps application app')).toEqual(['app', 'application']);
	});
});

describe('normalizeKeywords', () => {
	it('trims, lowercases, collapses whitespace, and de-duplicates in order', () => {
		expect(
			normalizeKeywords([' Mobile  App ', 'saas', 'MOBILE APP', '', '   ', 'Web App']),
		).toEqual(['mobile app', 'saas', 'web app']);
	});

	it('keeps readable phrases rather than stems', () => {
		// Stems are a matcher implementation detail; storing them in a published
		// marketplace file would freeze one matcher version into the data.
		expect(normalizeKeywords(['engineering'])).toEqual(['engineering']);
	});
});

describe('generateTeamKeywords', () => {
	it('produces readable, de-duplicated words and drops function words / short tokens', () => {
		const kw = generateTeamKeywords([
			'Social Media Marketing',
			'A team that grows your social reach and drafts content',
			'Content Writer',
		]);
		// Readable words (not stems), function words ("that", "and", "your") and
		// short tokens dropped, "social"/"content" de-duplicated across the inputs.
		expect(kw).toEqual([
			'social',
			'media',
			'marketing',
			'team',
			'grows',
			'reach',
			'drafts',
			'content',
			'writer',
		]);
	});

	it('drops function words that only surface after stemming', () => {
		// "uses" → "use", "wants" → "want" are stopwords; "app" survives.
		expect(generateTeamKeywords(['this uses and wants an app'])).toEqual(['app']);
	});

	it('keeps whole words rather than stems, so the list stays human-reviewable', () => {
		expect(generateTeamKeywords(['engineering marketing'])).toEqual(['engineering', 'marketing']);
	});

	it('caps the list and never breaches the marketplace keyword ceilings', () => {
		const many = Array.from({ length: MAX_TEAM_KEYWORDS + 20 }, (_, i) => `word${i}`).join(' ');
		const kw = generateTeamKeywords([many]);
		expect(kw.length).toBe(MAX_TEAM_KEYWORDS);
		expect(teamKeywordsError(kw)).toBeNull();
	});
});

describe('teamKeywordsError', () => {
	it('accepts a normal list', () => {
		expect(teamKeywordsError(['app', 'website', 'saas'])).toBeNull();
	});

	it('rejects an over-long list', () => {
		const many = Array.from({ length: MAX_TEAM_KEYWORDS + 1 }, (_, i) => `kw${i}`);
		expect(teamKeywordsError(many)).toContain('too many keywords');
	});

	it('rejects a keyword longer than the per-entry cap', () => {
		expect(teamKeywordsError(['x'.repeat(MAX_TEAM_KEYWORD_LENGTH + 1)])).toContain('longer than');
	});
});
