import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.platform === 'win32') {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./prepare-download-engine.ps1', import.meta.url))], { stdio: 'inherit', windowsHide: true });
}
