const path = require('path');

const LABEL = 'com.nc8.subscription-billing';

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function normalizePath(value) {
    return path.resolve(value);
}

function getLaunchAgentPath(homeDir) {
    return path.join(homeDir, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function isEphemeralPath(entry) {
    return entry.includes(`node_modules${path.sep}.bin`)
        || entry.includes('node-gyp-bin')
        || entry.toLowerCase().includes('codex')
        || entry.includes(`${path.sep}.composio`)
        || entry === '/pkg/env/global/bin'
        || entry.includes(`${path.sep}.codex${path.sep}`)
        || entry.includes(`${path.sep}.pnpm${path.sep}store${path.sep}`);
}

function isStableLaunchPath(entry, homeDir) {
    return entry.startsWith(path.join(homeDir, '.local'))
        || entry.startsWith('/opt/homebrew/')
        || entry.startsWith('/usr/local/')
        || ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].includes(entry);
}

function buildLaunchPath({
    homeDir = require('os').homedir(),
    nodePath = process.execPath,
    envPath = process.env.PATH || ''
} = {}) {
    const envEntries = String(envPath)
        .split(path.delimiter)
        .filter(Boolean)
        .filter(entry => !isEphemeralPath(entry))
        .filter(entry => isStableLaunchPath(entry, homeDir));

    return unique([
        path.dirname(nodePath),
        path.join(homeDir, '.local', 'share', 'pnpm', 'bin'),
        path.join(homeDir, '.local', 'bin'),
        ...envEntries,
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin'
    ]).join(path.delimiter);
}

function findNodePath({ env = process.env, execPath = process.execPath, existsSync = require('fs').existsSync } = {}) {
    if (env.NODE_BIN) {
        return normalizePath(env.NODE_BIN);
    }

    const pathEntries = String(env.PATH || '')
        .split(path.delimiter)
        .filter(Boolean)
        .filter(entry => !entry.includes(`node_modules${path.sep}.bin`))
        .filter(entry => !entry.includes('node-gyp-bin'));

    for (const entry of pathEntries) {
        const candidate = path.join(entry, 'node');
        if (existsSync(candidate)) {
            return normalizePath(candidate);
        }
    }

    return normalizePath(execPath);
}

function createLaunchAgentPlist({
    projectDir,
    nodePath,
    stdoutPath,
    stderrPath,
    envPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    port = process.env.PORT || '3000',
    dataDir
}) {
    const resolvedProjectDir = normalizePath(projectDir);
    const resolvedNodePath = normalizePath(nodePath);
    const resolvedStdoutPath = normalizePath(stdoutPath || path.join(resolvedProjectDir, 'server.log'));
    const resolvedStderrPath = normalizePath(stderrPath || path.join(resolvedProjectDir, 'server.err'));
    const resolvedDataDir = normalizePath(dataDir || process.env.DATA_DIR || resolvedProjectDir);

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(resolvedNodePath)}</string>
        <string>${escapeXml(path.join(resolvedProjectDir, 'node_modules/tsx/dist/cli.mjs'))}</string>
        <string>${escapeXml(path.join(resolvedProjectDir, 'server.ts'))}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(resolvedProjectDir)}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escapeXml(envPath)}</string>
        <key>PORT</key>
        <string>${escapeXml(port)}</string>
        <key>DATA_DIR</key>
        <string>${escapeXml(resolvedDataDir)}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(resolvedStdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(resolvedStderrPath)}</string>
</dict>
</plist>
`;
}

module.exports = {
    LABEL,
    buildLaunchPath,
    createLaunchAgentPlist,
    escapeXml,
    findNodePath,
    getLaunchAgentPath
};
