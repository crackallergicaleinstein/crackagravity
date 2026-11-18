/**
 * Discovery for everything an Antigravity install can move or lose.
 *
 * Nothing here assumes a path, a keyring name or an OAuth client pair. Every
 * value is located on the machine it runs on, verified, and cached against a
 * fingerprint of the binary so an update triggers a rescan instead of a
 * hardcoded failure.
 *
 * Resolution order:
 *   binary     env → config → known install dirs → registry uninstall keys →
 *              running process → PATH → bounded home scan
 *   keyring    env → config → name-scored wincred scan → full wincred blob scan
 *   client     cached pair (fingerprint-checked) → binary scan → built-in
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CACHE_DIR = process.env.AGY_TOKEN_DIR
  || path.join(os.homedir(), '.gemini', 'antigravity-direct');
const CACHE_FILE = path.join(CACHE_DIR, 'credentials.json');
const CONFIG_FILE = path.join(CACHE_DIR, 'config.json');

/**
 * Last resort when no installed binary is visible.
 *
 * The desktop OAuth pair is a constant inside the vendor's binary, so this repo
 * does not ship it: point the environment at a pair, or let the scanner read it
 * out of an installed client. (A pair extracted from your own install can be
 * pinned here locally, but it does not belong in a public tree.)
 */
const FALLBACK = {
  client_id: process.env.AGY_CLIENT_ID || '',
  client_secret: process.env.AGY_CLIENT_SECRET || '',
};

const PS_SOURCE = `
using System;
using System.Runtime.InteropServices;
public class OllCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount;
    public IntPtr Attributes;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
    [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode, EntryPoint="CredReadW")]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern void CredFree(IntPtr cred);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode, EntryPoint="CredEnumerateW")]
  public static extern bool CredEnumerateW(string filter, uint flags, out uint count, out IntPtr creds);
  public static string[] List() {
    IntPtr p; uint n;
    if (!CredEnumerateW(null, 0, out n, out p)) return new string[0];
    var outv = new string[n];
    try {
      for (uint i = 0; i < n; i++) {
        IntPtr item = Marshal.ReadIntPtr(p, (int)(i * IntPtr.Size));
        CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(item, typeof(CREDENTIAL));
        outv[i] = c.TargetName + "\\u0001" + c.UserName;
      }
    } finally { CredFree(p); }
    return outv;
  }
  public static string Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return System.Text.Encoding.UTF8.GetString(b);
    } finally { CredFree(p); }
  }
}
`;

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
}

function psWithSource(body) {
  return ps(`$src = @'\n${PS_SOURCE}\n'@\nAdd-Type -TypeDefinition $src\n${body}`);
}

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function saveCache(patch) {
  const next = { ...(loadCache() || {}), ...patch };
  fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export function invalidateClient() {
  if (loadCache()) saveCache({ stale: true });
}

/* ─────────────────────────────── keyring ─────────────────────────────── */

/**
 * One PowerShell pass: enumerate every generic credential, read it, and return
 * the ones that carry a Google OAuth refresh token. Name-agnostic on purpose —
 * a release that renames the target still resolves.
 */
export function scanCredentials() {
  const body = `
$out = New-Object System.Collections.ArrayList
foreach ($entry in [OllCred]::List()) {
  $parts = $entry -split [char]1
  $target = $parts[0]
  $user = if ($parts.Length -gt 1) { $parts[1] } else { '' }
  if ([string]::IsNullOrWhiteSpace($target)) { continue }
  $blob = $null
  try { $blob = [OllCred]::Read($target) } catch { $blob = $null }
  if (-not $blob) { continue }
  if ($blob -notmatch 'refresh_token') { continue }
  $email = ''
  $m = [regex]::Match($blob, '"id_token_email"\\s*:\\s*"([^"]+)"')
  if ($m.Success) { $email = $m.Groups[1].Value }
  $obj = [ordered]@{ target = $target; user = $user; email = $email; google = ($blob -match 'googleapis|ya29\\.') }
  [void]$out.Add($obj)
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 4
`;
  let raw;
  try {
    raw = psWithSource(body);
  } catch (e) {
    throw Object.assign(new Error(`credential scan failed: ${(e.stderr || e.message || '').trim()}`), { code: 'KEYRING' });
  }
  const start = raw.search(/\[|\{/);
  if (start < 0) return [];
  try {
    const parsed = JSON.parse(raw.slice(start));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** Score a credential target for "this is the Antigravity auth entry". */
function scoreTarget({ target = '', user = '', email = '', google = false }) {
  const name = `${target} ${user}`.toLowerCase();
  let score = 0;
  if (/gemini:antigravity/.test(name)) score += 100;
  if (/antigravity/.test(name)) score += 40;
  if (/gemini/.test(name)) score += 20;
  if (/cloudcode|codeassist|aicode/.test(name)) score += 15;
  if (/oauth|token|auth/.test(name)) score += 10;
  if (google) score += 5;
  if (email) score += 5;
  return score;
}

/** The best credential that actually holds a refresh token. */
export function findAuthTarget({ all = null } = {}) {
  const cached = loadCache();
  const entries = all || scanCredentials();
  const usable = entries.filter((e) => e.target);
  if (usable.length === 0) return null;

  if (cached?.keyring_target && usable.some((e) => e.target === cached.keyring_target)) {
    return cached.keyring_target;
  }
  const ranked = usable
    .map((e) => ({ ...e, score: scoreTarget(e) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.target || null;
}

export function readCredential(target) {
  const quoted = `'${String(target).replace(/'/g, "''")}'`;
  const raw = psWithSource(`[OllCred]::Read(${quoted})`);
  if (!raw || /^null/i.test(raw.trim())) return null;
  return raw;
}

/* ─────────────────────────────── binary ─────────────────────────────── */

function fingerprintOf(file, { allowAnyExe = false } = {}) {
  try {
    if (!allowAnyExe && !/^agy[\w.-]*\.exe$/i.test(path.basename(file))) return null;
    const st = fs.statSync(file);
    if (!st.isFile() || st.size < 500_000) return null;
    return { path: file, size: st.size, mtimeMs: Math.round(st.mtimeMs), fingerprint: `${st.size}:${Math.round(st.mtimeMs)}` };
  } catch {
    return null;
  }
}

function knownInstallDirs() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || '';
  const roaming = process.env.APPDATA || '';
  const out = [
    path.join(home, '.gemini', 'bin', 'agy.exe'),
    path.join(home, '.gemini', 'antigravity', 'bin', 'agy.exe'),
    path.join(home, '.gemini', 'antigravity-cli', 'agy.exe'),
    path.join(home, '.gemini', 'antigravity-cli', 'bin', 'agy.exe'),
    path.join(home, 'AppData', 'Local', 'Programs', 'agy', 'agy.exe'),
  ];
  for (const base of [
    path.join(local, 'Programs'),
    path.join(local, 'Antigravity'),
    path.join(roaming, 'Antigravity'),
    process.env.ProgramFiles || '',
    process.env['ProgramFiles(x86)'] || '',
  ]) {
    if (!base) continue;
    out.push(path.join(base, 'agy.exe'));
    out.push(path.join(base, 'Antigravity', 'agy.exe'));
    out.push(path.join(base, 'Antigravity', 'bin', 'agy.exe'));
  }
  return out;
}

/** Registry Uninstall entries whose DisplayName mentions Antigravity/Gemini. */
function registryInstallDirs() {
  const script = `
$paths = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
foreach ($p in $paths) {
  Get-ItemProperty $p -ErrorAction SilentlyContinue | Where-Object {
    $_.DisplayName -and ($_.DisplayName -match 'antigravity|gemini')
  } | ForEach-Object {
    if ($_.InstallLocation) { $_.InstallLocation }
    if ($_.DisplayIcon) { $_.DisplayIcon }
  }
}`;
  try {
    return ps(script).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Binary path of a running agy/antigravity process, if one is up. */
function runningBinaryPaths() {
  const script = `
Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -match 'agy|antigravity|language_server' } |
  ForEach-Object { try { $_.MainModule.FileName } catch { } }`;
  try {
    return ps(script).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function whichAgy() {
  try {
    const out = execFileSync('where.exe', ['agy.exe'], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Bounded scan for an agy binary under the places an installer would use. */
function scanForBinary() {
  const roots = [
    path.join(os.homedir(), '.gemini'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs'),
    path.join(os.homedir(), 'AppData', 'Roaming'),
    path.join(os.homedir(), 'scoop', 'apps'),
    path.join(os.homedir(), 'AppData', 'Local'),
    process.env.ProgramFiles || '',
  ].filter(Boolean);

  const found = [];
  for (const root of roots) {
    const walk = (dir, depth) => {
      if (depth > 4 || found.length > 6) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (found.length > 6) return;
        const full = path.join(dir, entry.name);
        if (entry.isFile() && /^agy[\w.-]*\.exe$/i.test(entry.name)) {
          found.push(full);
        } else if (entry.isDirectory() && !/node_modules|WindowsApps|\.git|Cache/i.test(entry.name)) {
          walk(full, depth + 1);
        }
      }
    };
    walk(root, 0);
  }
  return found;
}

/**
 * Locate an installed agy binary, trying cheap sources first.
 * Returns `{path, size, fingerprint, via}` or null.
 */
export function findBinary({ thorough = false } = {}) {
  const config = loadConfig();
  const candidates = [
    [process.env.AGY_BIN, 'env', true],
    [config.binary_path, 'config', true],
    ...knownInstallDirs().map((p) => [p, 'known-path', false]),
    ...registryInstallDirs().map((p) => [p, 'registry', false]),
    ...runningBinaryPaths().map((p) => [p, 'process', false]),
    ...whichAgy().map((p) => [p, 'path', false]),
  ];

  for (const [candidate, via, explicit] of candidates) {
    if (!candidate || typeof candidate !== 'string') continue;
    const clean = candidate.replace(/^"|"$/g, '');
    const resolved = /\.exe$/i.test(clean) ? clean : path.join(clean, 'agy.exe');
    if (explicit) {
      const direct = fingerprintOf(resolved, { allowAnyExe: true });
      if (direct) return { ...direct, via };
    }
    const found = fingerprintOf(resolved);
    if (found) return { ...found, via };
  }

  for (const candidate of scanForBinary()) {
    const found = fingerprintOf(candidate);
    if (found) return { ...found, via: 'scan' };
  }
  return null;
}

/* ─────────────────────────────── client pair ─────────────────────────────── */

export function extractCandidates(binaryPath) {
  const buf = fs.readFileSync(binaryPath, 'latin1');
  const ids = [...new Set([
    ...buf.matchAll(/[0-9]{6,}-[a-z0-9]{15,}\.apps\.googleusercontent\.com/g),
  ].map((m) => m[0]))];

  // Google desktop secrets are a fixed 28 chars after the prefix, and the Go
  // string constants are packed back-to-back, so a loose match drags the next
  // identifier along ("…ZtsX" + "https"). Emit the 28-char slice first.
  const secrets = new Set();
  for (const m of buf.matchAll(/GOCSPX-[A-Za-z0-9_-]{20,}/g)) {
    const body = m[0].slice('GOCSPX-'.length);
    secrets.add(`GOCSPX-${body.slice(0, 28)}`);
    if (body.length > 28) secrets.add(m[0]);
  }
  return { ids, secrets: [...secrets] };
}

/** True when Google accepts the pair — `invalid_grant` means the client authenticated. */
async function acceptsPair(clientId, clientSecret, refreshToken) {
  if (!refreshToken) return false;
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    if (res.ok) return true;
    const body = await res.json().catch(() => ({}));
    return body.error === 'invalid_grant';
  } catch {
    return false;
  }
}

let inflight = null;

/** Resolve client credentials, verifying the pair against the live token endpoint. */
export async function resolveClient({ refreshToken, force = false } = {}) {
  if (!force && !inflight) {
    const cached = loadCache();
    const binary = findBinary();
    if (cached?.client_id && cached?.client_secret && !cached.stale) {
      const weakSource = /^fallback/.test(String(cached.source || ''));
      // A fallback pair is only good while no install is visible; once a binary
      // shows up, prefer the pair that came out of it.
      if (!binary || (!weakSource && (!cached.binary_fingerprint || binary.fingerprint === cached.binary_fingerprint))) {
        return { client_id: cached.client_id, client_secret: cached.client_secret, source: cached.source || 'cache', binary };
      }
      if (await acceptsPair(cached.client_id, cached.client_secret, refreshToken)) {
        if (binary.fingerprint === cached.binary_fingerprint || weakSource) {
          // Same install (or a stronger source is available): re-resolve below.
        } else {
          saveCache({ ...cached, stale: false, binary_fingerprint: binary.fingerprint, binary_path: binary.path });
          return { client_id: cached.client_id, client_secret: cached.client_secret, source: 'cache+revalidated', binary };
        }
      }
    }
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const binary = findBinary({ thorough: true });
    if (binary) {
      const { ids, secrets } = extractCandidates(binary.path);
      for (const client_id of ids) {
        for (const client_secret of secrets) {
          if (await acceptsPair(client_id, client_secret, refreshToken)) {
            saveCache({
              client_id,
              client_secret,
              source: 'binary',
              stale: false,
              binary_path: binary.path,
              binary_via: binary.via,
              binary_fingerprint: binary.fingerprint,
              discovered_at: new Date().toISOString(),
            });
            return { client_id, client_secret, source: 'binary', binary };
          }
        }
      }
    }
    if (FALLBACK.client_id && FALLBACK.client_secret
      && await acceptsPair(FALLBACK.client_id, FALLBACK.client_secret, refreshToken)) {
      saveCache({
        ...FALLBACK,
        source: binary ? 'fallback' : 'fallback-no-binary',
        stale: false,
        binary_path: binary?.path,
        binary_fingerprint: binary?.fingerprint,
        discovered_at: new Date().toISOString(),
      });
      return { ...FALLBACK, source: binary ? 'fallback' : 'fallback-no-binary', binary };
    }
    throw Object.assign(
      new Error(binary
        ? 'no OAuth client pair accepted by the token endpoint — the install may be too new; set AGY_CLIENT_ID / AGY_CLIENT_SECRET'
        : 'no agy binary found — install the client once, or set AGY_CLIENT_ID / AGY_CLIENT_SECRET to the desktop OAuth pair'),
      { code: 'NO_CLIENT' },
    );
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export const paths = { CACHE_DIR, CACHE_FILE, CONFIG_FILE, FALLBACK };
