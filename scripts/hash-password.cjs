const {
    createPasswordHash
} = require('../lib/auth.cjs');

function readCliPassword() {
    const index = process.argv.indexOf('--password');
    if (index !== -1 && process.argv[index + 1]) {
        return process.argv[index + 1];
    }
    if (process.env.APP_PASSWORD) {
        return process.env.APP_PASSWORD;
    }
    return null;
}

function promptHidden(prompt) {
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        if (!stdin.isTTY || !stdout.isTTY) {
            let input = '';
            stdin.setEncoding('utf8');
            stdin.on('data', chunk => {
                input += chunk;
            });
            stdin.on('end', () => resolve(input.trim()));
            stdin.on('error', reject);
            return;
        }

        stdout.write(prompt);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        let password = '';

        function cleanup() {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener('data', onData);
        }

        function onData(char) {
            if (char === '\u0003') {
                cleanup();
                reject(new Error('Cancelled'));
                return;
            }
            if (char === '\r' || char === '\n') {
                cleanup();
                stdout.write('\n');
                resolve(password);
                return;
            }
            if (char === '\u007f') {
                password = password.slice(0, -1);
                return;
            }
            password += char;
        }

        stdin.on('data', onData);
    });
}

async function main() {
    let password = readCliPassword();
    if (!password) {
        password = await promptHidden('New app password: ');
        const confirm = await promptHidden('Confirm app password: ');
        if (password !== confirm) {
            throw new Error('Passwords do not match');
        }
    }
    if (password.length < 12) {
        throw new Error('Password must be at least 12 characters');
    }
    console.log(createPasswordHash(password));
}

main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
});
