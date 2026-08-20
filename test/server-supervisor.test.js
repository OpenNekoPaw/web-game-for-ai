import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('server supervisor restarts a crashed worker', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ddz-supervisor-'));
  const worker = join(directory, 'worker.mjs');
  const countFile = join(directory, 'starts.txt');
  await writeFile(worker, `
    import { readFileSync, writeFileSync } from 'node:fs';
    const file = process.env.DDZ_TEST_COUNT_FILE;
    let count = 0;
    try { count = Number(readFileSync(file, 'utf8')); } catch {}
    writeFileSync(file, String(count + 1));
    if (count === 0) process.exit(17);
    setInterval(() => {}, 1000);
  `);

  const child = spawn(process.execPath, ['scripts/supervise-server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DDZ_SERVER_ENTRY: worker,
      DDZ_TEST_COUNT_FILE: countFile,
      DDZ_RESTART_DELAY_MS: '10'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    child.kill('SIGTERM');
    await rm(directory, { recursive: true, force: true });
  });

  await waitFor(async () => Number(await readFile(countFile, 'utf8').catch(() => '0')) >= 2);
  assert.equal(child.exitCode, null);
  assert.match(stderr, /restarting in 10ms/);
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for supervisor restart');
}
