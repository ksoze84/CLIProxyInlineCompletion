const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  await runTests({
    version: process.env.VSCODE_TEST_VERSION || 'stable',
    extensionDevelopmentPath: path.resolve(__dirname, '..'),
    extensionTestsPath: path.resolve(__dirname, 'integration.test.cjs'),
    launchArgs: ['--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-extensions'],
    extensionTestsEnv: { CLIPROXY_TEST: '1' }
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});