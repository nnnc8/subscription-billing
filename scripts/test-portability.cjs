const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    buildLaunchPath,
    createLaunchAgentPlist,
    escapeXml,
    findNodePath,
    getLaunchAgentPath
} = require('./portable-utils.cjs');

const plist = createLaunchAgentPlist({
    projectDir: '/Users/example/subscription-billing',
    nodePath: '/usr/local/bin/node',
    stdoutPath: '/Users/example/subscription-billing/server.log',
    stderrPath: '/Users/example/subscription-billing/server.err',
    envPath: '/usr/local/bin:/usr/bin:/bin'
});

assert(plist.includes('/Users/example/subscription-billing/server.ts'));
assert(plist.includes('/Users/example/subscription-billing/node_modules/tsx/dist/cli.mjs'));
assert(!plist.includes('server.cjs'));
assert(plist.includes('/usr/local/bin/node'));
assert(plist.includes('<key>WorkingDirectory</key>'));
assert(plist.includes('<key>DATA_DIR</key>'));
assert(!plist.includes('/Users/local-only-accounting-host'));

const projectRoot = path.resolve(__dirname, '..');
const startScript = fs.readFileSync(path.join(projectRoot, 'start.sh'), 'utf8');
const staticPlist = fs.readFileSync(path.join(projectRoot, 'com.nc8.subscription-billing.plist'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
assert(startScript.includes('pnpm run start'));
assert(staticPlist.includes('node_modules/tsx/dist/cli.mjs'));
assert(staticPlist.includes('__PROJECT_DIR__/server.ts'));
assert(!startScript.includes('server.cjs'));
assert(!staticPlist.includes('server.cjs'));
assert.strictEqual(packageJson.scripts.start, 'tsx server.ts');

const escaped = escapeXml('/tmp/a&b/"quote"');
assert.strictEqual(escaped, '/tmp/a&amp;b/&quot;quote&quot;');

assert.strictEqual(
    getLaunchAgentPath('/Users/example'),
    '/Users/example/Library/LaunchAgents/com.nc8.subscription-billing.plist'
);

assert.strictEqual(
    findNodePath({
        env: { PATH: '/repo/node_modules/.bin:/tmp/stable-bin', NODE_BIN: '' },
        execPath: '/tmp/fallback-node',
        existsSync(candidate) {
            return candidate === '/tmp/stable-bin/node';
        }
    }),
    '/tmp/stable-bin/node'
);

const launchPath = buildLaunchPath({
    homeDir: '/Users/example',
    nodePath: '/Users/example/.local/share/pnpm/bin/node',
    envPath: '/repo/node_modules/.bin:/tmp/pnpm/store/node-gyp-bin:/var/run/codex/bin:/opt/homebrew/bin'
});
assert(launchPath.includes('/Users/example/.local/share/pnpm/bin'));
assert(launchPath.includes('/opt/homebrew/bin'));
assert(!launchPath.includes('node_modules'));
assert(!launchPath.includes('node-gyp-bin'));
assert(!launchPath.includes('codex'));

console.log('Portability helpers verification passed.');
