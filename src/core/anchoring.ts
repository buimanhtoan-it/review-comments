import { comparePositions, Position, TextAnchor } from './model';

const CONTEXT_LENGTH = 96;

interface Line {
  start: number;
  end: number;
}

function lines(text: string): Line[] {
  const result: Line[] = [];
  const breaks = /\r\n|\r|\n/g;
  let start = 0;
  for (let match = breaks.exec(text); match !== null; match = breaks.exec(text)) {
    result.push({ start, end: match.index });
    start = match.index + match[0].length;
  }
  result.push({ start, end: text.length });
  return result;
}

function offset(position: Position, sourceLines: Line[]): number {
  if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character)
      || position.line < 0 || position.character < 0) {
    throw new Error('Source positions must be nonnegative UTF-16 integer coordinates.');
  }
  const line = sourceLines[position.line];
  if (line === undefined || position.character > line.end - line.start) {
    throw new Error('Source range is outside the document.');
  }
  return line.start + position.character;
}

function positionAt(index: number, sourceLines: Line[]): Position | undefined {
  let low = 0;
  let high = sourceLines.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const line = sourceLines[middle]!;
    if (index < line.start) high = middle - 1;
    else if (index > line.end) low = middle + 1;
    else return { line: middle, character: index - line.start };
  }
  return undefined;
}

export function createTextAnchor(text: string, range: { start: Position; end: Position }): TextAnchor {
  const sourceLines = lines(text);
  const start = offset(range.start, sourceLines);
  const end = offset(range.end, sourceLines);
  if (comparePositions(range.start, range.end) > 0) throw new Error('Source range end must not precede its start.');
  return {
    kind: 'text',
    range: { start: { ...range.start }, end: { ...range.end } },
    snapshot: text.slice(start, end),
    before: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    after: text.slice(end, end + CONTEXT_LENGTH),
    stale: false,
  };
}

function copy(anchor: TextAnchor, stale: boolean): TextAnchor {
  return { ...anchor, range: { ...anchor.range, start: { ...anchor.range.start }, end: { ...anchor.range.end } }, stale };
}

interface Occurrence {
  start: number;
  end: number;
  startPosition: Position;
  endPosition: Position;
}

export interface AnchorResolver {
  (anchor: TextAnchor): TextAnchor;
  diagnostics(): Readonly<{
    lineIndexBuilds: number;
    occurrenceScans: number;
    occurrenceCacheHits: number;
    cachedSnapshots: number;
    cachedOccurrences: number;
    cachedSnapshotCharacters: number;
  }>;
}

/** Prepare one immutable source generation; caches are bounded and never shared across sources. */
export function createAnchorResolver(text: string): AnchorResolver {
  const sourceLines = lines(text);
  const cache = new Map<string, Occurrence[]>();
  const maxSnapshots = 128;
  const maxOccurrences = 16_384;
  const maxSnapshotCharacters = 262_144;
  let cachedOccurrences = 0;
  let cachedSnapshotCharacters = 0;
  let occurrenceScans = 0;
  let occurrenceCacheHits = 0;

  function* occurrences(snapshot: string): IterableIterator<Occurrence> {
    const cached = cache.get(snapshot);
    if (cached !== undefined) {
      occurrenceCacheHits++;
      cache.delete(snapshot);
      cache.set(snapshot, cached);
      yield* cached;
      return;
    }
    occurrenceScans++;
    let collected: Occurrence[] | undefined = snapshot.length <= maxSnapshotCharacters ? [] : undefined;
    for (let start = text.indexOf(snapshot); start >= 0 && start <= text.length;) {
      const end = start + snapshot.length;
      const startPosition = positionAt(start, sourceLines);
      const endPosition = positionAt(end, sourceLines);
      if (startPosition !== undefined && endPosition !== undefined) {
        const occurrence = { start, end, startPosition, endPosition };
        if (collected !== undefined) {
          if (collected.length < maxOccurrences) collected.push(occurrence);
          else collected = undefined; // Stream very common/empty excerpts instead of retaining them.
        }
        yield occurrence;
      }
      if (start === text.length) break;
      start = text.indexOf(snapshot, start + 1);
    }
    if (collected !== undefined) {
      while (cache.size >= maxSnapshots || cachedOccurrences + collected.length > maxOccurrences
          || cachedSnapshotCharacters + snapshot.length > maxSnapshotCharacters) {
        const oldest = cache.keys().next().value!;
        cachedOccurrences -= cache.get(oldest)!.length;
        cachedSnapshotCharacters -= oldest.length;
        cache.delete(oldest);
      }
      cache.set(snapshot, collected);
      cachedOccurrences += collected.length;
      cachedSnapshotCharacters += snapshot.length;
    }
  }

  function located(anchor: TextAnchor, start: Position, end: Position): TextAnchor {
    return {
      ...copy(anchor, false),
      range: { ...anchor.range, start: { ...anchor.range.start, ...start }, end: { ...anchor.range.end, ...end } },
    };
  }

  const resolve = ((anchor: TextAnchor): TextAnchor => {
    const snapshot = anchor.snapshot;
    if (snapshot.length === 0 && anchor.before.length === 0 && anchor.after.length === 0) {
      return text.length === 0
        ? located(anchor, { line: 0, character: 0 }, { line: 0, character: 0 })
        : copy(anchor, true);
    }
    let count = 0;
    let singleContext = 0;
    let bestContext = -1;
    let bestCount = 0;
    let best: Occurrence | undefined;
    for (const occurrence of occurrences(snapshot)) {
      const { start, end } = occurrence;
      const beforeMatches = anchor.before.length > 0
        ? text.slice(Math.max(0, start - anchor.before.length), start) === anchor.before
        : start === 0;
      const afterMatches = anchor.after.length > 0
        ? text.slice(end, end + anchor.after.length) === anchor.after
        : end === text.length;
      // A zero-width selection has no source identity, so both contexts must agree.
      if (snapshot.length === 0 && !(beforeMatches && afterMatches)) continue;
      count++;
      singleContext = Number(beforeMatches) + Number(afterMatches);
      const sourceContext = Number(anchor.before.length > 0 && beforeMatches) + Number(anchor.after.length > 0 && afterMatches);
      if (sourceContext > bestContext) {
        bestContext = sourceContext;
        bestCount = 1;
        best = occurrence;
      } else if (sourceContext === bestContext) {
        bestCount++;
      }
    }
    // A document boundary is a location, not source identity: it cannot resolve duplicates.
    const matched = count === 1 ? singleContext > 0 : bestContext > 0 && bestCount === 1;
    return matched && best !== undefined ? located(anchor, best.startPosition, best.endPosition) : copy(anchor, true);
  }) as AnchorResolver;
  resolve.diagnostics = () => Object.freeze({
    lineIndexBuilds: 1, occurrenceScans, occurrenceCacheHits,
    cachedSnapshots: cache.size, cachedOccurrences, cachedSnapshotCharacters,
  });
  return resolve;
}

/** Exact snapshots are immutable; coordinates alone never break a repeated-source tie. */
export function relocateAnchor(anchor: TextAnchor, text: string): TextAnchor {
  return createAnchorResolver(text)(anchor);
}
