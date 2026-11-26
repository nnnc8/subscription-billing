// The before record was taken on 2026-11-25, while the app still had its AI system. The owner
// retired that system during the redesign. Named things that went with it are acknowledged in the
// stylesheet stamp (the `dropped` lines at the top of src/index.css). Two kinds of entry cannot be
// named there, so this script takes them out of the record instead:
//
//   1. The AI chat form. Forms without an id are keyed by position ("form 1" ... "form 6"), and
//      the chat form was the first one, so every later form would be compared with the wrong form.
//   2. Two fields with no name or id: the chat form's text input, and the AI reminder's style
//      picker in an expanded member row.
//
// Nothing else is touched. The untouched record stays beside this file as before.with-ai.json.
//
// Usage, from the project root:  node .hallmark/rebase-without-ai.mjs
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
if (!existsSync(here('before.with-ai.json'))) copyFileSync(here('before.json'), here('before.with-ai.json'));

const record = JSON.parse(readFileSync(here('before.with-ai.json'), 'utf8'));
const isAiChatForm = (form) => form.fields.length === 1 && form.fields[0] === 'unnamed text 1'
  && form.controls.join() === 'input[type=text],button[type=submit]';
const removed = [];

for (const [url, page] of Object.entries(record.pages)) {
  const kept = page.forms.filter((form) => !isAiChatForm(form));
  if (kept.length !== page.forms.length) {
    removed.push(`${url}: the AI chat form and its text input`);
    page.forms = kept.map((form, index) => (/^form \d+$/.test(form.key) ? { ...form, key: `form ${index + 1}` } : form));
    page.fields = page.fields.filter((field) => field !== 'unnamed text 1');
  }
  // Only the expanded member row had a second select without a name: the AI reminder style picker.
  if (page.fields.includes('unnamed select 2')) {
    removed.push(`${url}: the AI reminder style picker`);
    page.fields = page.fields.filter((field) => field !== 'unnamed select 2');
  }
}

record.rebased = {
  from: 'before.with-ai.json',
  reason: 'The owner retired the AI system during the redesign; these entries have no name the dropped stamp could carry.',
  removed,
};
writeFileSync(here('before.json'), `${JSON.stringify(record, null, 2)}\n`);
console.log(`rebased: ${removed.length} entries removed`);
for (const line of removed) console.log(`  ${line}`);
