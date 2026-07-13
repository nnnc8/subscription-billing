const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const distDir = path.resolve('dist');
const manifestCandidates = [
  path.join(distDir, '.vite', 'manifest.json'),
  path.join(distDir, 'manifest.json'),
];
const manifestPath = manifestCandidates.find((candidate) => fs.existsSync(candidate));

if (!manifestPath) {
  throw new Error('Vite manifest not found; run vite build before bundle:gate');
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const entries = Object.entries(manifest);
const mainEntry = entries.find(([key, value]) =>
  value.isEntry === true && (key === 'index.html' || value.name === 'index'),
) ?? entries.find(([, value]) => value.isEntry === true);

if (!mainEntry) {
  throw new Error('Main Vite manifest entry not found');
}

const [mainKey] = mainEntry;
const countedFiles = new Set();

function countStaticImports(key) {
  if (countedFiles.has(key)) return 0;
  const entry = manifest[key];
  if (!entry) throw new Error(`Manifest import missing: ${key}`);
  countedFiles.add(key);

  let bytes = 0;
  if (entry.file.endsWith('.js')) {
    const assetPath = path.join(distDir, entry.file);
    if (!fs.existsSync(assetPath)) throw new Error(`Manifest asset missing: ${entry.file}`);
    bytes += zlib.gzipSync(fs.readFileSync(assetPath)).length;
  }

  for (const importedKey of entry.imports ?? []) {
    bytes += countStaticImports(importedKey);
  }
  return bytes;
}

const measuredBytes = countStaticImports(mainKey);
const budgetBytes = Math.min(189030, Math.ceil(measuredBytes / 1024) * 1024);
if (measuredBytes > budgetBytes) {
  throw new Error(`Static JS gzip bundle exceeds budget: ${measuredBytes} > ${budgetBytes}`);
}

const findDynamicEntry = (name) => entries.find(([key, value]) =>
  value.isDynamicEntry === true && key.endsWith(`/components/${name}.tsx`),
);
const aiEntry = findDynamicEntry('AiAssistantTab');
const automationEntry = findDynamicEntry('AutomationTab');
if (!aiEntry || !automationEntry) {
  throw new Error('AI and Automation must remain dynamic Vite entries');
}

console.log(JSON.stringify({
  main: mainKey,
  staticJsGzipBytes: measuredBytes,
  budgetBytes,
  dynamicEntries: [aiEntry[0], automationEntry[0]],
}, null, 2));
