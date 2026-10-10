import { comparePositions, Thread } from './model';

export interface WorkspaceThreads {
  name?: string;
  threads: readonly Thread[];
}

export interface MarkdownOptions {
  /** Short description of what was copied, for example "Open comments". */
  scope?: string;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sorted(threads: readonly Thread[]): Thread[] {
  return [...threads].sort((left, right) => {
    const byPath = compare(left.resource.path, right.resource.path);
    if (byPath !== 0) return byPath;
    if (left.anchor.kind !== right.anchor.kind) return left.anchor.kind === 'file' ? -1 : 1;
    if (left.anchor.kind === 'text' && right.anchor.kind === 'text') {
      const byRange = comparePositions(left.anchor.range.start, right.anchor.range.start)
        || comparePositions(left.anchor.range.end, right.anchor.range.end);
      if (byRange !== 0) return byRange;
    }
    return Date.parse(left.createdAt) - Date.parse(right.createdAt) || compare(left.id, right.id);
  });
}

/** Inline code that survives any backticks in paths, IDs, or tags. */
function code(value: string): string {
  const flat = value.replace(/[\r\n]+/g, ' ');
  let longest = 0;
  for (const match of flat.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(longest + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
}

function plain(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function fenced(value: string, language: string): string {
  let longest = 2;
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${value}${value.endsWith('\n') || value === '' ? '' : '\n'}${fence}`;
}

function quoted(value: string): string {
  return value.split(/\r\n|\r|\n/).map(line => (line ? `> ${line}` : '>')).join('\n');
}

const LANGUAGES: Record<string, string> = {
  tex: 'latex', sty: 'latex', cls: 'latex', ltx: 'latex', bib: 'bibtex', md: 'markdown', markdown: 'markdown',
  py: 'python', ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonl: 'json', cs: 'csharp', java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', go: 'go', rs: 'rust',
  r: 'r', rmd: 'markdown', qmd: 'markdown', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', sh: 'bash', bash: 'bash',
  ps1: 'powershell', html: 'html', htm: 'html', css: 'css', scss: 'scss', xml: 'xml', svg: 'xml', csv: 'csv', tsv: 'tsv',
  sql: 'sql', txt: 'text'
};

export function languageFor(path: string): string {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? 'text' : 'text';
}

/** Human-readable 1-based location. The stored end is exclusive, so its 0-based column is the last 1-based column. */
export function describeLocation(thread: Thread): string {
  if (thread.anchor.kind !== 'text') return 'Whole file (file-level comment, no text position)';
  const { start, end } = thread.anchor.range;
  const empty = comparePositions(start, end) === 0;
  // A selection ending at column 0 stops at the end of the previous line.
  const lastLine = end.character === 0 && end.line > start.line ? end.line : end.line + 1;
  if (empty) return `Line ${start.line + 1}`;
  if (lastLine === start.line + 1) {
    return end.character === 0 && end.line > start.line
      ? `Line ${start.line + 1} from column ${start.character + 1}`
      : `Line ${start.line + 1}, columns ${start.character + 1}–${end.character}`;
  }
  const endText = end.character === 0 && end.line > start.line ? 'end of line' : `column ${end.character}`;
  return `Lines ${start.line + 1}–${lastLine} (line ${start.line + 1} column ${start.character + 1} to line ${lastLine} ${endText})`;
}

function surrounding(before: string, snapshot: string, after: string): string | undefined {
  const head = before.split(/\r\n|\r|\n/);
  const tail = after.split(/\r\n|\r|\n/);
  const shownBefore = head.slice(-3);
  const shownAfter = tail.slice(0, 3);
  if (!shownBefore.join('').trim() && !shownAfter.join('').trim()) return undefined;
  // Short single-line selections stay inline so their exact position in the sentence is visible.
  const marker = !/[\r\n]/.test(snapshot) && snapshot.length <= 240
    ? `⟦${snapshot}⟧`
    : '⟦SELECTED TEXT — see above⟧';
  // Context is captured as a fixed number of characters, so it can start or end mid-line.
  const cutBefore = head.length > 3 || before.length >= 96;
  const cutAfter = tail.length > 3 || after.length >= 96;
  return `${cutBefore ? '…' : ''}${shownBefore.join('\n')}${marker}${shownAfter.join('\n')}${cutAfter ? '…' : ''}`;
}

function minute(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : `${parsed.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function renderThread(thread: Thread, label: string, output: string[]): void {
  const stale = thread.anchor.kind === 'text' && thread.anchor.stale;
  const flags = [thread.status === 'open' ? 'OPEN' : 'RESOLVED', ...(stale ? ['LOCATION UNVERIFIED'] : [])];
  output.push(`### ${label} · ${flags.join(' · ')} · ${describeLocation(thread)}`, '');
  const meta = [`Thread ${code(thread.id)}`];
  if (thread.tags.length) meta.push(`Tags: ${thread.tags.map(code).join(', ')}`);
  output.push(meta.join(' · '), '');
  if (thread.anchor.kind === 'text') {
    if (stale) {
      output.push('Note: the saved source could not be matched or verified. The quoted text is the saved excerpt; check the current file before relying on this location.', '');
    }
    const language = languageFor(thread.resource.path);
    output.push(thread.anchor.snapshot ? 'Saved source selection:' : 'Saved source selection: (empty line)', '');
    if (thread.anchor.snapshot) output.push(fenced(thread.anchor.snapshot, language), '');
    const context = surrounding(thread.anchor.before, thread.anchor.snapshot, thread.anchor.after);
    if (context) output.push('Saved surrounding context:', '', fenced(context, language), '');
  }
  output.push(thread.comments.length > 1 ? `Discussion (${thread.comments.length} comments, oldest first):` : 'Comment:', '');
  thread.comments.forEach((comment, index) => {
    const edited = comment.updatedAt !== comment.createdAt ? ', edited' : '';
    const role = index === 0 ? 'Comment' : `Reply ${index}`;
    output.push(`**${role} — ${plain(comment.author)} (${minute(comment.createdAt)}${edited})**`, '', quoted(comment.body), '');
  });
}

/** Readable review handoff grouped by workspace and file; numbered items can be referenced in follow-up work. */
export function formatMarkdownWorkspaces(groups: readonly WorkspaceThreads[], options: MarkdownOptions = {}): string {
  const all = groups.flatMap(group => group.threads);
  const open = all.filter(thread => thread.status === 'open').length;
  const resolved = all.length - open;
  const stale = all.filter(thread => thread.anchor.kind === 'text' && thread.anchor.stale).length;
  const output = ['# Review comments', ''];
  const summary = [`${all.length} thread${all.length === 1 ? '' : 's'}`, `${open} open`, `${resolved} resolved`];
  if (stale) summary.push(`${stale} with unverified source locations`);
  output.push(`${options.scope ? `${plain(options.scope)}: ` : ''}${summary.join(' · ')}`, '');
  const named = groups.filter(group => group.name !== undefined);
  if (groups.length === 1 && named.length === 1) output.push(`Workspace: ${code(named[0].name!)}`, '');
  output.push('How to read:',
    '- Items are grouped by file and ordered by position. Line and column numbers are 1-based.',
    '- "Saved source selection" is the text captured when the thread was created or explicitly reattached. "Saved surrounding context" is a short excerpt of nearby text; ⟦ ⟧ marks the selection or a placeholder for a long selection.',
    '- Each comment is quoted after its author; replies continue the same discussion in order.');
  if (resolved) output.push('- OPEN threads have not been marked resolved. RESOLVED threads are included for reference.');
  if (stale) output.push('- LOCATION UNVERIFIED means the saved source could not be matched or verified; check the current file using the quoted text rather than relying on line numbers.');
  output.push('');
  let counter = 0;
  for (const group of groups) {
    if (!group.threads.length) continue;
    if (groups.length > 1) output.push(`# Workspace ${code(group.name ?? '(unnamed)')}`, '');
    let currentPath: string | undefined;
    for (const thread of sorted(group.threads)) {
      if (thread.resource.path !== currentPath) {
        currentPath = thread.resource.path;
        const inFile = group.threads.filter(item => item.resource.path === currentPath);
        const openInFile = inFile.filter(item => item.status === 'open').length;
        output.push(`## File ${code(currentPath)} (${inFile.length} thread${inFile.length === 1 ? '' : 's'}, ${openInFile} open)`, '');
      }
      renderThread(thread, `R${++counter}`, output);
    }
  }
  if (!all.length) output.push('No review comments.');
  return `${output.join('\n').trimEnd()}\n`;
}

export function formatMarkdown(threads: readonly Thread[], workspaceName?: string, options: MarkdownOptions = {}): string {
  return formatMarkdownWorkspaces([{ name: workspaceName, threads }], options);
}

export function formatJson(threads: readonly Thread[], workspaceName?: string): string {
  const open = threads.filter(thread => thread.status === 'open').length;
  return `${JSON.stringify({
    schemaVersion: 1,
    kind: 'review-comments-export',
    workspace: workspaceName ?? null,
    summary: { total: threads.length, open, resolved: threads.length - open },
    conventions: {
      positions: 'zero-based line and UTF-16 character; range end is exclusive',
      snapshot: 'exact source text captured when the thread was created or explicitly reattached',
      stale: 'true when the saved source could not be matched or verified; the range may no longer match the snapshot'
    },
    threads: sorted(threads),
  }, null, 2)}\n`;
}
