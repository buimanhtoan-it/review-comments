import type { Position } from './model';

export interface NavigationLocation {
  folderUri: string;
  path: string;
  position: Position;
}

export interface NavigationItem {
  key: string;
  folderUri: string;
  path: string;
  status: 'open' | 'resolved';
  /** File comments precede text comments in the same file. */
  position?: Position;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareLocation(left: NavigationItem, right: NavigationItem | NavigationLocation): number {
  return compareText(left.folderUri, right.folderUri)
    || compareText(left.path, right.path)
    || (left.position?.line ?? -1) - (right.position?.line ?? -1)
    || (left.position?.character ?? -1) - (right.position?.character ?? -1);
}

/** Choose an open comment without mutating the source list or retaining state. */
export function chooseNextKey(
  items: readonly NavigationItem[],
  direction: 1 | -1,
  currentKey?: string,
  location?: NavigationLocation
): string | undefined {
  const ordered = items.filter(item => item.status === 'open')
    .sort((left, right) => compareLocation(left, right) || compareText(left.key, right.key));
  if (!ordered.length) { return undefined; }

  const current = ordered.findIndex(item => item.key === currentKey
    && (!location || (item.folderUri === location.folderUri && item.path === location.path)));
  if (current !== -1) {
    return ordered[(current + direction + ordered.length) % ordered.length].key;
  }

  if (location) {
    // Include a comment exactly at the cursor when it has not been opened yet.
    const candidates = direction === 1 ? ordered : [...ordered].reverse();
    const next = candidates.find(item => direction * compareLocation(item, location) >= 0);
    if (next) { return next.key; }
  }
  return ordered[direction === 1 ? 0 : ordered.length - 1].key;
}
