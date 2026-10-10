import type { Position } from './model';

/** 0-based UTF-16 coordinates; the end is exclusive for text but inclusive for cursor matching. */
export interface HighlightRange {
  start: Position;
  end: Position;
}

export interface HighlightInput {
  key: string;
  status: 'open' | 'resolved';
  stale: boolean;
  range: HighlightRange;
}

export interface HighlightGroups {
  open: HighlightInput[];
  resolved: HighlightInput[];
  stale: HighlightInput[];
  active?: HighlightInput;
}

export interface HighlightOptions {
  /** An explicitly selected thread, for example from the sidebar or navigation. */
  activeKey?: string;
  /** The primary cursor of the editor that owns keyboard focus, if any. */
  cursor?: Position;
  showResolved: boolean;
}

function comparePosition(left: Position, right: Position): number {
  return left.line - right.line || left.character - right.character;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalized(range: HighlightRange): HighlightRange {
  return comparePosition(range.start, range.end) <= 0 ? range : { start: range.end, end: range.start };
}

/**
 * Both ends are inclusive so a cursor left at the end of a revealed selection
 * still belongs to that thread. An empty range matches its whole line.
 */
export function containsPosition(range: HighlightRange, position: Position): boolean {
  const { start, end } = normalized(range);
  if (comparePosition(start, end) === 0) { return position.line === start.line; }
  return comparePosition(start, position) <= 0 && comparePosition(position, end) <= 0;
}

/** Line span first, then the character extent; exact for nested ranges. */
function compareSize(left: HighlightRange, right: HighlightRange): number {
  const a = normalized(left);
  const b = normalized(right);
  return (a.end.line - a.start.line) - (b.end.line - b.start.line)
    || (a.end.character - a.start.character) - (b.end.character - b.start.character);
}

function compareOrder(left: HighlightInput, right: HighlightInput): number {
  const a = normalized(left.range);
  const b = normalized(right.range);
  return comparePosition(a.start, b.start) || comparePosition(a.end, b.end) || compareText(left.key, right.key);
}

function compareCandidate(left: HighlightInput, right: HighlightInput): number {
  const a = normalized(left.range);
  const b = normalized(right.range);
  return compareSize(a, b)
    || Number(left.status === 'resolved') - Number(right.status === 'resolved')
    || Number(left.stale) - Number(right.stale)
    // Remaining ties: prefer the innermost start, then the earliest end, then the key.
    || comparePosition(b.start, a.start)
    || comparePosition(a.end, b.end)
    || compareText(left.key, right.key);
}

/**
 * Split highlights into decoration groups without mutating the input.
 *
 * - An explicit active key wins whenever it is present, even for a hidden resolved thread.
 * - Otherwise the smallest visible range containing the cursor is active; ties prefer open threads.
 * - Stale threads are grouped by staleness rather than status; hidden resolved threads are omitted.
 * - The active thread is excluded from every other group.
 */
export function selectActiveHighlight(items: readonly HighlightInput[], options: HighlightOptions): HighlightInput | undefined {
  if (options.activeKey !== undefined) {
    const explicit = items.find(item => item.key === options.activeKey);
    if (explicit) { return explicit; }
  }
  if (!options.cursor) { return undefined; }
  let best: HighlightInput | undefined;
  for (const item of items) {
    if ((item.status === 'resolved' && !options.showResolved) || !containsPosition(item.range, options.cursor)) { continue; }
    if (!best || compareCandidate(item, best) < 0) { best = item; }
  }
  return best;
}

export function groupHighlights(items: readonly HighlightInput[], options: HighlightOptions): HighlightGroups {
  const ordered = [...items].sort(compareOrder);
  const visible = (item: HighlightInput) => item.status === 'open' || options.showResolved;
  const active = selectActiveHighlight(items, options);

  const groups: HighlightGroups = { open: [], resolved: [], stale: [] };
  for (const item of ordered) {
    if (item === active || !visible(item)) { continue; }
    if (item.stale) { groups.stale.push(item); }
    else if (item.status === 'resolved') { groups.resolved.push(item); }
    else { groups.open.push(item); }
  }
  if (active) { groups.active = active; }
  return groups;
}
