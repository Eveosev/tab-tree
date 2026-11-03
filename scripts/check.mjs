#!/usr/bin/env node
/**
 * Dependency-free project checks:
 *  - every JS file parses (`node --check`)
 *  - every JSON file parses
 *  - manifest references exist
 *  - i18n keys used by the UI exist in both locales
 *  - no <all_urls> host permission / remote script URLs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'extension');
const failures = [];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(root).filter(
  (file) =>
    !file.includes(`${path.sep}dist${path.sep}`) &&
    !file.includes(`${path.sep}.git${path.sep}`) &&
    !file.endsWith('.png') &&
    !file.endsWith('.zip') &&
    !file.endsWith('.md'),
);

for (const file of files.filter((name) => /\.(m?js)$/.test(name))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failures.push(`${path.relative(root, file)}: ${String(error.stderr || error.message).trim()}`);
  }
}

for (const file of files.filter((name) => name.endsWith('.json'))) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    failures.push(`${path.relative(root, file)}: invalid JSON (${error.message})`);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
const referenced = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
].filter(Boolean);
for (const relative of referenced) {
  if (!fs.existsSync(path.join(extension, relative))) {
    failures.push(`manifest references missing file: ${relative}`);
  }
}
if (JSON.stringify(manifest.permissions || []).includes('<all_urls>')) {
  failures.push('manifest must not request <all_urls>');
}
if (JSON.stringify(manifest.host_permissions || []).includes('<all_urls>')) {
  failures.push('manifest must not request <all_urls>');
}

const raw = fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8');
for (const match of raw.matchAll(/__MSG_(\w+)__/g)) {
  const key = match[1];
  const en = JSON.parse(fs.readFileSync(path.join(extension, '_locales/en/messages.json'), 'utf8'));
  if (!en[key]) failures.push(`manifest uses missing i18n key: ${key}`);
}

function readMessages(locale) {
  return JSON.parse(fs.readFileSync(path.join(extension, `_locales/${locale}/messages.json`), 'utf8'));
}
const enMessages = readMessages('en');
const zhMessages = readMessages('zh_CN');
for (const key of Object.keys(enMessages)) {
  if (!zhMessages[key]) failures.push(`zh_CN is missing i18n key: ${key}`);
}
for (const key of Object.keys(zhMessages)) {
  if (!enMessages[key]) failures.push(`en is missing i18n key used by zh_CN: ${key}`);
}

const usedKeys = new Set();
for (const relative of ['sidepanel.js', 'sidepanel.html']) {
  const content = fs.readFileSync(path.join(extension, relative), 'utf8');
  for (const match of content.matchAll(/\bt\('(\w+)'\)/g)) usedKeys.add(match[1]);
  for (const match of content.matchAll(/data-i18n(?:-placeholder)?="(\w+)"/g)) usedKeys.add(match[1]);
}
for (const key of usedKeys) {
  if (!enMessages[key]) failures.push(`UI uses missing i18n key: ${key}`);
}

const manifestVersion = manifest.version;
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (manifestVersion !== packageJson.version) {
  failures.push(`version mismatch: manifest ${manifestVersion} vs package.json ${packageJson.version}`);
}

// Real remote-code scan: the previous wording claimed this without checking.
// Everything the extension executes must ship inside the zip.
const extensionFiles = walk(extension).filter((file) => /\.(m?js|html)$/.test(file));
const remoteCodePatterns = [
  { label: 'remote <script src>', pattern: /<script[^>]+src\s*=\s*["'](?:https?:)?\/\//i },
  { label: 'eval()', pattern: /\beval\s*\(/ },
  { label: 'new Function()', pattern: /\bnew\s+Function\s*\(/ },
  { label: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
  { label: 'fetch()', pattern: /\bfetch\s*\(/ },
];
for (const file of extensionFiles) {
  const content = fs.readFileSync(file, 'utf8');
  for (const { label, pattern } of remoteCodePatterns) {
    if (pattern.test(content)) {
      failures.push(`${path.relative(root, file)}: remote/dynamic code (${label})`);
    }
  }
}

if (failures.length > 0) {
  console.error(`✖ ${failures.length} check(s) failed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`✔ ${files.length} files checked`);
console.log(`✔ manifest v${manifestVersion}: ${manifest.permissions.join(', ')}`);
console.log(`✔ i18n: ${Object.keys(enMessages).length} EN keys / ${Object.keys(zhMessages).length} ZH keys`);
console.log(`✔ no <all_urls>`);
console.log(`✔ no remote code (${extensionFiles.length} extension files scanned: script src, eval, Function, fetch, XHR)`);
