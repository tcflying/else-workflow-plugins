// Installs the per-user Startup-folder autostart for the sidecar watchdog, then optionally
// launches the loop once. The VBS content is built here (not inline in a shell) so every
// backslash and quote survives. VBScript quoting is DOUBLED quotes (""), and the paths come
// from fileURLToPath so non-ASCII directory names are never percent-encoded.
// The Startup folder is used because schtasks /Create is denied for this user on this machine
// (verified 2026-10-09, even for trivial tasks).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const watchdog = path.join(here, 'sidecar-watchdog.mjs');
const nodeExe = process.execPath;
const startupDir = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const vbsPath = path.join(startupDir, 'mmxdwf-sidecar-watchdog.vbs');

// VBScript: inner quotes are doubled; the whole Run argument is one VBS string.
const runArg = '""' + nodeExe + '"" ""' + watchdog + '""';
const vbs = 'CreateObject("WScript.Shell").Run "' + runArg + '", 0, False\n';

if (process.argv.includes('--write')) {
  fs.mkdirSync(startupDir, { recursive: true });
  fs.writeFileSync(vbsPath, vbs, 'utf8');
  const back = fs.readFileSync(vbsPath, 'utf8');
  console.log('vbs=' + vbsPath);
  console.log('content=' + JSON.stringify(back));
  console.log('paths-ok=' + (back.includes(nodeExe) && back.includes(watchdog)));
}
if (process.argv.includes('--launch')) {
  const child = spawn('wscript.exe', [vbsPath], { detached: true, stdio: 'ignore' });
  child.unref();
  console.log('launched-via-vbs');
}
