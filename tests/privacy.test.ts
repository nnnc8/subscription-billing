import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

describe('Privacy and sensitive file leak checks', () => {
  it('should not track forbidden or sensitive files in Git', () => {
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

    expect(forbiddenTracked).toEqual([]);
  });

  it('should not contain sensitive private terms in git tracked files', () => {
    const loadSensitiveTerms = (): string[] => {
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
    };

    const grepTerms = loadSensitiveTerms();

    for (const term of grepTerms) {
      try {
        const output = execFileSync('git', ['grep', '-n', term, '--', ':!pnpm-lock.yaml'], { encoding: 'utf8' });
        throw new Error(`Sensitive term "${term}" found in tracked files:\n${output}`);
      } catch (err) {
        const status = typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number'
          ? err.status
          : undefined;
        if (status === 1) continue;
        throw err;
      }
    }
  });
});
