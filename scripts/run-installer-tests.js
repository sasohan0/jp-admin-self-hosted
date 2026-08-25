const { spawnSync } = require('node:child_process');

const result = spawnSync(process.execPath, ['--test'], {
  cwd: process.cwd(),
  env: { ...process.env, JP_INSTALLER_MODE: 'true' },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
