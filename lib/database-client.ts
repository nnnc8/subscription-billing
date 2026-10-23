import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient as createRemoteClient } from '@libsql/client/web';
import type { Client, Config, Transaction, TransactionMode } from '@libsql/client';

type FileConnection = {
    url: string;
    client?: Client;
    references: number;
    pending: number;
    tail: Promise<void>;
};
const files = new Map<string, FileConnection>();
// Bind the remote transport to the fetch present at startup, so code that later
// replaces globalThis.fetch (tests faking Gemini or the browser API) cannot intercept it.
const remoteFetch = globalThis.fetch.bind(globalThis);
// The Node entry loads libsql's native binary on import, and a Vercel bundle carries
// none, so only local file databases load it, on first use.
let nodeDriver: Promise<typeof import('@libsql/client')> | undefined;
async function createFileClient(config: Config): Promise<Client> {
    nodeDriver ??= import('@libsql/client');
    return (await nodeDriver).createClient(config);
}

// Resolve existing parent symlinks even when the database does not exist yet.
function canonicalPath(filename: string): string {
    const absolute = path.resolve(filename);
    if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(canonicalPath(parent), path.basename(absolute));
}

/** Lazy clients: construction never creates a directory, file, or connection. */
export function openDatabase(urlOrPath: string, authToken?: string): Client {
    const url = /^(file|https?|libsql|wss?):/.test(urlOrPath) ? urlOrPath : pathToFileURL(path.resolve(urlOrPath)).href;
    const file = url.startsWith('file:');
    const key = file ? pathToFileURL(canonicalPath(fileURLToPath(url))).href : url;
    let shared = file ? files.get(key) : undefined;
    if (!shared) {
        shared = { url: key, references: 0, pending: 0, tail: Promise.resolve() };
        if (file) files.set(key, shared);
    }
    const connection = shared;
    connection.references++;
    let closed = false;

    function dispose(): void {
        const retired = connection.client;
        delete connection.client;
        // Do not let a damaged native connection's close mask the original error
        // or prevent the queue lease from being released.
        try { retired?.close(); } catch { /* This connection is never reused. */ }
    }
    function cleanup(): void {
        if (connection.references || connection.pending) return;
        dispose();
        if (file && files.get(key) === connection) files.delete(key);
    }
    // Callers hold the queue lease, so a file connection is never created twice.
    async function rawClient(): Promise<Client> {
        if (!connection.client) {
            const config: Config = { url: key, ...(authToken ? { authToken } : {}), concurrency: 1, timeout: 0 };
            if (file) {
                fs.mkdirSync(path.dirname(fileURLToPath(key)), { recursive: true });
                connection.client = await createFileClient(config);
            } else connection.client = createRemoteClient({ ...config, fetch: remoteFetch });
        }
        return connection.client;
    }
    // A transaction holds this lease through close, including rollback on failure.
    async function acquire(): Promise<() => void> {
        if (closed) throw new Error('Database client is closed');
        connection.pending++;
        let releaseGate!: () => void;
        const gate = new Promise<void>(resolve => { releaseGate = resolve; });
        const previous = file ? connection.tail : Promise.resolve();
        if (file) connection.tail = previous.then(() => gate);
        await previous;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            connection.pending--;
            releaseGate();
            cleanup();
        };
    }
    async function transaction(mode?: TransactionMode): Promise<Transaction> {
        const release = await acquire();
        let tx: Transaction;
        try { tx = await (await rawClient()).transaction(mode); }
        catch (error) { if (file) dispose(); release(); throw error; }
        let finished = false;
        let poisoned = false;
        function finish(): void {
            if (finished) return;
            finished = true;
            try { tx.close(); }
            catch (error) { poisoned = true; throw error; }
            finally { if (poisoned && file) dispose(); release(); }
        }
        return new Proxy(tx, {
            get(target, property) {
                if (property === 'close') return finish;
                const value: unknown = Reflect.get(target, property, target);
                if (typeof value !== 'function') return value;
                return async (...args: unknown[]) => {
                    try { return await Reflect.apply(value, target, args); }
                    catch (error) { poisoned = true; throw error; }
                    finally {
                        if (property === 'commit' || property === 'rollback') finish();
                    }
                };
            }
        });
    }
    const overrides = {
        transaction,
        close() { if (!closed) { closed = true; connection.references--; cleanup(); } },
        get closed() { return closed; },
        get protocol() { return file ? 'file' : new URL(url).protocol.slice(0, -1); }
    };
    const invoke = (property: PropertyKey) => async (...args: unknown[]) => {
        const release = await acquire();
        try {
            const raw = await rawClient();
            return await Reflect.apply(Reflect.get(raw, property, raw), raw, args);
        } catch (error) {
            // Never reuse a native connection after an unsuccessful operation.
            if (file) dispose();
            throw error;
        } finally { release(); }
    };
    for (const name of ['execute', 'batch', 'executeMultiple', 'migrate', 'sync', 'reconnect']) {
        Object.defineProperty(overrides, name, { value: invoke(name), configurable: true, writable: true });
    }
    return new Proxy(overrides as unknown as Client, {
        get(target, property) {
            if (property in overrides) return Reflect.get(target, property, target);
            // Client methods (execute/batch/executeMultiple/sync/migrate) all share the file queue.
            return invoke(property);
        }
    });
}
