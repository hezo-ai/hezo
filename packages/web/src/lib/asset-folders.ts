import { assetFolder, type ProjectAsset } from '@hezo/shared';

export interface AssetFolderEntry {
	/** Display name (the folder's own segment). */
	name: string;
	/** Full folder path from the library root. */
	path: string;
	/** Number of assets anywhere under this folder (all depths). */
	count: number;
}

export interface GroupedAssets {
	folders: AssetFolderEntry[];
	items: ProjectAsset[];
}

/**
 * Group the flat asset list for one folder view: the direct child folders
 * (with recursive asset counts) and the assets sitting directly in
 * `currentFolder` ('' = the library root). Folders sort alphabetically;
 * items keep the list order (created_at DESC from the API).
 */
export function groupAssets(assets: ProjectAsset[], currentFolder: string): GroupedAssets {
	const prefix = currentFolder ? `${currentFolder}/` : '';
	const folders = new Map<string, AssetFolderEntry>();
	const items: ProjectAsset[] = [];
	for (const asset of assets) {
		const path = asset.original_filename;
		if (!path.startsWith(prefix)) continue;
		const rest = path.slice(prefix.length);
		const slash = rest.indexOf('/');
		if (slash < 0) {
			items.push(asset);
			continue;
		}
		const name = rest.slice(0, slash);
		const entry = folders.get(name);
		if (entry) {
			entry.count += 1;
		} else {
			folders.set(name, { name, path: `${prefix}${name}`, count: 1 });
		}
	}
	return {
		folders: Array.from(folders.values()).sort((a, b) => a.name.localeCompare(b.name)),
		items,
	};
}

/** Every folder path in the library (both levels), sorted, for the move dialog. */
export function allFolders(assets: ProjectAsset[]): string[] {
	const out = new Set<string>();
	for (const asset of assets) {
		const folder = assetFolder(asset.original_filename);
		if (!folder) continue;
		out.add(folder);
		const slash = folder.indexOf('/');
		if (slash > 0) out.add(folder.slice(0, slash));
	}
	return Array.from(out).sort((a, b) => a.localeCompare(b));
}

/** Breadcrumb segments for a folder path, root-first: a/b → [a, a/b]. */
export function folderCrumbs(folder: string): Array<{ name: string; path: string }> {
	if (!folder) return [];
	const segments = folder.split('/');
	return segments.map((name, i) => ({ name, path: segments.slice(0, i + 1).join('/') }));
}

/** Nesting depth: 0 at the library root, 1 for a top-level folder, 2 for a subfolder. */
export function folderDepth(path: string): number {
	return path === '' ? 0 : path.split('/').length;
}

/**
 * Indentation level for the folder-picker tree: the library root and every
 * top-level folder sit flush-left (0); each nested level steps in one more, so
 * `launch/art` renders one indent under `launch`.
 */
export function folderIndentLevel(path: string): number {
	const depth = folderDepth(path);
	return depth === 0 ? 0 : depth - 1;
}

/** The folder's own trailing segment (its display name); '' is the library root. */
export function folderLeafName(path: string): string {
	if (path === '') return '';
	const slash = path.lastIndexOf('/');
	return slash < 0 ? path : path.slice(slash + 1);
}

/**
 * Filter a sorted folder list to those matching `query` (case-insensitive
 * substring on the full path), keeping each match's ancestors so the indented
 * tree still reads coherently while searching (a matched subfolder never
 * appears orphaned from its parent). An empty query returns the list intact.
 */
export function filterFolderTree(folders: string[], query: string): string[] {
	const q = query.trim().toLowerCase();
	if (!q) return folders;
	const keep = new Set<string>();
	for (const folder of folders) {
		if (!folder.toLowerCase().includes(q)) continue;
		keep.add(folder);
		const segments = folder.split('/');
		for (let i = 1; i < segments.length; i += 1) {
			keep.add(segments.slice(0, i).join('/'));
		}
	}
	return folders.filter((folder) => keep.has(folder));
}
