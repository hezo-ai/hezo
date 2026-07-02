import { describe, expect, test } from 'vitest';
import {
	filterFolderTree,
	folderDepth,
	folderIndentLevel,
	folderLeafName,
} from '../src/lib/asset-folders';

describe('folderDepth', () => {
	test('the root is 0; each path segment adds a level', () => {
		expect(folderDepth('')).toBe(0);
		expect(folderDepth('launch')).toBe(1);
		expect(folderDepth('launch/art')).toBe(2);
	});
});

describe('folderIndentLevel', () => {
	test('root and top-level folders sit flush; subfolders step in one level', () => {
		expect(folderIndentLevel('')).toBe(0);
		expect(folderIndentLevel('launch')).toBe(0);
		expect(folderIndentLevel('launch/art')).toBe(1);
	});
});

describe('folderLeafName', () => {
	test('returns the trailing segment; the root has none', () => {
		expect(folderLeafName('')).toBe('');
		expect(folderLeafName('launch')).toBe('launch');
		expect(folderLeafName('launch/art')).toBe('art');
	});
});

describe('filterFolderTree', () => {
	const folders = ['docs', 'launch', 'launch/art', 'reports', 'reports/q3'];

	test('an empty (or whitespace) query returns the list unchanged', () => {
		expect(filterFolderTree(folders, '')).toEqual(folders);
		expect(filterFolderTree(folders, '   ')).toEqual(folders);
	});

	test('matches a full path, case-insensitively, preserving order', () => {
		expect(filterFolderTree(folders, 'REPORTS')).toEqual(['reports', 'reports/q3']);
	});

	test('keeps a matched subfolder together with its ancestor so the tree still reads', () => {
		// "art" only matches launch/art, but its parent launch is retained.
		expect(filterFolderTree(folders, 'art')).toEqual(['launch', 'launch/art']);
	});

	test('retains an ancestor whose child matches even if the ancestor itself does not', () => {
		expect(filterFolderTree(folders, 'q3')).toEqual(['reports', 'reports/q3']);
	});

	test('drops folders that neither match nor parent a match', () => {
		expect(filterFolderTree(folders, 'launch')).toEqual(['launch', 'launch/art']);
	});
});
