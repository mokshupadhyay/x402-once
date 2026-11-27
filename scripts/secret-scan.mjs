// Fails when a tracked file looks like it contains a secret. Run in CI and before every release.
// It is deliberately simple: it catches the mistakes that actually happen (a pasted key, a token, a local path).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const rules = [
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'a 32-byte hex value assigned to a key-like name', re: /(private[_-]?key|secret|mnemonic|seed)["']?\s*[:=]\s*["']?0x[0-9a-fA-F]{64}\b/i },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'API key like sk-', re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'a local home path', re: /\/Users\/[a-z][a-z0-9._-]+\//i },
  { name: 'a personal email address', re: /[A-Za-z0-9._%+-]+@(gmail|yahoo|outlook|hotmail|proton)\.[a-z]+/i },
];
// Public constants and test fixtures that are not secrets.
const allowFiles = new Set(['scripts/secret-scan.mjs']);
const bad = [];
for (const file of files) {
  if (allowFiles.has(file)) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\0')) continue;
  text.split('\n').forEach((line, index) => {
    for (const rule of rules) if (rule.re.test(line)) bad.push(`${file}:${index + 1}: ${rule.name}`);
  });
}
if (bad.length) {
  console.error('Possible secrets or personal data:\n' + bad.join('\n'));
  process.exit(1);
}
console.log(`secret scan: ${files.length} tracked files clean`);
