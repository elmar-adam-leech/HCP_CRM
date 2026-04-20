const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const raw = JSON.parse(
  execSync(
    'npx license-checker --json --production --customPath \'{"licenses":"","repository":"","publisher":"","licenseText":""}\'',
    { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
  )
);

const groups = {};

for (const [key, val] of Object.entries(raw)) {
  const atIdx = key.lastIndexOf('@');
  const name = key.slice(0, atIdx);
  const version = key.slice(atIdx + 1);
  const licenseType = val.licenses || 'Unknown';

  if (!groups[licenseType]) {
    groups[licenseType] = { licenseText: val.licenseText || '', packages: [] };
  }
  groups[licenseType].packages.push({
    name,
    version,
    repository: val.repository || '',
    publisher: val.publisher || '',
  });
}

for (const g of Object.values(groups)) {
  g.packages.sort((a, b) => a.name.localeCompare(b.name));
}

const sorted = Object.entries(groups)
  .sort((a, b) => b[1].packages.length - a[1].packages.length)
  .map(([type, data]) => ({ license: type, ...data }));

const totalPkgs = sorted.reduce((s, g) => s + g.packages.length, 0);

const outPath = path.join(__dirname, '..', 'client', 'public', 'third-party-licenses.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(sorted, null, 2));
console.log(`Generated ${sorted.length} license groups (${totalPkgs} packages) → ${outPath}`);
