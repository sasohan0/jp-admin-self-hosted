const { spawnSync } = require('node:child_process');

const result = spawnSync(process.execPath, [
  '--test',
  '--test-skip-pattern=legacy mode keeps the existing EJP-13 deployment',
], {
  cwd: process.cwd(),
  env: { ...process.env, JP_INSTALLER_MODE: 'true' },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
