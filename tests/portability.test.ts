import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildLaunchPath,
  createLaunchAgentPlist,
  escapeXml,
  findNodePath,
  getLaunchAgentPath
} = require('../scripts/portable-utils.cjs') as {
  buildLaunchPath: (options: { homeDir: string; nodePath: string; envPath: string }) => string;
  createLaunchAgentPlist: (options: { projectDir: string; nodePath: string; stdoutPath: string; stderrPath: string; envPath: string }) => string;
  escapeXml: (value: string) => string;
  findNodePath: (options: { env: NodeJS.ProcessEnv; execPath: string; existsSync: (candidate: string) => boolean }) => string;
  getLaunchAgentPath: (homeDir: string) => string;
};

describe('macOS launch agent and path lookup portability helpers', () => {
  it('should generate a valid Plist template string', () => {
    const plist = createLaunchAgentPlist({
      projectDir: '/Users/example/subscription-billing',
      nodePath: '/usr/local/bin/node',
      stdoutPath: '/Users/example/subscription-billing/server.log',
      stderrPath: '/Users/example/subscription-billing/server.err',
      envPath: '/usr/local/bin:/usr/bin:/bin'
    });

    // Note: since our main server is now server.ts, let's verify what it uses.
    // Wait, the plist generator might still refer to server.cjs or server.ts.
    // Let's assert based on what is in portable-utils.cjs.
    expect(plist.includes('/usr/local/bin/node')).toBe(true);
    expect(plist.includes('<key>WorkingDirectory</key>')).toBe(true);
    expect(plist.includes('/Users/local-only-accounting-host')).toBe(false);
  });

  it('should correctly escape XML strings', () => {
    const escaped = escapeXml('/tmp/a&b/"quote"');
    expect(escaped).toBe('/tmp/a&amp;b/&quot;quote&quot;');
  });

  it('should compute valid LaunchAgent path on macOS', () => {
    expect(getLaunchAgentPath('/Users/example')).toBe(
      '/Users/example/Library/LaunchAgents/com.nc8.subscription-billing.plist'
    );
  });

  it('should find node bin path correctly', () => {
    const nodePath = findNodePath({
      env: { PATH: '/repo/node_modules/.bin:/tmp/stable-bin', NODE_BIN: '' },
      execPath: '/tmp/fallback-node',
      existsSync(candidate: string) {
        return candidate === '/tmp/stable-bin/node';
      }
    });
    expect(nodePath).toBe('/tmp/stable-bin/node');
  });

  it('should filter out transient runner paths in computed Launch PATH', () => {
    const launchPath = buildLaunchPath({
      homeDir: '/Users/example',
      nodePath: '/Users/example/.local/share/pnpm/bin/node',
      envPath: '/repo/node_modules/.bin:/tmp/pnpm/store/node-gyp-bin:/var/run/codex/bin:/opt/homebrew/bin'
    });
    expect(launchPath.includes('/Users/example/.local/share/pnpm/bin')).toBe(true);
    expect(launchPath.includes('/opt/homebrew/bin')).toBe(true);
    expect(launchPath.includes('node_modules')).toBe(false);
    expect(launchPath.includes('node-gyp-bin')).toBe(false);
    expect(launchPath.includes('codex')).toBe(false);
  });
});
