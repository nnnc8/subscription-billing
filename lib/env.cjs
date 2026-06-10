const fs = require('fs');
const path = require('path');

function unquote(value) {
    const trimmed = value.trim();
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function loadLocalEnv({ cwd = process.cwd(), filename = '.env' } = {}) {
    const envPath = path.join(cwd, filename);
    if (!fs.existsSync(envPath)) return false;

    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const separator = trimmed.indexOf('=');
        if (separator === -1) return;
        const key = trimmed.slice(0, separator).trim();
        const value = unquote(trimmed.slice(separator + 1));
        if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) return;
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    });
    return true;
}

module.exports = {
    loadLocalEnv
};
