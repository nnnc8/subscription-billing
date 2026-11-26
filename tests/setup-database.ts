import { beforeEach } from 'vitest';
import { assertDisposableTestUrl, resetTestDatabase } from '../scripts/test-database.js';

const url = process.env.TEST_LIBSQL_URL;
if (url) {
    assertDisposableTestUrl(url);
    // Files run serially. Reset only the explicitly selected disposable database.
    beforeEach(async () => {
        await resetTestDatabase(url);
    });
}
