import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Use only an unlinked checkout. Never overwrite a real Vercel project binding.
const projectFile = '.vercel/project.json';
if (fs.existsSync(projectFile)) {
    const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    assert.equal(project.projectId, 'prj_offline_billing_smoke', 'Use an unlinked disposable checkout for offline builds');
} else {
    fs.mkdirSync('.vercel', { recursive: true });
    fs.writeFileSync(projectFile, JSON.stringify({
        projectId: 'prj_offline_billing_smoke', orgId: 'team_offline_billing_smoke',
        settings: {
            framework: 'vite', outputDirectory: 'dist',
            buildCommand: 'node node_modules/vite/bin/vite.js build', installCommand: 'true'
        }
    }, null, 2));
}
const result = spawnSync('vercel', ['build', '--yes'], {
    stdio: 'inherit', env: { ...process.env, VERCEL_TELEMETRY_DISABLED: '1', npm_config_verify_deps_before_run: 'false' }
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        assert(!['server', 'lib', 'node_modules', '.env'].includes(entry.name), `Private source in static output: ${filename}`);
        assert(!/\.(?:tsx?|db|sql|env)$/.test(entry.name), `Private file in static output: ${filename}`);
        if (entry.isDirectory()) inspect(filename);
    }
}
inspect('.vercel/output/static');
assert(fs.existsSync('.vercel/output/static/index.html'));
assert(fs.existsSync('.vercel/output/functions/api/index.func/api/index.js'));
console.log('Vercel build output checked: Vite assets only; function entry exists.');
