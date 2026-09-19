#!/usr/bin/env node
/**
 * Agent Skills: format conformance, progressive disclosure, and the read-only boundary.
 *
 * Every assertion below is tied to a decision that a plausible implementation could get wrong,
 * and the probe is expected to fail when that decision is undone:
 *
 *   - listing carries no body          -> fails if `list()` is made to include SKILL.md text
 *   - unknown frontmatter keys survive -> fails if the parser rejects or drops them
 *   - name must equal the directory    -> fails if validation is relaxed
 *   - links are not followed           -> fails if the scan resolves symlinks
 *   - `file` cannot escape the skill   -> fails if containment is checked on the input string
 *   - `allowed-tools` grants nothing   -> fails if it is ever wired into authorisation
 *
 * The last one is checked structurally, by reading the sources: there is no runtime value to
 * assert on, because the guarantee *is* that nothing consumes the field.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillRegistry, parseFrontmatter, nameProblems, installSkillFromDirectory, removeSkill, SKILL_FILENAME } from '../dist/packages/skills/src/index.js';
import { capabilities, ConfigSchema } from '../dist/apps/daemon/src/server.js';
import { ToolSchemas, ToolDescriptions } from '../dist/apps/daemon/src/tools.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A per-process sandbox, so the probe never has to delete anything before it starts. An earlier
// version removed a fixed directory up front and the whole probe died when the host's file-deletion
// helper timed out — the check failed for a reason that had nothing to do with skills. Cleanup is
// best effort for the same reason: tidying up must never be what turns a passing probe red.
const sandbox = path.join(root, 'outputs', 'skills-probe', String(process.pid));
const results = [];
const check = (name, condition, detail) => { results.push({ name, passed: !!condition, detail }); };
const cleanup = () => { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ } };
process.on('exit', cleanup);

const primary = path.join(sandbox, 'skills');
const secondary = path.join(sandbox, 'extra');
fs.mkdirSync(primary, { recursive: true });
fs.mkdirSync(secondary, { recursive: true });

const writeSkill = (base, dir, content) => {
  fs.mkdirSync(path.join(base, dir), { recursive: true });
  fs.writeFileSync(path.join(base, dir, SKILL_FILENAME), content, 'utf8');
  return path.join(base, dir);
};

// --- fixtures --------------------------------------------------------------------------------

const validDir = writeSkill(primary, 'pdf-tools', [
  '---',
  'name: pdf-tools',
  'description: Extract text and tables from PDF files. Use when the user mentions PDFs or document extraction.',
  'license: MIT',
  'compatibility: Requires python3',
  'metadata:',
  '  author: example-org',
  '  version: "1.0"',
  '---',
  '',
  '# PDF tools',
  '',
  'BODY_SENTINEL_DO_NOT_LEAK',
  '',
  'Run `scripts/extract.py` to pull the text out.',
].join('\n'));
fs.mkdirSync(path.join(validDir, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(validDir, 'scripts', 'extract.py'), 'print("hi")\n', 'utf8');
fs.mkdirSync(path.join(validDir, 'references'), { recursive: true });
fs.writeFileSync(path.join(validDir, 'references', 'REFERENCE.md'), '# Reference\n', 'utf8');

// Real skills in the wild carry keys the spec does not define. Rejecting them would reject
// working skills from other tools, which is the opposite of ecosystem compatibility.
writeSkill(primary, 'legacy-shaped', [
  '---',
  'name: legacy-shaped',
  'description: A skill shaped like the ones already installed on this machine.',
  'agent_created: true',
  'version: "2.1"',
  '---',
  'body',
].join('\n'));

writeSkill(primary, 'declares-tools', [
  '---',
  'name: declares-tools',
  'description: Declares pre-approved tools, which this bridge reports but never honours.',
  'allowed-tools: Bash(git:*) Read Write',
  '---',
  'body',
].join('\n'));

// Each of these must be rejected, and the reason must reach the caller.
writeSkill(primary, 'mismatched-name', ['---', 'name: something-else', 'description: Name does not match its directory.', '---', 'body'].join('\n'));
writeSkill(primary, 'Bad-Caps', ['---', 'name: Bad-Caps', 'description: Uppercase is not allowed in a skill name.', '---', 'body'].join('\n'));
writeSkill(primary, 'double--hyphen', ['---', 'name: double--hyphen', 'description: Consecutive hyphens are not allowed.', '---', 'body'].join('\n'));
writeSkill(primary, 'no-description', ['---', 'name: no-description', '---', 'body'].join('\n'));
writeSkill(primary, 'no-frontmatter', '# Just markdown, no frontmatter at all\n');
writeSkill(primary, 'too-long', ['---', 'name: too-long', `description: ${'x'.repeat(1025)}`, '---', 'body'].join('\n'));

// Same name in a second root: the first root wins and the shadowed copy is reported, so "which
// skill is actually loaded" stays answerable from outside.
writeSkill(secondary, 'pdf-tools', ['---', 'name: pdf-tools', 'description: A second copy that must not silently win.', '---', 'body'].join('\n'));

// A link pointing outside the root. Following it would turn "read this skill" into a read of
// anything on the machine. A directory junction is used rather than a file symlink because
// junctions can be created on Windows without elevation, and the point of this fixture is that it
// must always exist: an assertion that quietly skips itself when its fixture is missing is not an
// assertion, and the first version of this probe had exactly that hole (a mutation that made the
// scan follow links was reported as "missed" because the fixture had silently failed to appear).
const outsideDir = path.join(sandbox, 'outside');
fs.mkdirSync(outsideDir, { recursive: true });
fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'SECRET_OUTSIDE_THE_SKILLS_ROOT\n', 'utf8');
const linkedDir = writeSkill(primary, 'linked-escape', ['---', 'name: linked-escape', 'description: Contains a link that points outside the skills root.', '---', 'body'].join('\n'));
let linkCreated = false;
try { fs.symlinkSync(outsideDir, path.join(linkedDir, 'escape-link'), 'junction'); linkCreated = true; } catch { /* reported below */ }
check('the link fixture could be created (this check must not be skippable)', linkCreated);

// --- parser ----------------------------------------------------------------------------------

const quoted = parseFrontmatter(['---', 'name: q', 'description: "has: a colon and a \\"quote\\""', 'metadata:', '  k: v', '---', 'body'].join('\n'));
check('a quoted scalar keeps its colon instead of splitting on it', quoted.fields.description === 'has: a colon and a "quote"', quoted.fields.description);
check('nested metadata is parsed as a mapping', quoted.nested.metadata?.k === 'v', JSON.stringify(quoted.nested.metadata));

const folded = parseFrontmatter(['---', 'name: f', 'description: >-', '  one line', '  and another', '---', 'body'].join('\n'));
check('a folded block scalar is joined', folded.fields.description === 'one line and another', JSON.stringify(folded.fields.description));

const literal = parseFrontmatter(['---', 'name: l', 'description: |', '  line one', '  line two', '---', 'body'].join('\n'));
check('a literal block scalar keeps its newlines', literal.fields.description === 'line one\nline two', JSON.stringify(literal.fields.description));

const noFence = parseFrontmatter('# no frontmatter\n');
check('missing frontmatter is reported, not guessed at', typeof noFence.error === 'string' && noFence.error.includes('frontmatter'), noFence.error);

check('name rules reject a directory mismatch', nameProblems('a', 'b').some((p) => p.includes('directory name')));
check('name rules reject consecutive hyphens', nameProblems('a--b', 'a--b').some((p) => p.includes('consecutive')));
check('name rules accept a conforming name', nameProblems('pdf-tools', 'pdf-tools').length === 0);

// --- discovery -------------------------------------------------------------------------------

const registry = new SkillRegistry([primary, secondary]);
await registry.discover();

const names = registry.names();
check('conforming skills load', ['declares-tools', 'legacy-shaped', 'linked-escape', 'pdf-tools'].every((n) => names.includes(n)), names.join(', '));
check('a skill whose name mismatches its directory is rejected', !names.includes('something-else'));
check('an uppercase name is rejected', !names.includes('Bad-Caps'));
check('a consecutive-hyphen name is rejected', !names.includes('double--hyphen'));
check('a missing description is rejected', !names.includes('no-description'));
check('a missing frontmatter is rejected', !names.includes('no-frontmatter'));
check('an over-long description is rejected', !names.includes('too-long'));

const rejected = registry.problemsList.map((p) => path.basename(p.directory));
check('every rejected skill is reported with a reason', ['mismatched-name', 'Bad-Caps', 'double--hyphen', 'no-description', 'no-frontmatter', 'too-long'].every((d) => rejected.includes(d)), rejected.join(', '));
check('a rejection reason names the actual fault', registry.problemsList.some((p) => p.reason.includes('directory name')) && registry.problemsList.some((p) => p.reason.includes('1024')), JSON.stringify(registry.problemsList.slice(0, 3)));

const shadowed = registry.shadowedList.find((s) => s.name === 'pdf-tools');
check('a duplicate name is reported as shadowed rather than silently overriding', !!shadowed && shadowed.shadowed_by.includes(primary.replace(/\\/g, '\\')), JSON.stringify(registry.shadowedList));
check('the first root wins for a duplicate name', registry.directoryOf('pdf-tools')?.startsWith(primary), registry.directoryOf('pdf-tools'));

const legacy = registry.list().find((s) => s.name === 'legacy-shaped');
check('unknown frontmatter keys survive discovery', legacy?.extra?.agent_created === 'true' && legacy?.extra?.version === '2.1', JSON.stringify(legacy?.extra));

// The inventory is deliberately not part of the listing (that would be stage 2 leaking into
// stage 1), so the link check reads the skill.
const linked = await registry.read('linked-escape');
check('a link inside a skill is not followed', !!linked && !linked.files.some((f) => f.includes('escape-link')), JSON.stringify(linked?.files));
check('nothing behind the link is reachable', !(await registry.readFile('linked-escape', 'escape-link/secret.txt')));

// --- progressive disclosure -------------------------------------------------------------------

const listing = registry.list();
const serialised = JSON.stringify(listing);
check('the listing carries no skill body', !serialised.includes('BODY_SENTINEL_DO_NOT_LEAK'), serialised.slice(0, 200));
check('the listing carries a description', listing.every((s) => typeof s.description === 'string' && s.description.length > 0));
check('the listing reports bundled file counts', (listing.find((s) => s.name === 'pdf-tools')?.file_count ?? 0) === 3, String(listing.find((s) => s.name === 'pdf-tools')?.file_count));

const opened = await registry.read('pdf-tools');
check('reading a skill returns its body', !!opened && opened.body.includes('BODY_SENTINEL_DO_NOT_LEAK'));
check('reading a skill returns its file inventory', !!opened && opened.files.includes('scripts/extract.py') && opened.files.includes('references/REFERENCE.md'), JSON.stringify(opened?.files));
check('reading an unknown skill returns nothing', (await registry.read('no-such-skill')) === null);

const resource = await registry.readFile('pdf-tools', 'references/REFERENCE.md');
check('a bundled resource can be read by relative path', resource?.text.includes('# Reference'), JSON.stringify(resource));

for (const escape of ['../outside/secret.txt', '..\\outside\\secret.txt', '/etc/passwd', 'C:\\Windows\\win.ini', 'scripts/../../outside/secret.txt']) {
  const attempt = await registry.readFile('pdf-tools', escape);
  check(`a path that escapes the skill is refused (${escape})`, attempt === null, JSON.stringify(attempt)?.slice(0, 80));
}
check('a file that is not in the inventory is refused', (await registry.readFile('pdf-tools', 'not-listed.txt')) === null);

// --- install and remove ------------------------------------------------------------------------

// Installing a skill is installing instructions an agent will follow, so these assertions are
// mostly about refusing: a bad source must leave the root untouched, and a name must not be able
// to point the write anywhere else.
const installRoot = path.join(sandbox, 'installed');
fs.mkdirSync(installRoot, { recursive: true });

const sources = path.join(sandbox, 'sources');
const goodSource = path.join(sources, 'good-skill');
fs.mkdirSync(path.join(goodSource, 'references'), { recursive: true });
fs.writeFileSync(path.join(goodSource, SKILL_FILENAME), ['---', 'name: good-skill', 'description: A skill that should install cleanly.', '---', 'body'].join('\n'));
fs.writeFileSync(path.join(goodSource, 'references', 'R.md'), '# R\n', 'utf8');

const installed = await installSkillFromDirectory(goodSource, installRoot);
check('a conforming skill installs', installed.ok && installed.name === 'good-skill' && installed.files === 2, JSON.stringify(installed));
check('the installed tree is complete', fs.existsSync(path.join(installRoot, 'good-skill', 'references', 'R.md')));
check('no staging directory is left behind', !fs.readdirSync(installRoot).some((n) => n.startsWith('.installing-')), fs.readdirSync(installRoot).join(', '));

const afterInstall = new SkillRegistry([installRoot]);
await afterInstall.discover();
check('an installed skill is discoverable without a restart', afterInstall.names().includes('good-skill'), afterInstall.names().join(', '));

const duplicate = await installSkillFromDirectory(goodSource, installRoot);
check('installing an existing name is refused rather than overwriting', !duplicate.ok && /already installed/.test(duplicate.reason ?? ''), JSON.stringify(duplicate));

const badSource = path.join(sources, 'bad-skill');
fs.mkdirSync(badSource, { recursive: true });
fs.writeFileSync(path.join(badSource, SKILL_FILENAME), ['---', 'name: not-matching', 'description: The name does not match its directory.', '---', 'body'].join('\n'));
const beforeBad = fs.readdirSync(installRoot).sort().join(',');
const rejectedInstall = await installSkillFromDirectory(badSource, installRoot);
check('a non-conforming skill is refused', !rejectedInstall.ok && /directory name/.test(rejectedInstall.reason ?? ''), JSON.stringify(rejectedInstall));
check('a refused install writes nothing at all', fs.readdirSync(installRoot).sort().join(',') === beforeBad, fs.readdirSync(installRoot).join(', '));

// A skill containing a link is a different skill once the link is dropped, so the install is
// refused rather than silently installing something else.
const linkSource = path.join(sources, 'link-skill');
fs.mkdirSync(linkSource, { recursive: true });
fs.writeFileSync(path.join(linkSource, SKILL_FILENAME), ['---', 'name: link-skill', 'description: Contains a link, which must not be silently dropped.', '---', 'body'].join('\n'));
let linkSourceCreated = false;
try { fs.symlinkSync(outsideDir, path.join(linkSource, 'linked'), 'junction'); linkSourceCreated = true; } catch { /* reported below */ }
check('the link-source fixture could be created (this check must not be skippable)', linkSourceCreated);
const linkInstall = await installSkillFromDirectory(linkSource, installRoot);
check('a skill containing a link is refused, not silently trimmed', !linkInstall.ok && /link/.test(linkInstall.reason ?? ''), JSON.stringify(linkInstall));
check('the refused link install left no staging directory behind', !fs.readdirSync(installRoot).some((n) => n.startsWith('.installing-')), fs.readdirSync(installRoot).join(', '));

const notASkill = path.join(installRoot, 'just-a-folder');
fs.mkdirSync(notASkill, { recursive: true });
check('removing a directory that is not a skill is refused', !(await removeSkill(installRoot, 'just-a-folder')).ok);

// A *valid* skill placed outside the root. The traversal assertion needs a target that would
// actually be deleted if the containment check were removed — pointing at a directory that is not
// a skill passes for the wrong reason and cannot fail, which is not a test.
const outsideSkill = path.join(sandbox, 'outside-skill');
fs.mkdirSync(outsideSkill, { recursive: true });
fs.writeFileSync(path.join(outsideSkill, SKILL_FILENAME), ['---', 'name: outside-skill', 'description: A valid skill that lives outside the root.', '---', 'body'].join('\n'));
const traversal = await removeSkill(installRoot, '../outside-skill');
check('removing a valid skill that lives outside the root is refused', !traversal.ok && fs.existsSync(path.join(outsideSkill, SKILL_FILENAME)), JSON.stringify(traversal));
check('removing a nested name is refused', !(await removeSkill(installRoot, 'a/b')).ok, 'nested');
check('removing a skill that is not installed is refused', !(await removeSkill(installRoot, 'never-installed')).ok);
const removed = await removeSkill(installRoot, 'good-skill');
check('a real skill can be removed', removed.ok && !fs.existsSync(path.join(installRoot, 'good-skill')), JSON.stringify(removed));
check('removal left the unrelated directory alone', fs.existsSync(notASkill));

// --- tool surface -----------------------------------------------------------------------------

check('list_skills is registered', Object.hasOwn(ToolSchemas, 'list_skills'));
check('read_skill is registered', Object.hasOwn(ToolSchemas, 'read_skill'));
check('both tools document that reading grants no execution', /no execution|never grants execution/i.test(ToolDescriptions.read_skill) && /no permission|grants no permission/i.test(ToolDescriptions.list_skills), ToolDescriptions.list_skills.slice(0, 120));

const caps = capabilities();
check('capabilities report skills as mounted', caps.tools.skills_external_mounts === true, String(caps.tools.skills_external_mounts));
check('capabilities state that skills cannot execute', caps.tools.skills_can_execute === false, String(caps.tools.skills_can_execute));
check('capabilities name the implemented format', /agentskills\.io/.test(caps.tools.skills_format), String(caps.tools.skills_format));

// `allowed-tools` is the spec's own experimental "pre-approved tools" field. Honouring it would
// let a third-party skill directory pre-approve execution, which is the bypass T27 forbids. There
// is no runtime value to assert on, so this reads the sources.
//
// The invariant is deliberately narrow: **the authorisation module must not know the field
// exists**. An earlier version of this check looked for the field anywhere in a file that did not
// also contain words like "never" or "reported" — which was useless, because the policy engine
// contains those words for unrelated reasons, so the check could never fire. Counting mentions in
// the module that decides permissions cannot be satisfied by accident.
const policySource = fs.readFileSync(path.join(root, 'packages/policy-engine/src/index.ts'), 'utf8');
check('the authorisation module never mentions allowed-tools', !policySource.includes('allowed-tools'));
for (const file of ['apps/daemon/src/tools.ts', 'apps/daemon/src/server.ts']) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const bad = text.split('\n').filter((line) => line.includes('allowed-tools') && !/grants no permission|reported/i.test(line));
  check(`${file} mentions allowed-tools only to say it grants nothing`, bad.length === 0, bad.map((l) => l.trim().slice(0, 90)).join(' | '));
}

// The skills scope is read-only and granted in every mode, so a read-only caller is not left
// unable to read the operator's own instructions.
check('skills:read is granted outside the mode conditionals', /'skills:read'/.test(policySource) && !/mode===\s*'(code|exec)'.*\['skills:read'\]/.test(policySource));
check('no skills scope grants a write', !/skills:(write|patch|exec)/.test(policySource));

check('the skills config section defaults to no extra roots', JSON.stringify(ConfigSchema.parse({ schema_version: 1, state_directory: 'x', security_profile: 'local_trusted_development', workspaces: [{ root: 'y', display_name: 'y' }] }).skills) === '{"roots":[]}');
check('extra skills roots are accepted from config', ConfigSchema.parse({ schema_version: 1, state_directory: 'x', security_profile: 'local_trusted_development', workspaces: [{ root: 'y', display_name: 'y' }], skills: { roots: ['/a', '/b'] } }).skills.roots.length === 2);

// --- report -----------------------------------------------------------------------------------

cleanup();
const failed = results.filter((r) => !r.passed);
for (const r of results) console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.passed || r.detail === undefined ? '' : `  — ${r.detail}`}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
