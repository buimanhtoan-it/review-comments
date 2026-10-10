import { randomUUID } from 'node:crypto';

export const MAX_COMMENT_LENGTH = 100_000;

/** Submission limits; legacy stored comments remain readable even if larger. */
export function validateCommentBody(body: unknown): asserts body is string {
  if (typeof body !== 'string' || !body.trim()) throw new Error('Enter a comment before saving.');
  if (body.length > MAX_COMMENT_LENGTH) throw new Error(`Comments may contain at most ${MAX_COMMENT_LENGTH.toLocaleString()} characters.`);
}

export interface Position {
  line: number;
  character: number;
}

export interface TextAnchor {
  kind: 'text';
  range: { start: Position; end: Position };
  snapshot: string;
  before: string;
  after: string;
  stale: boolean;
}

export interface FileAnchor {
  kind: 'file';
}

export interface ReviewComment {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface Thread {
  schemaVersion: 1;
  kind: 'review-thread';
  id: string;
  revision: number;
  resource: { path: string };
  anchor: TextAnchor | FileAnchor;
  status: 'open' | 'resolved';
  comments: ReviewComment[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  [key: string]: unknown;
}

export const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\\s\\S])';
const uuidExpression = new RegExp(UUID_PATTERN, 'i');
const timestampExpression = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$(?![\s\S])/;

function invalid(message: string): never {
  throw new Error(`Invalid review thread: ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${label} must be an object.`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${label} must be a plain JSON object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, nonempty = false): asserts value is string {
  if (typeof value !== 'string' || (nonempty && value.trim().length === 0)) {
    invalid(`${label} must be ${nonempty ? 'a nonempty' : 'a'} string.`);
  }
}

export function assertThreadId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !uuidExpression.test(value)) {
    invalid('id must be a UUID with a supported version and variant.');
  }
}

export function assertRevision(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid('revision must be a nonnegative safe integer.');
  }
}

export function assertResourcePath(value: unknown): asserts value is string {
  string(value, 'resource.path', true);
  if (value.startsWith('/') || /[\\:\u0000-\u001f\u007f]/.test(value)
      || value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    invalid('resource.path must be a confined relative POSIX path without empty segments, traversal, drives, backslashes, or control characters.');
  }
}

export function comparePositions(left: Position, right: Position): number {
  return left.line - right.line || left.character - right.character;
}

function validatePosition(value: unknown, label: string): Position {
  const position = record(value, label);
  for (const key of ['line', 'character'] as const) {
    const coordinate = position[key];
    if (typeof coordinate !== 'number' || !Number.isSafeInteger(coordinate) || coordinate < 0) {
      invalid(`${label}.${key} must be a nonnegative safe integer.`);
    }
  }
  return position as unknown as Position;
}

function timestamp(value: unknown, label: string): void {
  string(value, label);
  const match = timestampExpression.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) {
    invalid(`${label} must be a valid RFC 3339 timestamp.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0)
      || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59
      || Number(match[7] ?? 0) > 23 || Number(match[8] ?? 0) > 59) {
    invalid(`${label} must be a valid RFC 3339 timestamp.`);
  }
}

/** Ensure extension fields survive JSON serialization without loss or side effects. */
function validateJson(value: unknown, label: string, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null) invalid(`${label} must contain only JSON values.`);
  if (ancestors.has(value)) invalid(`${label} must not contain cycles.`);
  if (!Array.isArray(value)) record(value, label);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) invalid(`${label} must not contain sparse arrays.`);
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (typeof key !== 'string') invalid(`${label} must not contain symbol properties.`);
    if (Array.isArray(value) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
      invalid(`${label} must not contain extra array properties.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      invalid(`${label}.${key} must be an enumerable JSON value, not an accessor.`);
    }
    validateJson(descriptor.value, `${label}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

/** Validate and return a detached copy, preserving all JSON-compatible extension fields. */
export function parseThread(value: unknown): Thread {
  const thread = record(value, 'thread');
  validateJson(thread, 'thread');
  if (thread.schemaVersion !== 1) invalid('unsupported schemaVersion; only schemaVersion 1 is supported.');
  if (thread.kind !== 'review-thread') invalid('kind must be review-thread.');
  assertThreadId(thread.id);
  assertRevision(thread.revision);
  assertResourcePath(record(thread.resource, 'resource').path);
  const anchor = record(thread.anchor, 'anchor');
  if (anchor.kind === 'text') {
    const range = record(anchor.range, 'anchor.range');
    const start = validatePosition(range.start, 'anchor.range.start');
    const end = validatePosition(range.end, 'anchor.range.end');
    if (comparePositions(start, end) > 0) invalid('anchor.range.end must not precede its start.');
    string(anchor.snapshot, 'anchor.snapshot');
    string(anchor.before, 'anchor.before');
    string(anchor.after, 'anchor.after');
    if (typeof anchor.stale !== 'boolean') invalid('anchor.stale must be a boolean.');
  } else if (anchor.kind !== 'file') {
    invalid('anchor.kind must be text or file.');
  }
  if (thread.status !== 'open' && thread.status !== 'resolved') invalid('status must be open or resolved.');
  if (!Array.isArray(thread.comments) || thread.comments.length === 0) invalid('comments must be a nonempty array.');
  const commentIds = new Set<string>();
  for (const [index, value] of thread.comments.entries()) {
    const comment = record(value, `comments[${index}]`);
    assertThreadId(comment.id);
    if (commentIds.has(comment.id.toLowerCase())) invalid('comment ids must be unique within a thread.');
    commentIds.add(comment.id.toLowerCase());
    string(comment.body, `comments[${index}].body`, true);
    string(comment.author, `comments[${index}].author`, true);
    timestamp(comment.createdAt, `comments[${index}].createdAt`);
    timestamp(comment.updatedAt, `comments[${index}].updatedAt`);
  }
  if (!Array.isArray(thread.tags)) invalid('tags must be an array of strings.');
  thread.tags.forEach((tag, index) => string(tag, `tags[${index}]`));
  timestamp(thread.createdAt, 'createdAt');
  timestamp(thread.updatedAt, 'updatedAt');
  record(thread.metadata, 'metadata');
  return JSON.parse(JSON.stringify(thread)) as Thread;
}

export function createThread(path: string, anchor: TextAnchor | FileAnchor, body: string, author: string): Thread {
  const now = new Date().toISOString();
  return parseThread({
    schemaVersion: 1,
    kind: 'review-thread',
    id: randomUUID(),
    revision: 0,
    resource: { path },
    anchor,
    status: 'open',
    comments: [{ id: randomUUID(), body, author, createdAt: now, updatedAt: now }],
    tags: [],
    createdAt: now,
    updatedAt: now,
    metadata: {},
  });
}
