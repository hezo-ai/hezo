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
