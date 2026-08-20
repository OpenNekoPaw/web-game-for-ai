import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerName = process.platform === 'win32' ? 'ddz-server-worker.exe' : 'ddz-server-worker';
const bundledWorker = join(dirname(process.execPath), workerName);
const configuredEntry = process.env.DDZ_SERVER_ENTRY;
const useBundledWorker = !configuredEntry && existsSync(bundledWorker);
const command = useBundledWorker ? bundledWorker : process.execPath;
const args = useBundledWorker ? [] : [resolve(configuredEntry || join(sourceRoot, 'server.js'))];
const restartDelayMs = positiveInteger(process.env.DDZ_RESTART_DELAY_MS, 1000);
const workerPidFile = process.env.DDZ_WORKER_PID_FILE;

let child;
let restartTimer;
let stopping = false;

function launch() {
  child = spawn(command, args, {
    env: { ...process.env, DDZ_SUPERVISED: '1' },
    stdio: 'inherit'
  });

  if (workerPidFile) {
    try { writeFileSync(workerPidFile, String(child.pid)); }
    catch (error) { console.error('Failed to write DDZ worker PID file:', error); }
  }

  child.once('error', (error) => console.error('Failed to start DDZ server worker:', error));
  child.once('close', (code, signal) => {
    child = undefined;
    if (stopping) return process.exit(0);
    console.error(`DDZ server worker exited (${signal || code}); restarting in ${restartDelayMs}ms`);
    restartTimer = setTimeout(launch, restartDelayMs);
  });
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (!child) return process.exit(0);
  child.kill(signal);
  setTimeout(() => {
    if (child) child.kill('SIGKILL');
  }, 5000).unref();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

launch();
