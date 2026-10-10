const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'review-comments-host-'));
  const workspace = path.join(temporary, 'workspace');
  const copyRoot = path.join(temporary, 'workspace-copy');
  await fs.mkdir(workspace);
  await fs.mkdir(copyRoot);
  const workspaceFile = path.join(temporary, 'reviews.code-workspace');
  await fs.writeFile(workspaceFile, JSON.stringify({ folders: [{ path: workspace }, { path: copyRoot }] }));
  try {
    await runTests({
      version: process.env.VSCODE_TEST_VERSION || '1.96.4',
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || undefined,
      extensionDevelopmentPath: process.env.REVIEW_COMMENTS_EXTENSION_PATH || path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, '../build/test/integration.js'),
      launchArgs: [workspaceFile, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
        '--user-data-dir', path.join(temporary, 'profile'), '--extensions-dir', path.join(temporary, 'extensions')],
      extensionTestsEnv: { REVIEW_COMMENTS_TEST_ROOT: workspace, REVIEW_COMMENTS_COPY_ROOT: copyRoot }
    });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
