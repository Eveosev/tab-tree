#!/usr/bin/env node
/**
 * Build a loadable, store-shaped zip: extension/ only, no node_modules, docs,
 * tests or scripts. Uses the system `zip` binary (macOS/Linux/CI images ship it).
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'extension');
const dist = path.join(root, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

if (manifest.version !== packageJson.version) {
  console.error(`Version mismatch: manifest ${manifest.version}, package.json ${packageJson.version}`);
  process.exit(1);
}

fs.mkdirSync(dist, { recursive: true });
const base = `tab-tree-v${manifest.version}`;
const zipPath = path.join(dist, `${base}.zip`);
fs.rmSync(zipPath, { force: true });

execFileSync(
  'zip',
  ['-r', '-q', '-X', zipPath, '.', '-x', '*.DS_Store', '-x', '__MACOSX/*'],
  { cwd: extension, stdio: 'inherit' },
);

const buffer = fs.readFileSync(zipPath);
const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
const files = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n');

console.log(`✔ ${path.relative(root, zipPath)}`);
console.log(`  files:  ${files.length}`);
console.log(`  size:   ${(buffer.length / 1024).toFixed(1)} KiB`);
console.log(`  sha256: ${sha256}`);
console.log(`  load:   chrome://extensions → Developer mode → Load unpacked → ${path.relative(root, extension)}/`);
