const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');
const {
    LABEL,
    getLaunchAgentPath
} = require('./portable-utils.cjs');

if (process.platform !== 'darwin') {
    console.error('launchd uninstall is only available on macOS.');
    process.exit(1);
}

const launchAgentPath = getLaunchAgentPath(os.homedir());
spawnSync('launchctl', ['unload', launchAgentPath], { stdio: 'ignore' });

if (fs.existsSync(launchAgentPath)) {
    fs.unlinkSync(launchAgentPath);
}

console.log(`${LABEL} removed from ${launchAgentPath}`);
