/**
 * Mutation test for probe-skills.mjs.
 *
 * A probe that passes proves nothing on its own: it cannot distinguish "the guard works" from
 * "the assertion never fired". So each decision the probe claims to protect is deliberately
 * broken here, and the probe must fail for each one. A mutation the probe does NOT catch is a
 * hole in the probe, not a pass.
 *
 * Mutations are applied as exact string replacements (never regex rewriting) against the built
 * output, so nothing here can structurally damage a source file, and every file is restored
 * before the next mutation runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIST = path.join(root, 'dist', 'packages', 'skills', 'src', 'index.js');
const SERVER_DIST = path.join(root, 'dist', 'apps', 'daemon', 'src', 'server.js');
const POLICY_SRC = path.join(root, 'packages', 'policy-engine', 'src', 'index.ts');

const mutations = [
  {
    name: 'accept a name that does not match its directory',
    file: SKILLS_DIST,
    from: 'if (name !== directoryName)',
    to: 'if (false)',
  },
  {
    name: 'drop frontmatter keys the spec does not define',
    file: SKILLS_DIST,
    from: 'if (!known.has(key))\n            extra[key] = value;',
    to: 'if (!known.has(key))\n            void key;',
  },
  {
    // Both guards go at once, and the reason is the same as the containment pair below: the
    // explicit `isSymbolicLink()` skip and the `isFile()` test each independently keep a link out
    // of the inventory (a link is neither a directory nor a regular file), so removing either one
    // alone changes no observable behaviour and "missing" it would say nothing about the probe.
    // Breaking the pair is what tests whether the inventory assertion is load-bearing.
    name: 'let the scan inventory a link (both guards)',
    file: SKILLS_DIST,
    from: "        if (entry.isSymbolicLink())\n            continue;\n        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;\n        if (entry.isDirectory()) {\n            out.push(...await listFiles(root, relative, budget));\n            continue;\n        }\n        if (!entry.isFile())\n            continue;",
    to: "        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;\n        if (entry.isDirectory()) {\n            out.push(...await listFiles(root, relative, budget));\n            continue;\n        }\n        if (false)\n            continue;",
  },
  {
    // Both guards go at once, on purpose. The resolved-path containment check and the
    // inventory check are defence in depth: removing either one alone changes no observable
    // behaviour, so a mutation that removes only one is not a defect and "missing" it says
    // nothing about the probe. Breaking the pair is what tests whether the traversal
    // assertions are load-bearing at all.
    name: 'stop containing skill file reads (both guards)',
    file: SKILLS_DIST,
    from: "if (target !== base && !target.startsWith(base + path.sep))\n            return null;\n        if (!entry.record.files.includes(relative.split(path.sep).join('/')))\n            return null;",
    to: "if (false)\n            return null;\n        if (false)\n            return null;",
  },
  {
    name: 'claim skills can execute',
    file: SERVER_DIST,
    from: 'skills_can_execute: false',
    to: 'skills_can_execute: true',
  },
  {
    name: 'consume allowed-tools in the policy engine',
    file: POLICY_SRC,
    from: 'export const ACCESS_MODES',
    to: "// pre-approve whatever the skill declares\nconst declaredAllowedTools = (frontmatter) => frontmatter['allowed-tools'];\nexport const ACCESS_MODES",
  },
  {
    name: 'install over an existing skill instead of refusing',
    file: SKILLS_DIST,
    from: 'if (await fs.lstat(destination).then(() => true).catch(() => false))\n        return { ok: false, reason: `a skill named "${skill.record.name}" is already installed` };',
    to: 'if (false)\n        return { ok: false, reason: "" };',
  },
  {
    name: 'install a source that failed the spec check',
    file: SKILLS_DIST,
    from: "if (skill.problems.length)\n        return { ok: false, reason: skill.problems.join('; ') };",
    to: 'if (false)\n        return { ok: false, reason: "" };',
  },
  {
    name: 'skip a link during install instead of refusing it',
    file: SKILLS_DIST,
    from: 'throw new Error(`contains a link: ${entry.name}`);',
    to: 'continue;',
  },
  {
    name: 'remove without checking the target is a direct child of the root',
    file: SKILLS_DIST,
    from: 'if (path.dirname(target) !== base)\n        return null;',
    to: 'if (false)\n        return null;',
  },
];

function runProbe() {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'probe-skills.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 180000,
    env: { ...process.env, CODEBUDDY_CONVERSATION_REQUEST_ID: `mutation-${Math.random().toString(36).slice(2)}` },
  });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const failed = out.match(/^FAIL {2}(.+)$/gm)?.map((line) => line.replace(/^FAIL {2}/, '')) ?? [];
  return { code: result.status, failed, out };
}

const baseline = runProbe();
console.log(`baseline: exit ${baseline.code}, ${baseline.failed.length} failing checks`);
if (baseline.code !== 0) {
  console.error('Baseline is not green, so mutation results would be meaningless.');
  console.error(baseline.out.slice(-2000));
  process.exit(2);
}
console.log('');

let holes = 0;
for (const mutation of mutations) {
  const original = fs.readFileSync(mutation.file, 'utf8');
  if (!original.includes(mutation.from)) {
    console.log(`SKIP  ${mutation.name} — anchor not found in ${path.relative(root, mutation.file)} (the code changed; update this test)`);
    holes++;
    continue;
  }
  fs.writeFileSync(mutation.file, original.replace(mutation.from, mutation.to), 'utf8');
  try {
    const result = runProbe();
    const caught = result.code !== 0;
    console.log(`${caught ? 'CAUGHT' : 'MISSED'}  ${mutation.name}`);
    if (caught) for (const line of result.failed.slice(0, 3)) console.log(`          -> ${line}`);
    else holes++;
  } finally {
    fs.writeFileSync(mutation.file, original, 'utf8');
  }
}

const restored = runProbe();
console.log('');
console.log(`restored: exit ${restored.code} (${restored.failed.length} failing)`);
if (restored.code !== 0) { console.error('The tree was not restored correctly.'); process.exit(2); }
console.log(holes ? `\n${mutations.length - holes}/${mutations.length} mutations caught — ${holes} hole(s) in the probe` : `\nall ${mutations.length} mutations caught: the probe is load-bearing`);
process.exit(holes ? 1 : 0);
