const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    LABEL,
    buildLaunchPath,
    createLaunchAgentPlist,
    findNodePath,
    getLaunchAgentPath
} = require('./portable-utils.cjs');

if (process.platform !== 'darwin') {
    console.error('launchd install is only available on macOS. Use `npm run start` on this computer.');
    process.exit(1);
}

const projectDir = path.resolve(__dirname, '..');
const envPath = path.join(projectDir, '.env');
if (!fs.existsSync(envPath)) {
    console.error('Missing .env. Create it from .env.example and set Google OAuth vars plus APP_SESSION_SECRET before installing launchd.');
    process.exit(1);
}

const launchAgentPath = getLaunchAgentPath(os.homedir());
const launchAgentDir = path.dirname(launchAgentPath);
const nodePath = findNodePath();
const plist = createLaunchAgentPlist({
    projectDir,
    nodePath,
    envPath: buildLaunchPath({ nodePath })
});

fs.mkdirSync(launchAgentDir, { recursive: true });

spawnSync('launchctl', ['unload', launchAgentPath], { stdio: 'ignore' });
fs.writeFileSync(launchAgentPath, plist, 'utf8');

const lint = spawnSync('plutil', ['-lint', launchAgentPath], { encoding: 'utf8' });
if (lint.status !== 0) {
    console.error(lint.stdout || lint.stderr || 'LaunchAgent plist validation failed.');
    process.exit(lint.status || 1);
}

const load = spawnSync('launchctl', ['load', launchAgentPath], { encoding: 'utf8' });
if (load.status !== 0) {
    console.error(load.stdout || load.stderr || 'LaunchAgent load failed.');
    process.exit(load.status || 1);
}

console.log(`${LABEL} installed at ${launchAgentPath}`);
console.log('Service URL: http://localhost:3000');
