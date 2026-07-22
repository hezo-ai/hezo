import { describe, expect, it } from 'vitest';
import {
	DOC_DOWNLOAD_MIME,
	docDownloadFilename,
	markdownToPlainText,
} from '../src/documents/text.js';

describe('docDownloadFilename', () => {
	it('keeps the .md name for markdown downloads', () => {
		expect(docDownloadFilename('notes.md', 'markdown')).toBe('notes.md');
		expect(docDownloadFilename('AGENTS.md', 'markdown')).toBe('AGENTS.md');
	});

	it('appends .md when the source lacks it (markdown)', () => {
		expect(docDownloadFilename('notes', 'markdown')).toBe('notes.md');
	});

	it('swaps the extension to .txt for text downloads', () => {
		expect(docDownloadFilename('notes.md', 'text')).toBe('notes.txt');
		expect(docDownloadFilename('release-notes.md', 'text')).toBe('release-notes.txt');
	});

	it('is case-insensitive on the .md extension', () => {
		expect(docDownloadFilename('README.MD', 'text')).toBe('README.txt');
		expect(docDownloadFilename('README.MD', 'markdown')).toBe('README.MD');
	});

	it('exposes a MIME type per format', () => {
		expect(DOC_DOWNLOAD_MIME.markdown).toBe('text/markdown');
		expect(DOC_DOWNLOAD_MIME.text).toBe('text/plain');
	});
});

describe('markdownToPlainText', () => {
	it('strips heading markers', () => {
		expect(markdownToPlainText('# Title\n\n## Section')).toBe('Title\n\nSection');
	});

	it('unwraps links and images to their visible text', () => {
		expect(markdownToPlainText('See [the docs](https://example.com/x).')).toBe('See the docs.');
		expect(markdownToPlainText('![a diagram](img.png)')).toBe('a diagram');
	});

	it('removes emphasis and strikethrough while keeping the words', () => {
		expect(markdownToPlainText('**bold** and _italic_ and ~~gone~~')).toBe(
			'bold and italic and gone',
		);
	});

	it('unwraps inline code', () => {
		expect(markdownToPlainText('Call `request_credential` first.')).toBe(
			'Call request_credential first.',
		);
	});

	it('turns unordered list markers into bullets and keeps ordered numbers', () => {
		expect(markdownToPlainText('- one\n- two')).toBe('• one\n• two');
		expect(markdownToPlainText('1. first\n2. second')).toBe('1. first\n2. second');
	});

	it('strips blockquote markers', () => {
		expect(markdownToPlainText('> quoted line')).toBe('quoted line');
	});

	it('drops code fences but keeps the code lines verbatim', () => {
		const md = '```ts\nconst x = **notBold**;\n```';
		expect(markdownToPlainText(md)).toBe('const x = **notBold**;');
	});

	it('collapses runs of blank lines and trims', () => {
		expect(markdownToPlainText('\n\nHello\n\n\n\nWorld\n\n')).toBe('Hello\n\nWorld');
	});

	it('drops horizontal rules', () => {
		expect(markdownToPlainText('above\n\n---\n\nbelow')).toBe('above\n\nbelow');
	});
});
