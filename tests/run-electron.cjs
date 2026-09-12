// Chromium holds its profile files open until Electron exits, especially on Windows.
// The parent owns the temporary profile and removes it after all child handles close.
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const electron = require('electron');
const fixture = process.argv[2];
if (!['player-tracks.cjs', 'setup-recovery.cjs'].includes(fixture)) throw new Error('Unknown Electron fixture');
const profile = mkdtempSync(join(tmpdir(), 'xiptv-test-'));
const child = spawn(electron, [join(__dirname, fixture)], {
  stdio: 'inherit', env: { ...process.env, XIPTV_TEST_PROFILE: profile },
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('close', code => {
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
  catch (error) { console.error(error); process.exitCode = 1; }
  process.exitCode ||= code ?? 1;
});
