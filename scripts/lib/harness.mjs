#!/usr/bin/env node
/**
 * Small dependency-free browser harness shared by the browser E2E scripts.
 *
 * Wraps just enough of the Chrome DevTools Protocol (CDP) to:
 *   - find a Chrome/Chromium binary that honours `--load-extension`,
 *   - launch it with an isolated profile and a local HTTP fixture server,
 *   - locate the extension service worker and evaluate code in it,
 *   - drive real mouse/pointer input and read the side-panel DOM.
 *
 * No npm dependencies: Node's global fetch/WebSocket plus CDP JSON messages.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Branded Chrome 137+ ignores `--load-extension`, so prefer Chrome for Testing
 * or Chromium. `CHROME_PATH` always wins.
 */
export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [];
  const playwrightCache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  if (fs.existsSync(playwrightCache)) {
    for (const entry of fs
      .readdirSync(playwrightCache)
      .filter((name) => name.startsWith('chromium-'))
      .sort()
      .reverse()) {
      candidates.push(
        path.join(
          playwrightCache,
          entry,
          'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        ),
        path.join(
          playwrightCache,
          entry,
          'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        ),
        path.join(playwrightCache, entry, 'chrome-linux64/chrome'),
        path.join(playwrightCache, entry, 'chrome-linux/chrome'),
      );
    }
  }
  candidates.push(
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  );
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

/**
 * Poll `fn` until it returns a truthy value or the timeout expires.
 * @template T
 * @param {() => Promise<T>|T} fn
 * @param {{timeout?: number, interval?: number, label?: string}} [options]
 * @returns {Promise<T>}
 */
export async function waitFor(fn, { timeout = 15_000, interval = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

/** Minimal CDP client with request/response + event listeners. */
export class CDP {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 10_000);
      this.socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error(`WebSocket error: ${event.message || 'unknown'}`));
      });
    });
    this.socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
        return;
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params);
      }
    });
    this.socket.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP closed'));
      this.pending.clear();
    });
    return this;
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
    return () => this.listeners.get(method)?.delete(listener);
  }

  send(method, params = {}) {
    if (!this.socket || this.closed) return Promise.reject(new Error('CDP not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 20_000);
    });
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed';
      throw new Error(detail);
    }
    return result.result?.value;
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      /* noop */
    }
  }
}

/**
 * Fixture HTTP server. `pages` maps a pathname to `{title, body}`; unknown
 * paths fall back to `/`. Each fixture body is inserted into a minimal page.
 *
 * @param {Record<string, {title: string, body: string}>} pages
 */
export function startServer(pages) {
  const fallback = pages['/'] || { title: 'Fixture', body: '<p>fixture</p>' };
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const page = pages[pathname] || fallback;
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>${page.title}</title>` +
        `<style>body{font:15px system-ui;padding:32px;max-width:720px;line-height:1.7}` +
        `a{display:inline-block;margin:0 14px 10px 0}</style></head><body>${page.body}</body></html>`,
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/**
 * Launch Chrome with the unpacked extension loaded.
 *
 * @param {Object} options
 * @param {string} options.chromePath
 * @param {string} options.profile  user-data-dir (created by the caller)
 * @param {string} options.extension
 * @param {string[]} [options.extraArgs]
 * @param {string} [options.startupPage]
 * @returns {Promise<{chrome: import('node:child_process').ChildProcess, port: number, base: string, logFile: string}>}
 */
export async function launchChrome({
  chromePath,
  profile,
  extension,
  extraArgs = [],
  startupPage = 'about:blank',
}) {
  const logFile = path.join(profile, `chrome-${Date.now()}.log`);
  const out = fs.openSync(logFile, 'w');
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-service-autorun',
      '--password-store=basic',
      '--use-mock-keychain',
      `--user-data-dir=${profile}`,
      `--load-extension=${extension}`,
      `--disable-extensions-except=${extension}`,
      '--remote-debugging-port=0',
      ...extraArgs,
      startupPage,
    ],
    { stdio: ['ignore', out, out] },
  );

  const portFile = path.join(profile, 'DevToolsActivePort');
  const port = await waitFor(
    () => {
      if (!fs.existsSync(portFile)) return null;
      const value = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
      return value || null;
    },
    { timeout: 25_000, label: 'DevToolsActivePort' },
  );
  await sleep(400);
  return { chrome, port, base: `http://127.0.0.1:${port}`, logFile };
}

export async function jsonTargets(base) {
  const response = await fetch(`${base}/json/list`);
  if (!response.ok) throw new Error(`/json/list ${response.status}`);
  return response.json();
}

/** Wait for the extension's service worker and return a connected client. */
export async function waitForWorker(base, { name = 'Tab Tree', timeout = 25_000 } = {}) {
  return waitFor(
    async () => {
      for (const target of await jsonTargets(base)) {
        if (target.type !== 'service_worker' || !target.url.startsWith('chrome-extension://')) continue;
        const client = new CDP(target.webSocketDebuggerUrl);
        try {
          await client.connect();
          await client.send('Runtime.enable');
          const manifestName = await Promise.race([
            client.evaluate('chrome.runtime.getManifest?.().name || ""'),
            sleep(2000).then(() => null),
          ]);
          if (manifestName === name) return { client, target, extensionId: new URL(target.url).host };
        } catch {
          /* not our worker */
        }
        client.close();
      }
      return null;
    },
    { timeout, label: `${name} service worker` },
  );
}

/** Wait for a page target whose URL contains `urlPart` and connect to it. */
export async function connectPage(base, urlPart, { timeout = 20_000 } = {}) {
  const target = await waitFor(
    async () => {
      const targets = await jsonTargets(base);
      return targets.find((item) => item.type === 'page' && item.url.includes(urlPart)) || null;
    },
    { timeout, label: `page ${urlPart}` },
  );
  const client = new CDP(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  return { client, target };
}

export function waitExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode);
    child.once('exit', resolve);
  });
}

/** Gracefully close Chrome through CDP, then force-kill if it lingers. */
export async function closeChrome(base, chrome, { timeout = 12_000 } = {}) {
  try {
    const targets = await jsonTargets(base);
    const target = targets.find((item) => item.webSocketDebuggerUrl);
    if (target) {
      const client = new CDP(target.webSocketDebuggerUrl);
      await client.connect();
      client.send('Browser.close').catch(() => {});
      await sleep(1000);
      client.close();
    }
  } catch {
    /* browser already gone */
  }
  await Promise.race([waitExit(chrome), sleep(timeout)]);
  if (chrome.exitCode === null && chrome.signalCode === null) {
    try {
      chrome.kill('SIGTERM');
    } catch {
      /* noop */
    }
    await Promise.race([waitExit(chrome), sleep(5000)]);
  }
}

/** Check collector that prints a consistent ✔/✖ report. */
export function createChecker(label) {
  const results = [];
  const failures = [];
  return {
    results,
    failures,
    check(name, condition, detail = '') {
      if (condition) {
        results.push(`  ✔ ${name}`);
      } else {
        failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
        results.push(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`);
      }
    },
    finish() {
      console.log(`${label}\n${results.join('\n')}`);
      console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
      if (failures.length > 0) {
        console.error(`\n${failures.length} failure(s):`);
        for (const failure of failures) console.error(`  - ${failure}`);
        process.exitCode = 1;
      }
      return failures.length === 0;
    },
  };
}

/** Remove a temporary profile directory, refusing to touch anything else. */
export function cleanupProfile(profile, prefix) {
  if (!profile || !prefix) return;
  const resolved = path.resolve(profile);
  const safeRoot = path.resolve(os.tmpdir(), prefix);
  if (resolved === safeRoot || !resolved.startsWith(`${safeRoot}-`)) return;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Guard used by scripts so they fail loudly instead of silently skipping. */
export function requireChrome() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.error('Chrome/Chromium not found. Set CHROME_PATH to Chrome for Testing or Chromium.');
    process.exit(1);
  }
  if (chromePath.includes('Google Chrome.app') && !chromePath.includes('for Testing')) {
    console.error(
      'Branded Chrome 137+ ignores --load-extension. Set CHROME_PATH to Chrome for Testing or Chromium.',
    );
    process.exit(1);
  }
  return chromePath;
}
