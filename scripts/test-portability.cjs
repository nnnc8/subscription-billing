const assert = require('assert');

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

assert(plist.includes('/Users/example/subscription-billing/server.cjs'));
assert(plist.includes('/usr/local/bin/node'));
assert(plist.includes('<key>WorkingDirectory</key>'));
assert(!plist.includes('/Users/local-only-accounting-host'));

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
