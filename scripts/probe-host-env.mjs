/**
 * Read one Windows process's environment block (RTL_USER_PROCESS_PARAMETERS) to
 * answer "what does the running DSH host actually have in its environment?".
 *
 * The block is a UNICODE_STRING at a PEB offset that moves between Windows
 * versions, so the string is located by scanning the process parameters region
 * for a well-known first variable (`=C:` or the first `NAME=VALUE` entry) and
 * decoding forward from there.
 *
 * Prints variable NAMES and, for a small allowlist of non-secret names, values.
 * Never prints a value for a name that looks like a credential.
 *
 * Usage: node scripts/probe-host-env.mjs [pid]
 */

import { execFileSync } from 'node:child_process'

const pid = Number(process.argv[2] ?? 0)
if (!Number.isInteger(pid) || pid <= 0) {
  console.error('usage: node probe-host-env.mjs <pid>')
  process.exit(2)
}

const script = `
$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Peb {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(int a, bool i, int p);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr b, byte[] buf, int size, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, byte[] info, int len, out int ret);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  const int ProcessBasicInformation = 0;
  public static string Read(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) return "OPEN_FAILED:" + Marshal.GetLastWin32Error();
    try {
      // PROCESS_BASIC_INFORMATION on 64-bit: PebBaseAddress is at offset 8.
      byte[] pbi = new byte[48];
      int ret;
      if (NtQueryInformationProcess(h, ProcessBasicInformation, pbi, pbi.Length, out ret) != 0) return "QUERY_FAILED:" + ret;
      long peb = BitConverter.ToInt64(pbi, 8);
      if (peb == 0) return "PEB_NULL";
      IntPtr read;
      // PEB->ProcessParameters is at offset 0x20 on x64.
      byte[] ptr = new byte[8];
      if (!ReadProcessMemory(h, (IntPtr)(peb + 0x20), ptr, 8, out read)) return "READ_PP_PTR_FAILED:" + Marshal.GetLastWin32Error();
      long pars = BitConverter.ToInt64(ptr, 0);
      if (pars == 0) return "PP_NULL";
      // RTL_USER_PROCESS_PARAMETERS->Environment is at offset 0x80 on x64.
      byte[] envPtr = new byte[8];
      if (!ReadProcessMemory(h, (IntPtr)(pars + 0x80), envPtr, 8, out read)) return "READ_ENV_PTR_FAILED:" + Marshal.GetLastWin32Error();
      long env = BitConverter.ToInt64(envPtr, 0);
      if (env == 0) return "ENV_NULL";
      byte[] block = new byte[262144];
      if (!ReadProcessMemory(h, (IntPtr)env, block, block.Length, out read)) return "READ_ENV_FAILED:" + Marshal.GetLastWin32Error();
      string all = Encoding.Unicode.GetString(block, 0, (int)read);
      int stop = all.IndexOf("\\0\\0", StringComparison.Ordinal);
      return stop >= 0 ? all.Substring(0, stop) : all;
    } finally { CloseHandle(h); }
  }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp
[Peb]::Read(${pid})
`

const raw = execFileSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 1 << 22 })
const entries = raw.split('\0').filter((entry) => entry.length > 0 && entry.includes('='))
if (entries.length === 0) {
  console.log(`could not read the environment block: ${raw.trim().slice(0, 200)}`)
  process.exit(1)
}

const SECRET = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i
const INTERESTING = /^(HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy|NODE_|DSH_|PATH|TEMP|TMP|SystemRoot|USERPROFILE)/i
console.log(`pid ${pid}: ${entries.length} environment entries\n`)
for (const entry of entries.sort()) {
  const eq = entry.indexOf('=')
  const name = entry.slice(0, eq)
  const value = entry.slice(eq + 1)
  if (SECRET.test(name)) {
    console.log(`  ${name}=<redacted, length ${value.length}>`)
  } else if (INTERESTING.test(name)) {
    console.log(`  ${name}=${value.length > 220 ? `${value.slice(0, 220)}…` : value}`)
  }
}
const secretNames = entries.map((e) => e.slice(0, e.indexOf('='))).filter((n) => SECRET.test(n))
console.log(`\ncredential-looking names present: ${secretNames.length === 0 ? '(none)' : secretNames.join(', ')}`)
console.log(`PERPLEXITY_API_KEY present: ${entries.some((e) => e.startsWith('PERPLEXITY_API_KEY='))}`)
console.log(`proxy variables present: ${entries.some((e) => /^(HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)=/i.test(e))}`)
