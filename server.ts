import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv } from './lib/env.js';
import { createApp } from './server/app.js';
import { createRuntime } from './server/runtime.js';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export async function startServer() {
    loadLocalEnv({ cwd: rootDir });
    const runtime = createRuntime({ rootDir });
    if (runtime.isCloudBinding() && !runtime.isAuthConfigured()) {
        throw new Error('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_ALLOWED_EMAILS, and APP_SESSION_SECRET are required when binding to a public host or running production.');
    }

    await runtime.initializeAtomic();
    await runtime.runStartupLifecycle();
    const app = createApp({ runtime });
    return app.listen(runtime.config.port, runtime.config.host, () => {
        console.log(`Server is running on http://${runtime.config.host}:${runtime.config.port}`);
        console.log(`Data directory: ${runtime.paths.dataDir}`);
        if (runtime.config.host !== '0.0.0.0') return;

        for (const addresses of Object.values(os.networkInterfaces())) {
            for (const address of addresses || []) {
                if (address.family === 'IPv4' && !address.internal) {
                    console.log(`手機或平板請連線同一個 Wi-Fi 並瀏覽：http://${address.address}:${runtime.config.port}`);
                }
            }
        }
    });
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
    startServer().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
