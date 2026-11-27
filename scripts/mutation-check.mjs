// Breaks the source in one small, deliberate way at a time and checks that the tests fail.
// Usage: node scripts/mutation-check.mjs        (writes docs/MUTATION_EVIDENCE.md)
// The file under test is always restored afterwards, even on error, and compared byte for byte with the original.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mutations = [
  {
    id: 'M1',
    file: 'src/paidFetch.ts',
    claim: 'The signed payment is saved before it is sent',
    find: 'const saved = await store.compareAndSet(intent, previous?.version ?? 0, record);',
    replace: 'const saved = { ok: true as const };',
  },
  {
    id: 'M2',
    file: 'src/paidFetch.ts',
    claim: 'A retry sends the saved payment instead of signing a new one',
    find: 'return present(request, next, true);',
    replace: 'return { fresh: next };',
  },
  {
    id: 'M3',
    file: 'src/paidFetch.ts',
    claim: 'A payment settled on chain but not delivered never leads to a new purchase',
    find: "if (record.status === 'undelivered') throw new SettledWithoutDeliveryError(record);",
    replace: '',
  },
  {
    id: 'M4',
    file: 'src/paidFetch.ts',
    claim: 'When nobody can tell whether the old payment settled, no new payment is signed',
    find: `    throw new UnresolvedPaymentError(
      record,
      options.resolver ? 'the resolver could not tell whether it settled' : 'no resolver is configured to check whether it settled',
    );`,
    replace: '    return { fresh: record };',
  },
  {
    id: 'M5',
    file: 'src/paidFetch.ts',
    claim: 'The resolver is not asked until clock differences have passed',
    find: 'if (time <= record.expiresAt + skew) {',
    replace: 'if (false) {',
  },
  {
    id: 'M6',
    file: 'src/paidFetch.ts',
    claim: 'Overlapping calls for one purchase share one payment',
    find: 'let running = inFlight.get(intent);',
    replace: 'let running: Promise<Response> | undefined = undefined;',
  },
  {
    id: 'M7',
    file: 'src/paidFetch.ts',
    claim: 'One signed payment is sent at most maxPresentations times',
    find: 'if (record.presentations >= maxPresentations) throw new TooManyPresentationsError(record, maxPresentations);',
    replace: '',
  },
  {
    id: 'M8',
    file: 'src/paidFetch.ts',
    claim: 'A key the caller chose cannot be paid for twice',
    find: 'if (record.explicit) throw new AlreadySettledError(record);',
    replace: '',
  },
  {
    id: 'M9',
    file: 'src/store.ts',
    claim: 'The store refuses a write when the record changed underneath (compare-and-set)',
    find: 'if (currentVersion !== expectedVersion) {',
    replace: 'if (false) {',
  },
  {
    id: 'M10',
    file: 'src/paidFetch.ts',
    claim: 'A re-sent payment that the seller refuses, but the chain shows as settled, is reported as paid-but-undelivered',
    find: 'if (reused && options.resolver) {',
    replace: 'if (false) {',
  },
  {
    id: 'M11',
    file: 'src/fileStore.ts',
    claim: 'The file store takes a lock, so two writers cannot both win',
    find: 'await mkdir(lock);',
    replace: '',
  },
  {
    id: 'M12',
    file: 'src/fileStore.ts',
    claim: 'The file store refuses a write when the saved version changed (compare-and-set)',
    find: 'if ((current?.version ?? 0) !== expectedVersion) return { ok: false, current };',
    replace: '',
  },
  {
    id: 'M13',
    file: 'src/fileStore.ts',
    claim: 'A corrupt file is an error, never "this was never paid"',
    find: "throw new Error(`The saved payment for \"${intent}\" is unreadable (${this.path(intent, '.json')}). Not guessing: fix or remove the file.`);",
    replace: 'return undefined;',
  },
  {
    id: 'M14',
    file: 'src/fileStore.ts',
    claim: 'A file that belongs to another purchase is refused',
    find: 'if (record.intent !== intent) throw new Error(`The saved payment file for "${intent}" holds a different purchase.`);',
    replace: '',
  },
  {
    id: 'M15',
    file: 'src/fileStore.ts',
    claim: 'A lock left by a dead process is broken after a while',
    find: 'if (age !== undefined && age > this.staleLockMs) {',
    replace: 'if (false) {',
  },
  {
    id: 'M16',
    file: 'src/resolve.ts',
    claim: 'The resolver names the transaction that used the authorization',
    find: "const hash = logs[0]?.transactionHash;",
    replace: 'const hash = undefined;',
  },
  {
    id: 'M17',
    file: 'src/paidFetch.ts',
    claim: 'A process never applies its change on top of a record another process already moved on',
    find: 'throw new StaleRecordError(record.intent);\n  }\n\n  /** Asks',
    replace: 'return next;\n  }\n\n  /** Asks',
  },
  {
    id: 'M18',
    file: 'src/paidFetch.ts',
    claim: 'A call that lost a race to another process finishing the same purchase signs nothing',
    find: "if (previous && sawConflict && previous.status === 'settled' && previous.updatedAt >= startedAt) {",
    replace: 'if (false) {',
  },
  {
    id: 'M19',
    file: 'src/resolve.ts',
    claim: 'The chain says "never settled" only after its own clock passed the deadline',
    find: 'return chainTime >= validBefore ? { verdict: \'unsettled\' } : { verdict: \'unknown\' };',
    replace: "return { verdict: 'unsettled' };",
  },
  {
    id: 'M20',
    file: 'src/fileStore.ts',
    claim: 'A writer whose lock was broken does not write',
    find: 'if (!(await stillOwner())) throw new Error(`Lost the lock on "${intent}" while working; nothing was written.`);',
    replace: '',
  },
  {
    id: 'M21',
    file: 'src/paidFetch.ts',
    claim: 'A chosen key is bound to the request, so one request\'s payment is never sent to another URL',
    find: 'const intent = explicit ? `${chosen}:${derived}` : derived;',
    replace: 'const intent = explicit ? chosen! : derived;',
  },
  {
    id: 'M22',
    file: 'src/paidFetch.ts',
    claim: 'A failure to write down a delivered payment does not throw the delivered resource away',
    find: "        // The resource arrived and was paid for.",
    replace: "        throw new Error('x'); // The resource arrived and was paid for.",
  },
];

const dir = mkdtempSync(join(tmpdir(), 'x402-once-mutation-'));
const rows = [];

function runTests() {
  const out = join(dir, 'result.json');
  spawnSync('npx', ['vitest', '--run', '--reporter=json', `--outputFile=${out}`], { encoding: 'utf8', env: { ...process.env, RUNS: '1500' } });
  const json = JSON.parse(readFileSync(out, 'utf8'));
  const failed = [];
  for (const file of json.testResults) for (const t of file.assertionResults) if (t.status === 'failed') failed.push(t.fullName);
  return failed;
}

const baseline = runTests();
if (baseline.length) {
  console.error('The tests already fail without any mutation:', baseline);
  process.exit(1);
}

for (const m of mutations) {
  const backup = join(dir, m.id + '.bak');
  copyFileSync(m.file, backup);
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.find)) throw new Error(`${m.id}: text to break not found in ${m.file}`);
  try {
    writeFileSync(m.file, original.replace(m.find, m.replace));
    const failed = runTests();
    rows.push({ ...m, failed });
    console.log(`${m.id} ${failed.length ? 'CAUGHT' : 'MISSED'} (${failed.length} failing)`);
  } finally {
    copyFileSync(backup, m.file);
    if (readFileSync(m.file, 'utf8') !== original) throw new Error(`${m.id}: ${m.file} was not restored`);
  }
}

const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { encoding: 'utf8' });
const date = new Date().toISOString().slice(0, 10);
const md = [
  '# Mutation evidence',
  '',
  `Generated by \`node scripts/mutation-check.mjs\` on ${date}. Each row breaks one line of the source, runs the whole suite (property tests at 1,500 runs), and records which tests failed. The file is restored afterwards and compared byte for byte with the original. A row marked MISSED would mean the tests cannot see that bug.`,
  '',
  '| # | File | What must stay true | The break | Caught | First failing tests |',
  '|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.id} | \`${r.file}\` | ${r.claim} | \`${r.find.replace(/\s+/g, ' ').slice(0, 70)}\` → \`${(r.replace || '(removed)').replace(/\s+/g, ' ').slice(0, 40)}\` | ${r.failed.length ? 'yes (' + r.failed.length + ')' : '**NO**'} | ${r.failed.slice(0, 2).map((n) => n.replace(/\|/g, '/')).join('; ') || '-'} |`,
  ),
  '',
  `Caught: ${rows.filter((r) => r.failed.length).length} of ${rows.length}.`,
  '',
].join('\n');
writeFileSync('docs/MUTATION_EVIDENCE.md', md);
console.log(md.split('\n').slice(-3).join('\n'));
if (dirty.trim() && false) console.log(dirty);
