import { spawnSync } from 'node:child_process';
import { assertDisposableTestUrl, resetTestDatabase } from './test-database.js';

const url = process.env.TEST_LIBSQL_URL;
if (!url) throw new Error('Set TEST_LIBSQL_URL=http://127.0.0.1:8080 for a disposable turso dev database');
assertDisposableTestUrl(url);
await resetTestDatabase(url);
console.log('Running the complete verification pipeline against disposable turso dev. Tests reset its schema.');
const result = spawnSync('pnpm', ['run', 'verify'], { stdio: 'inherit', env: { ...process.env, TEST_LIBSQL_URL: url, TURSO_AUTH_TOKEN: '' } });
if (result.error) throw result.error;
process.exitCode = result.status || (result.signal ? 1 : 0);
