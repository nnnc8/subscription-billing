import { expect, it } from 'vitest';
import { assertDisposableTestUrl } from '../scripts/test-database.js';

it('restricts destructive database test setup to plain loopback URLs', () => {
    expect(() => assertDisposableTestUrl('http://127.0.0.1:8080')).not.toThrow();
    for (const url of ['libsql://production.example', 'http://example.com', 'http://user:password@localhost:8080', 'http://localhost:8080?token=fake', 'http://localhost:8080/database']) {
        expect(() => assertDisposableTestUrl(url)).toThrow(/Only a disposable/);
    }
});
