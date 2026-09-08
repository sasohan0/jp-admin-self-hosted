const { readdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

const testFiles = readdirSync(process.cwd(), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
  .map((entry) => `./${entry.name}`)
  .sort();

if (testFiles.length === 0) {
  console.error('No root-level *.test.js files were found.');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  process.exitCode = result.status === null ? 1 : result.status;
}
