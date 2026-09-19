/**
 * Agent Skills: discovery, validation and progressive disclosure.
 *
 * The format is the cross-tool one (`SKILL.md` + YAML frontmatter), specified at
 * agentskills.io — Claude Code, Codex, Cursor, Gemini CLI, Goose and others read the same
 * directory, so there is one format to implement rather than an adapter per tool.
 *
 * Two decisions here are deliberate and worth stating, because both are places where the
 * obvious implementation would be wrong:
 *
 * 1. **Unknown frontmatter keys are kept, not rejected.** The spec defines six fields, but real
 *    skills in the wild carry more — the ones installed on this machine use `agent_created` and
 *    `version`, neither of which is in the spec. A validator that refuses them would reject
 *    working skills from other tools, which is the opposite of "compatible with the ecosystem".
 *    The spec's `metadata` map is the sanctioned home for extras; it is not where real tools
 *    actually put them.
 *
 * 2. **`allowed-tools` is surfaced as text and never acted on.** The spec marks the field
 *    experimental, and it means "tools this skill may use without asking". Honouring it would
 *    hand a third-party skill directory the power to pre-approve execution — exactly the bypass
 *    the project's own requirement T27 forbids. It is reported so a human can read it; it
 *    changes no policy.
 *
 * Nothing in this module executes anything. `scripts/` is a read-only directory of files: a
 * skill can describe a command, it cannot run one, and it cannot authorise one.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Read flags that refuse to open through a final-component link. O_NOFOLLOW does not exist on
 * Windows, so it is dropped there — the same compromise the workspace-tools reads make.
 */
const OPEN_NOFOLLOW = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);

export const SKILL_FILENAME = 'SKILL.md';
/** Bounds. A skill is meant to be small and human-authored; these stop a hostile one being a wedge. */
export const SKILL_MAX_FILE_BYTES = 512 * 1024;
export const SKILL_MAX_BODY_BYTES = 256 * 1024;
export const SKILL_MAX_FILES = 200;
export const SKILL_MAX_SKILLS = 128;

export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  /** Reported for a human to read. Never consulted when deciding what a caller may do. */
  'allowed-tools'?: string;
  /** Everything the spec does not define. Preserved so other tools' fields survive a round trip. */
  extra: Record<string, string>;
}

export interface SkillRecord {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  'allowed-tools'?: string;
  extra: Record<string, string>;
  /** Absolute path of the skill directory. Never handed to a remote caller. */
  directory: string;
  /** Which configured root it came from, by index, for shadowing diagnostics. */
  root_index: number;
  /** Relative paths inside the skill directory, bounded and symlink-free. */
  files: string[];
}

export interface SkillProblem {
  directory: string;
  reason: string;
}

/** A single scalar, honouring quoting so `description: "a: b"` is not split on the colon. */
function scalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = value.slice(1, -1);
      return first === '"' ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"') : inner.replace(/''/g, "'");
    }
  }
  return value;
}

/**
 * Parses the subset of YAML that skill frontmatter actually uses: scalars (bare or quoted), one
 * level of nested mapping (for `metadata`), and `|` / `>` block scalars, which long descriptions
 * commonly use.
 *
 * It is not a YAML parser and does not try to be. Anything it cannot represent is reported as a
 * problem rather than guessed at, so a malformed skill fails loudly instead of being read as a
 * skill with an empty description.
 */
export function parseFrontmatter(text: string): { fields: Record<string, string>; nested: Record<string, Record<string, string>>; body: string; error?: string } {
  const normalised = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalised.startsWith('---\n') && normalised.trimStart().startsWith('---')) {
    // Tolerate a leading blank line before the fence. The recursion must only happen when the
    // trim actually removed something: when there is no leading whitespace to strip ('---',
    // '--- junk'), recursing on the identical string would loop until the stack overflows. When
    // nothing was trimmed, fall through to the missing-frontmatter error instead.
    const trimmed = normalised.replace(/^\s+/, '');
    if (trimmed.length < normalised.length) return parseFrontmatter(trimmed);
  }
  if (!normalised.startsWith('---\n')) return { fields: {}, nested: {}, body: normalised, error: 'missing YAML frontmatter: the file must start with a --- line' };
  const end = normalised.indexOf('\n---', 3);
  if (end === -1) return { fields: {}, nested: {}, body: '', error: 'unterminated YAML frontmatter: no closing --- line' };

  const block = normalised.slice(4, end);
  const body = normalised.slice(end + 4).replace(/^\n+/, '');
  const fields: Record<string, string> = {};
  const nested: Record<string, Record<string, string>> = {};
  const lines = block.split('\n');

  let currentParent: string | null = null;
  let blockKey: string | null = null;
  let blockMode: '|' | '>' | null = null;
  let blockIndent = 0;
  let blockLines: string[] = [];

  const flushBlock = () => {
    if (blockKey === null) return;
    const joined = blockMode === '|' ? blockLines.join('\n') : blockLines.join(' ').replace(/\s+/g, ' ');
    if (currentParent) nested[currentParent]![blockKey] = joined;
    else fields[blockKey] = joined;
    blockKey = null; blockMode = null; blockLines = [];
  };

  for (const [index, line] of lines.entries()) {
    if (blockMode) {
      const indent = line.length - line.trimStart().length;
      if (line.trim() === '') { blockLines.push(''); continue; }
      if (indent >= blockIndent) { blockLines.push(line.slice(blockIndent)); continue; }
      flushBlock();
    }
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    const match = /^([A-Za-z0-9_.-]+):(.*)$/.exec(line.trim());
    if (!match) {
      // A continuation line for a plain multi-line scalar. Rare, but real skills use it.
      if (currentParent && Object.keys(nested[currentParent] ?? {}).length) {
        const entries = Object.entries(nested[currentParent]!);
        const [key, value] = entries[entries.length - 1]!;
        nested[currentParent]![key] = `${value} ${line.trim()}`.trim();
        continue;
      }
      return { fields, nested, body, error: `unparsable frontmatter line: ${JSON.stringify(line.slice(0, 80))}` };
    }
    const key = match[1]!;
    const rest = match[2] ?? '';

    if (indent > 0) {
      if (!currentParent) return { fields, nested, body, error: `indented key "${key}" has no parent mapping` };
      nested[currentParent]![key] = scalar(rest);
      continue;
    }

    // Block scalars, with YAML's optional chomping suffix (`|-`, `>-`, `|+`, `>+`). The suffix is
    // accepted but not distinguished: all three forms are read with trailing newlines stripped,
    // because the fields that use block scalars here are single-line descriptions, and a stray
    // trailing newline would count against the 1024-character limit for no benefit. Matching only
    // the bare `|`/`>` — which is what this did first — silently turns `description: >-` into the
    // literal two-character string ">-", which is worse than failing.
    const blockIndicator = /^([|>])([-+]?)$/.exec(rest.trim());
    if (blockIndicator) {
      currentParent = null;
      blockKey = key; blockMode = blockIndicator[1] as '|' | '>'; blockIndent = -1; blockLines = [];
      // The block's indentation is taken from its first non-empty line. The current loop index
      // anchors the scan: lines.indexOf(line) would find the FIRST occurrence of the header, so
      // a duplicated line earlier in the frontmatter would read the wrong block's indentation.
      for (const candidate of lines.slice(index + 1)) {
        if (candidate.trim() === '') continue;
        blockIndent = candidate.length - candidate.trimStart().length;
        break;
      }
      if (blockIndent < 0) blockIndent = 0;
      continue;
    }

    if (rest.trim() === '') {
      // A nested mapping follows, or an empty value.
      currentParent = key;
      nested[key] = {};
      continue;
    }

    currentParent = null;
    fields[key] = scalar(rest);
  }
  flushBlock();

  // Drop empty nested maps (a key written with no children is an empty value, not a mapping).
  for (const [key, value] of Object.entries(nested)) {
    if (Object.keys(value).length === 0) { delete nested[key]; if (!(key in fields)) fields[key] = ''; }
  }
  return { fields, nested, body };
}

/**
 * The spec's name rules. Returned as a list of problems rather than thrown, so a validation
 * report can show every fault at once instead of one per fix-and-retry cycle.
 */
export function nameProblems(name: string, directoryName: string): string[] {
  const problems: string[] = [];
  if (!name) problems.push('name is required');
  else {
    if (name.length > 64) problems.push(`name is ${name.length} characters; the limit is 64`);
    if (!/^[a-z0-9-]+$/.test(name)) problems.push('name may only contain lowercase letters, digits and hyphens');
    if (name.startsWith('-') || name.endsWith('-')) problems.push('name must not start or end with a hyphen');
    if (name.includes('--')) problems.push('name must not contain consecutive hyphens');
    if (name !== directoryName) problems.push(`name "${name}" must match its directory name "${directoryName}"`);
  }
  return problems;
}

export interface ParsedSkill { record: SkillRecord; problems: string[] }

/**
 * Opens a path so the check and the read are the same open — the lstat-then-read pair has a
 * window in which the path can be swapped for a link, so the open itself refuses links
 * (O_NOFOLLOW where it exists) and the buffer comes through the file handle. Mirrors the
 * workspace-tools readBytes pattern. Throws when the file exceeds the cap; truncates safely when
 * it is within the cap but grew between stat and read.
 */
async function readNoFollow(file: string, cap: number): Promise<{ buffer: Buffer; truncated: boolean }> {
  const handle = await fs.open(file, OPEN_NOFOLLOW);
  try {
    // The stat is on the opened file, not on the path, so a swap of the path between open and
    // stat cannot change what is being measured.
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.size > cap) throw new Error(`file exceeds ${cap} bytes`);
    // stat.size came from this same handle, so readFile(handle) can only exceed the cap if the
    // file grew mid-read; the subarray keeps the answer inside the budget in that case.
    const buffer = await handle.readFile();
    return { buffer: buffer.subarray(0, cap), truncated: buffer.length > cap };
  } finally {
    await handle.close();
  }
}

/** Reads one skill directory. Never follows a symlink, in either the directory or its files. */
export async function readSkillDirectory(directory: string, rootIndex: number): Promise<{ skill?: ParsedSkill; problem?: SkillProblem }> {
  const directoryName = path.basename(directory);
  let skillFile: string;
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { problem: { directory, reason: 'not a real directory (missing or a link)' } };
    skillFile = path.join(directory, SKILL_FILENAME);
    const fileStat = await fs.lstat(skillFile);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return { problem: { directory, reason: `${SKILL_FILENAME} is missing or is a link` } };
    if (fileStat.size > SKILL_MAX_FILE_BYTES) return { problem: { directory, reason: `${SKILL_FILENAME} is ${fileStat.size} bytes; the limit is ${SKILL_MAX_FILE_BYTES}` } };
  } catch (error) {
    return { problem: { directory, reason: `unreadable: ${error instanceof Error ? error.message : String(error)}` } };
  }

  const parsed = parseFrontmatter(await fs.readFile(skillFile, 'utf8'));
  const problems: string[] = [];
  if (parsed.error) problems.push(parsed.error);
  const name = parsed.fields.name ?? '';
  const description = parsed.fields.description ?? '';
  problems.push(...nameProblems(name, directoryName));
  if (!description) problems.push('description is required');
  else if (description.length > 1024) problems.push(`description is ${description.length} characters; the limit is 1024`);
  const compatibility = parsed.fields.compatibility;
  if (compatibility !== undefined && compatibility.length > 500) problems.push(`compatibility is ${compatibility.length} characters; the limit is 500`);

  // Every key the spec does not define, preserved verbatim.
  const known = new Set(['name', 'description', 'license', 'compatibility', 'metadata']);
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.fields)) if (!known.has(key)) extra[key] = value;

  const record: SkillRecord = {
    name: name || directoryName,
    description,
    ...(parsed.fields.license === undefined ? {} : { license: parsed.fields.license }),
    ...(compatibility === undefined ? {} : { compatibility }),
    ...(parsed.nested.metadata ? { metadata: parsed.nested.metadata } : {}),
    ...(parsed.fields['allowed-tools'] === undefined ? {} : { 'allowed-tools': parsed.fields['allowed-tools'] }),
    extra,
    directory,
    root_index: rootIndex,
    files: await listFiles(directory),
  };
  return { skill: { record, problems }, ...(problems.length ? {} : {}) };
}

/**
 * Relative file paths inside a skill, depth-first, bounded, skipping links.
 *
 * Links are skipped rather than resolved because a skill directory is untrusted input: a link
 * pointing at `C:\Users\...` would otherwise turn "read this skill's assets" into a read of
 * anything on the machine, which is a wider grant than mounting a skills root implies.
 *
 * The two guards below (the explicit `isSymbolicLink()` skip and the `isFile()` test) are
 * deliberately redundant — a link is neither a directory nor a regular file, so either one alone
 * keeps it out. That redundancy is the point, and it is also why the mutation test for this has to
 * remove both at once: breaking one changes no observable behaviour, so a single-guard mutation
 * would look like a hole in the probe when it is really a second line of defence working.
 */
async function listFiles(root: string, prefix = '', budget = { remaining: SKILL_MAX_FILES }): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try { entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (budget.remaining <= 0) break;
    if (entry.isSymbolicLink()) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { out.push(...await listFiles(root, relative, budget)); continue; }
    if (!entry.isFile()) continue;
    budget.remaining--;
    out.push(relative);
  }
  return out;
}

export interface SkillListing {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  'allowed-tools'?: string;
  extra: Record<string, string>;
  file_count: number;
}

/**
 * Progressive disclosure, enforced by shape rather than by convention.
 *
 * `list()` returns metadata only — the spec's first stage is ~100 tokens per skill and exists so
 * an agent can decide *whether* to open a skill without paying for its body. A listing that
 * included bodies would silently defeat that, and no caller could tell it had happened, so the
 * body is not a field this type can even carry.
 */
export function toListing(skill: SkillRecord): SkillListing {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.license === undefined ? {} : { license: skill.license }),
    ...(skill.compatibility === undefined ? {} : { compatibility: skill.compatibility }),
    ...(skill.metadata === undefined ? {} : { metadata: skill.metadata }),
    ...(skill['allowed-tools'] === undefined ? {} : { 'allowed-tools': skill['allowed-tools'] }),
    extra: skill.extra,
    file_count: skill.files.length,
  };
}

export class SkillRegistry {  private skills = new Map<string, ParsedSkill>();
  private problems: SkillProblem[] = [];
  private shadowed: { name: string; directory: string; shadowed_by: string }[] = [];

  constructor(readonly roots: string[]) {}

  get problemsList(): SkillProblem[] { return this.problems; }
  get shadowedList(): { name: string; directory: string; shadowed_by: string }[] { return this.shadowed; }
  get size(): number { return this.skills.size; }

  /**
   * Scans every root. Later roots do not overwrite earlier ones: the first root that defines a
   * name wins and the shadowed copy is reported, because a silent override would make "which
   * skill is actually loaded" unanswerable from the outside.
   */
  async discover(): Promise<void> {
    this.skills = new Map(); this.problems = []; this.shadowed = [];
    for (const [rootIndex, root] of this.roots.entries()) {
      let entries;
      try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        // Dot-directories are not skills. This is what keeps an install that is still being
        // copied — which lands under a dot-prefixed temporary name and is renamed into place only
        // once it is complete — from being discovered half-written.
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        if (this.skills.size >= SKILL_MAX_SKILLS) { this.problems.push({ directory: path.join(root, entry.name), reason: `skill limit (${SKILL_MAX_SKILLS}) reached` }); continue; }
        const result = await readSkillDirectory(path.join(root, entry.name), rootIndex);
        if (result.problem) { this.problems.push(result.problem); continue; }
        const parsed = result.skill!;
        // A skill with spec violations is reported and skipped: loading it anyway would make the
        // report decorative, and a wrong `name` is what callers use to address it.
        if (parsed.problems.length) { this.problems.push({ directory: parsed.record.directory, reason: parsed.problems.join('; ') }); continue; }
        const existing = this.skills.get(parsed.record.name);
        if (existing) { this.shadowed.push({ name: parsed.record.name, directory: parsed.record.directory, shadowed_by: existing.record.directory }); continue; }
        this.skills.set(parsed.record.name, parsed);
      }
    }
  }

  list(): SkillListing[] {
    return [...this.skills.values()].map((entry) => toListing(entry.record));
  }

  names(): string[] { return [...this.skills.keys()].sort(); }

  /** The skill's own directory. Used by the operator UI and by the probe, not by remote callers. */
  directoryOf(name: string): string | undefined { return this.skills.get(name)?.record.directory; }

  /**
   * The second stage of progressive disclosure: the full body, plus the file inventory so the
   * caller can decide what to open next without a second listing round trip.
   */
  async read(name: string): Promise<{ skill: SkillListing; body: string; files: string[]; truncated: boolean } | null> {
    const entry = this.skills.get(name);
    if (!entry) return null;
    // Re-read with the same discipline as discovery: the directory can have been tampered with
    // since discover() ran, so the size cap is enforced before reading and the open refuses a
    // link swapped in for SKILL.md. A tampered or unreadable file is reported as missing rather
    // than served or thrown.
    let text: string;
    try {
      text = (await readNoFollow(path.join(entry.record.directory, SKILL_FILENAME), SKILL_MAX_FILE_BYTES)).buffer.toString('utf8');
    } catch {
      return null;
    }
    const parsed = parseFrontmatter(text);
    const body = parsed.body;
    const truncated = Buffer.byteLength(body, 'utf8') > SKILL_MAX_BODY_BYTES;
    return {
      skill: toListing(entry.record),
      body: truncated ? Buffer.from(body, 'utf8').subarray(0, SKILL_MAX_BODY_BYTES).toString('utf8') : body,
      files: entry.record.files,
      truncated,
    };
  }

  /**
   * Reads a file inside a skill directory. The path is resolved and then checked to still be
   * inside that directory, so `../../` and absolute paths cannot escape — the containment test is
   * on the resolved result, not on the input string.
   */
  async readFile(name: string, relative: string): Promise<{ path: string; text: string; truncated: boolean } | null> {
    const entry = this.skills.get(name);
    if (!entry) return null;
    if (!relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) return null;
    const target = path.resolve(entry.record.directory, relative);
    const base = path.resolve(entry.record.directory);
    if (target !== base && !target.startsWith(base + path.sep)) return null;
    if (!entry.record.files.includes(relative.split(path.sep).join('/'))) return null;
    // The open itself refuses a link and the read goes through the handle, so a concurrent
    // swap between check and read cannot redirect the read outside the skill tree — the
    // lstat-then-read pair this replaces had that window.
    let read: { buffer: Buffer; truncated: boolean };
    try {
      read = await readNoFollow(target, SKILL_MAX_FILE_BYTES);
    } catch {
      return null;
    }
    return { path: relative.split(path.sep).join('/'), text: read.buffer.toString('utf8'), truncated: read.truncated };
  }
}

/**
 * Installing a skill is installing *instructions an agent will follow*, so the rules here are
 * about refusing early and refusing loudly rather than about convenience:
 *
 * - **Validated before anything is written.** A source that fails the spec check is refused and
 *   the skills root is untouched. Copying first and validating afterwards would leave a broken
 *   directory behind on every rejected attempt, and a broken directory is a directory some later
 *   scan has to explain.
 * - **Links are refused, not skipped.** A skill containing a link is not the same skill once the
 *   link is dropped, and silently installing a different thing from what the operator pointed at
 *   is worse than declining. It also removes any question of a link escaping the source tree
 *   mid-copy.
 * - **Never overwrites.** An existing skill with the same name is an explicit conflict for the
 *   operator to resolve; quietly replacing the instructions an agent is already following is not
 *   something an install button should be able to do.
 * - **Lands atomically.** The copy goes to a dot-prefixed temporary directory in the same root and
 *   is renamed into place at the end, so a scan never sees a half-copied skill.
 */
export interface InstallOutcome {
  ok: boolean;
  name?: string;
  files?: number;
  reason?: string;
}

/** Recursively copies a validated skill. Refuses links; the caller has already checked the source. */
async function copyTree(from: string, to: string, budget = { remaining: SKILL_MAX_FILES }): Promise<number> {
  await fs.mkdir(to, { recursive: true });
  let copied = 0;
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`contains a link: ${entry.name}`);
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) { copied += await copyTree(source, target, budget); continue; }
    if (!entry.isFile()) throw new Error(`contains something that is not a file: ${entry.name}`);
    if (budget.remaining-- <= 0) throw new Error(`more than ${SKILL_MAX_FILES} files`);
    // The lstat/copyFile pair this replaces could be redirected by a link swapped in between the
    // two calls; opening O_NOFOLLOW and copying through the handle makes the check and the read
    // the same open. The size cap is enforced inside readNoFollow, before the read.
    let buffer: Buffer;
    try {
      ({ buffer } = await readNoFollow(source, SKILL_MAX_FILE_BYTES));
    } catch (error) {
      throw new Error(`cannot copy ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await fs.writeFile(target, buffer);
    copied++;
  }
  return copied;
}

/** Where a skill of this name would live, asserting the result is a direct child of the root. */
function skillDestination(root: string, name: string): string | null {
  const base = path.resolve(root);
  const target = path.resolve(base, name);
  if (path.dirname(target) !== base) return null;
  return target;
}

export async function installSkillFromDirectory(source: string, root: string): Promise<InstallOutcome> {
  const sourcePath = path.resolve(source);
  const parsed = await readSkillDirectory(sourcePath, 0);
  if (parsed.problem) return { ok: false, reason: parsed.problem.reason };
  const skill = parsed.skill!;
  // A source with spec violations is refused here rather than being installed and then reported as
  // invalid by the next scan: the operator asked to install a skill, and this is not one.
  if (skill.problems.length) return { ok: false, reason: skill.problems.join('; ') };

  const destination = skillDestination(root, skill.record.name);
  if (!destination) return { ok: false, reason: `refusing to install outside the skills root: ${skill.record.name}` };
  if (await fs.lstat(destination).then(() => true).catch(() => false)) return { ok: false, reason: `a skill named "${skill.record.name}" is already installed` };

  // The staging suffix is random, not time-based: Date.now() collides for two installs started
  // in the same millisecond, and a shared staging directory would interleave their files.
  const staging = path.join(path.resolve(root), `.installing-${skill.record.name}-${randomBytes(6).toString('hex')}`);
  await fs.mkdir(path.resolve(root), { recursive: true });
  try {
    const files = await copyTree(sourcePath, staging);
    try {
      await fs.rename(staging, destination);
    } catch (error) {
      // The pre-check above is a TOCTOU hint only — the rename is the authoritative conflict
      // point, so a skill that appeared after the check (or a destination with anything in it)
      // fails here with the conflict the operator actually has to resolve.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM') {
        throw new Error(`a skill named "${skill.record.name}" is already installed`);
      }
      throw error;
    }
    return { ok: true, name: skill.record.name, files };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Removes an installed skill. Deliberately narrow: only a direct child of the root, resolved and
 * re-checked, and never a link — so a name that came from somewhere unexpected cannot turn this
 * into a delete of an arbitrary directory.
 */
export async function removeSkill(root: string, name: string): Promise<{ ok: boolean; reason?: string }> {
  const destination = skillDestination(root, name);
  if (!destination) return { ok: false, reason: `not a skill in this root: ${name}` };
  const stat = await fs.lstat(destination).catch(() => null);
  if (!stat) return { ok: false, reason: `not installed: ${name}` };
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, reason: `refusing to remove something that is not a real directory: ${name}` };
  if (!(await fs.lstat(path.join(destination, SKILL_FILENAME)).then(() => true).catch(() => false))) {
    return { ok: false, reason: `refusing to remove a directory that is not a skill: ${name}` };
  }
  await fs.rm(destination, { recursive: true, force: true });
  return { ok: true };
}
