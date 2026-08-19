import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundled = import.meta.url.includes('/$bunfs/');
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const executableRoot = dirname(process.execPath);

export const assetsDirectory = process.env.DDZ_ASSETS_DIR
  ? resolve(process.env.DDZ_ASSETS_DIR)
  : bundled ? join(executableRoot, 'share') : sourceRoot;

export const recordsDirectory = process.env.DDZ_RECORDS_DIR
  ? resolve(process.env.DDZ_RECORDS_DIR)
  : bundled ? join(executableRoot, 'records') : join(sourceRoot, 'records');
