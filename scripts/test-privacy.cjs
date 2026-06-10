const assert = require('assert');
const fs = require('fs');
const { execFileSync } = require('child_process');

const trackedFiles = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

const forbiddenTrackedPatterns = [
    /^database\.json$/,
    /^session_handoff\.md$/,
    /^backups\/.*\.json$/,
    /^database_test_backup\.json$/,
    /^migrate\.py$/
];

const forbiddenTracked = trackedFiles.filter(file => (
    forbiddenTrackedPatterns.some(pattern => pattern.test(file))
));
assert.deepStrictEqual(forbiddenTracked, [], `Sensitive files still tracked: ${forbiddenTracked.join(', ')}`);

function loadSensitiveTerms() {
    const fromEnv = String(process.env.PRIVACY_GREP_TERMS || '')
        .split(',')
        .map(term => term.trim())
        .filter(Boolean);
    if (fromEnv.length > 0) return fromEnv;

    const termsFile = process.env.PRIVACY_GREP_TERMS_FILE;
    if (termsFile && fs.existsSync(termsFile)) {
        return fs.readFileSync(termsFile, 'utf8')
            .split(/\r?\n/)
            .map(term => term.trim())
            .filter(term => term && !term.startsWith('#'));
    }
    return [];
}

const grepTerms = loadSensitiveTerms();

for (const term of grepTerms) {
    try {
        const output = execFileSync('git', ['grep', '-n', term, '--', ':!pnpm-lock.yaml'], { encoding: 'utf8' });
        assert.fail(`Sensitive term "${term}" found in tracked files:\n${output}`);
    } catch (err) {
        if (err.status === 1) continue;
        throw err;
    }
}

console.log('Privacy tracking tests passed.');
