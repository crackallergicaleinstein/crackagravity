/**
 * Publish this tree to GitHub using the credential the machine already has.
 *
 * - reads the stored `git:https://github.com` token from the Windows Credential
 *   Manager (never printed)
 * - creates the repository if it does not exist
 * - pushes the current branch
 *
 * Usage: node tools/publish.mjs <repo-name> [--private]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const repoName = process.argv[2] || 'agy';
const isPrivate = process.argv.includes('--private');

const PS = `
$src = @'
using System;
using System.Runtime.InteropServices;
public class PubCred {
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
  public static string ReadUtf16(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) throw new Exception("CredRead " + Marshal.GetLastWin32Error());
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return System.Text.Encoding.Unicode.GetString(b);
    } finally { CredFree(p); }
  }
}
'@
Add-Type -TypeDefinition $src
[PubCred]::ReadUtf16('git:https://github.com')
`;

const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], {
  encoding: 'utf8',
  windowsHide: true,
  timeout: 30_000,
});
const token = raw.replace(/\0/g, '').trim();
if (!/^(gh[pousr]_|github_pat_)/.test(token)) {
  console.error('no usable GitHub token in the credential store');
  process.exit(1);
}

const headers = {
  authorization: `token ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'agy-publish',
  'content-type': 'application/json',
};

const me = await (await fetch('https://api.github.com/user', { headers })).json();
if (!me.login) {
  console.error('token rejected by GitHub');
  process.exit(1);
}
console.log(`account: ${me.login}`);

let repo = await (await fetch(`https://api.github.com/repos/${me.login}/${repoName}`, { headers })).json();
if (!repo.full_name) {
  console.log(`creating ${me.login}/${repoName} (${isPrivate ? 'private' : 'public'})`);
  const created = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: repoName,
      description: 'Antigravity quota as an OpenAI/Claude endpoint — no harness prompt, no spawn',
      private: isPrivate,
      has_issues: true,
      has_wiki: false,
      auto_init: false,
    }),
  });
  repo = await created.json();
  if (!repo.full_name) {
    console.error('create failed:', JSON.stringify(repo).slice(0, 400));
    process.exit(1);
  }
} else {
  console.log(`repository exists: ${repo.full_name}`);
}

const askpass = path.join(os.tmpdir(), `agy-askpass-${Date.now()}.sh`);
fs.writeFileSync(askpass, '#!/bin/sh\nprintf "%s" "$AGY_GIT_TOKEN"\n', { mode: 0o700 });

const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
const remote = `https://github.com/${repo.full_name}.git`;

console.log(`pushing ${branch} -> ${repo.full_name}`);
const push = spawnSync('git', ['push', remote, `HEAD:${branch}`, '--force'], {
  stdio: 'inherit',
  env: { ...process.env, GIT_ASKPASS: askpass, AGY_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: '0' },
});
fs.rmSync(askpass, { force: true });

if (push.status !== 0) {
  console.error(`push failed with ${push.status}`);
  process.exit(push.status || 1);
}

const files = await (await fetch(`https://api.github.com/repos/${repo.full_name}/contents`, { headers })).json();
console.log(`pushed ${Array.isArray(files) ? files.length : '?'} top-level entries`);
console.log(repo.html_url);
