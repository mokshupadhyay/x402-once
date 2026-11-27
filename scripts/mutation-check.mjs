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
    find: 'const saved = await cas(intent, previous?.version ?? 0, record);',
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
    find: "return chainTime >= deadline + margin ? { verdict: 'unsettled' } : { verdict: 'unknown' };",
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
  {
    id: 'M23',
    file: 'src/paidFetch.ts',
    claim: 'The signed payment is never sent to another origin after a redirect',
    find: 'target.origin !== new URL(from).origin ||',
    replace: 'false ||',
  },
  {
    id: 'M24',
    file: 'src/paidFetch.ts',
    claim: 'A damaged or edited record stops the call (it is never read as "no payment")',
    find: 'validateRecord(intent, raw)',
    replace: '(raw as PaymentRecord)',
  },
  {
    id: 'M25',
    file: 'src/errors.ts',
    claim: 'Errors do not print the signed payment',
    find: 'enumerable: false',
    replace: 'enumerable: true',
  },
  {
    id: 'M26',
    file: 'src/paidFetch.ts',
    claim: 'A huge payment-required body is cut off at the cap',
    find: 'if (total > MAX_PAYMENT_REQUIRED_BYTES) {',
    replace: 'if (false) {',
  },
  {
    id: 'M27',
    file: 'src/paidFetch.ts',
    claim: 'A seller cannot make a signed payment valid for years',
    find: 'if (record.expiresAt - time > maxValidityMs) {',
    replace: 'if (false) {',
  },
  {
    id: 'M28',
    file: 'src/intent.ts',
    claim: 'The same FormData is the same purchase (multipart boundary ignored)',
    find: 'if (boundary && body.length > 0) {',
    replace: 'if (false) {',
  },
  {
    id: 'M29',
    file: 'src/paidFetch.ts',
    claim: 'A body that dies after a 200 reopens the purchase',
    find: '          onFailure();\n',
    replace: '          // onFailure removed\n',
  },
  {
    id: 'M30',
    file: 'src/paidFetch.ts',
    claim: 'A delivered purchase drops the signed payment from the store',
    find: '() => quietly(update(settled, stripped(settled))),',
    replace: '() => {},',
  },
  {
    id: 'M31',
    file: 'src/paidFetch.ts',
    claim: 'A call that is already cancelled does not use up a send',
    find: 'request.signal.throwIfAborted();',
    replace: '',
  },
  {
    id: 'M32',
    file: 'src/paidFetch.ts',
    claim: 'A clock that is not a number is refused',
    find: 'if (!Number.isFinite(time)) throw',
    replace: 'if (false) throw',
  },
  {
    id: 'M33',
    file: 'src/paidFetch.ts',
    claim: 'The retained original response is released so a caller can cancel',
    find: 'if (owner) setTimeout(() => void response.body?.cancel().catch(() => {}), 0);',
    replace: '',
  },
  {
    id: 'M34',
    file: 'src/paidFetch.ts',
    claim: 'A store answering compareAndSet with junk is an error',
    find: '(result.ok !== true && result.ok !== false)',
    replace: 'false',
  },
  {
    id: 'M35',
    file: 'src/paidFetch.ts',
    claim: 'A seller that never answers is given up on',
    find: 'const requestTimeoutMs = nonNegative(options.requestTimeoutMs, 60_000);',
    replace: 'const requestTimeoutMs = 0;',
  },
  {
    id: 'M36',
    file: 'src/fileStore.ts',
    claim: 'The file store refuses a symlinked directory',
    find: 'if (info.isSymbolicLink()) throw',
    replace: 'if (false) throw',
  },
  {
    id: 'M37',
    file: 'src/fileStore.ts',
    claim: 'The file store refuses a group- or world-writable directory',
    find: 'if (info.mode & 0o022) throw',
    replace: 'if (false) throw',
  },
  {
    id: 'M38',
    file: 'src/fileStore.ts',
    claim: 'prune never deletes an open purchase',
    find: "if (prunable && ['settled', 'expired', 'abandoned'].includes(record.status) && record.updatedAt < cutoff) {",
    replace: 'if (prunable && record.updatedAt < cutoff) {',
  },
  {
    id: 'M39',
    file: 'src/store.ts',
    claim: 'The memory store never drops an open purchase',
    find: '      if (FINISHED.has(record.status)) {\n        this.records.delete(intent);',
    replace: '      {\n        this.records.delete(intent);',
  },
  {
    id: 'M40',
    file: 'src/fileStore.ts',
    claim: 'A failed write leaves no half-written file',
    find: 'await unlink(temporary).catch(() => {}); // a full disk must not leave a half-written signed record behind',
    replace: '// no cleanup',
  },
  {
    id: 'M41',
    file: 'src/paidFetch.ts',
    claim: "The signed payment is checked against the seller's offer before it is saved or sent",
    find: 'checkPayment(payload, paymentRequired, options.limits, options.allowUninspected);',
    replace: 'void 0;',
  },
  {
    id: 'M42',
    file: 'src/validate.ts',
    claim: 'The signed payee must equal the offered payee',
    find: "if (!sameText(authorization['to'], accepted['payTo']))",
    replace: 'if (false)',
  },
  {
    id: 'M43',
    file: 'src/validate.ts',
    claim: 'The signed amount must equal the offered amount',
    find: "if (!isAtomic(authorization['value']) || authorization['value'] !== String(accepted['amount'])) {",
    replace: 'if (false) {',
  },
  {
    id: 'M44',
    file: 'src/validate.ts',
    claim: 'The payment must name an offer the seller actually made',
    find: 'if (!offered) throw',
    replace: 'if (false) throw',
  },
  {
    id: 'M45',
    file: 'src/validate.ts',
    claim: 'Your payee limit is enforced',
    find: 'if (limits?.payTo && ',
    replace: 'if (false && ',
  },
  {
    id: 'M46',
    file: 'src/validate.ts',
    claim: 'Your amount limit is enforced',
    find: "BigInt(String(accepted['amount'])) > BigInt(limits.maxAmount)",
    replace: 'false',
  },
  {
    id: 'M47',
    file: 'src/validate.ts',
    claim: 'Your network limit is enforced',
    find: 'if (limits?.networks && ',
    replace: 'if (false && ',
  },
  {
    id: 'M48',
    file: 'src/validate.ts',
    claim: 'Your asset limit is enforced',
    find: 'if (limits?.assets && ',
    replace: 'if (false && ',
  },
  {
    id: 'M49',
    file: 'src/validate.ts',
    claim: 'Saved headers cannot carry line breaks or control characters',
    find: '|| /[\\r\\n\\0]/.test(header as string)',
    replace: '',
  },
  {
    id: 'M50',
    file: 'src/paidFetch.ts',
    claim: 'The signed payment is never sent over plain http to a remote host',
    find: "if (!(parsed.protocol === 'http:' && local)) throw new InsecureTransportError(url);",
    replace: '',
  },
  {
    id: 'M51',
    file: 'src/paidFetch.ts',
    claim: 'The paid request tells caches not to keep it',
    find: "if (!base.headers.has('cache-control')) base.headers.set('Cache-Control', 'no-store');",
    replace: '',
  },
  {
    id: 'M52',
    file: 'src/resolve.ts',
    claim: 'An RPC on the wrong chain is not believed',
    find: 'BigInt(chainId) !== BigInt(wanted)',
    replace: 'false',
  },
  {
    id: 'M53',
    file: 'src/resolve.ts',
    claim: '"Never settled" waits for a margin past the deadline',
    find: 'chainTime >= deadline + margin',
    replace: 'chainTime >= deadline',
  },
  {
    id: 'M54',
    file: 'src/resolve.ts',
    claim: '"Never settled" needs every provider to agree',
    find: "answers.every((a) => a.verdict === 'unsettled')",
    replace: "answers.some((a) => a.verdict === 'unsettled')",
  },
  {
    id: 'M55',
    file: 'src/resolve.ts',
    claim: 'A plain-http RPC URL is refused',
    find: "if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {",
    replace: 'if (false) {',
  },
  {
    id: 'M56',
    file: 'src/resolve.ts',
    claim: 'An RPC cannot redirect the resolver elsewhere',
    find: "redirect: 'error',",
    replace: '',
  },
  {
    id: 'M57',
    file: 'src/resolve.ts',
    claim: 'State and chain clock are read at the same block',
    find: 'data: AUTHORIZATION_STATE + pad32(owner) + pad32(nonce as string) }, at]',
    replace: "data: AUTHORIZATION_STATE + pad32(owner) + pad32(nonce as string) }, 'latest']",
  },
  {
    id: 'M58',
    file: 'src/fileStore.ts',
    claim: 'A symlink planted in place of a record file is refused',
    find: 'if (!info.isFile()) throw',
    replace: 'if (false) throw',
  },
  {
    id: 'M59',
    file: 'src/fileStore.ts',
    claim: 'prune keeps records of keys the caller chose',
    find: 'const prunable = !record.explicit || options.includeExplicit === true;',
    replace: 'const prunable = true;',
  },
  {
    id: 'M60',
    file: 'src/paidFetch.ts',
    claim: 'Forgetting a purchase removes the signed payment from its record',
    find: "await update(record, { status: 'abandoned', ...stripped(record) });",
    replace: "await update(record, { status: 'abandoned' });",
  },
  {
    id: 'M61',
    file: 'src/validate.ts',
    claim: 'A Permit2 payment must name the expected spender contract',
    find: "if (!spenders.some((spender) => sameText(spender, permit2['spender'])))",
    replace: 'if (false)',
  },
  {
    id: 'M62',
    file: 'src/validate.ts',
    claim: 'A Permit2 payment must be for the offered token',
    find: "if (!sameText(permitted['token'], accepted['asset']))",
    replace: 'if (false)',
  },
  {
    id: 'M63',
    file: 'src/validate.ts',
    claim: 'A Permit2 payment must be for the offered amount',
    find: "if (!isAtomic(permitted['amount']) || permitted['amount'] !== String(accepted['amount']))",
    replace: 'if (false)',
  },
  {
    id: 'M64',
    file: 'src/validate.ts',
    claim: 'A Permit2 payment must pay the offered payee',
    find: "if (!sameText(witness['to'], accepted['payTo']))",
    replace: 'if (false)',
  },
  {
    id: 'M65',
    file: 'src/validate.ts',
    claim: 'A payment type that cannot be inspected is refused before sending',
    find: 'if (!allowUninspected) {',
    replace: 'if (false) {',
  },
  {
    id: 'M66',
    file: 'src/resolve.ts',
    claim: 'The Permit2 nonce word is nonce >> 8',
    find: 'const word = value >> 8n;',
    replace: 'const word = value;',
  },
  {
    id: 'M67',
    file: 'src/resolve.ts',
    claim: 'The Permit2 nonce bit is nonce & 255',
    find: '((BigInt(result) >> (value & 255n)) & 1n) === 1n',
    replace: 'BigInt(result) !== 0n',
  },
  {
    id: 'M68',
    file: 'src/resolve.ts',
    claim: 'minProviders is enforced',
    find: 'if (list.length < (options.minProviders ?? 1)) throw',
    replace: 'if (false) throw',
  },
  {
    id: 'M69',
    file: 'src/resolve.ts',
    claim: 'A Permit2 payment expires at its Permit2 deadline',
    find: '?? permit2Of(payload)?.deadline);',
    replace: '));',
  },
  {
    id: 'M70',
    file: 'src/resolve.ts',
    claim: 'The transaction is still found on a public RPC that refuses wide log queries',
    find: 'for (const window of [...new Set([lookback, 150])]) {',
    replace: 'for (const window of [lookback]) {',
  },
];

const dir = mkdtempSync(join(tmpdir(), 'x402-once-mutation-'));
const rows = [];

function runTests() {
  const out = join(dir, 'result.json');
  spawnSync('npx', ['vitest', '--run', '--reporter=json', `--outputFile=${out}`], { encoding: 'utf8', env: { ...process.env, RUNS: '1500' } });
  const json = JSON.parse(readFileSync(out, 'utf8'));
  const failed = [];
  for (const file of json.testResults) {
    for (const t of file.assertionResults) if (t.status === 'failed') failed.push(t.fullName);
    // A file that cannot even load (a syntax error from the break) is also a failure the tests would show.
    if (file.status === 'failed' && !file.assertionResults.some((t) => t.status === 'failed')) failed.push(`(${file.name.split('/').pop()} failed to load)`);
  }
  return failed;
}

const baseline = runTests();
if (baseline.length) {
  console.error('The tests already fail without any mutation:', baseline);
  process.exit(1);
}

for (const m of mutations.filter((x) => !process.env.ONLY || process.env.ONLY.split(',').includes(x.id))) {
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
if (!process.env.ONLY) writeFileSync('docs/MUTATION_EVIDENCE.md', md);
console.log(md.split('\n').slice(-3).join('\n'));
if (dirty.trim() && false) console.log(dirty);
