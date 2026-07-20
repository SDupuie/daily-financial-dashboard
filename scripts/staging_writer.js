const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLISHED_ARTIFACTS = ['daily_financial_news.html', 'index.html'];

function assertStagingWritePath(file, projectRoot = ROOT) {
  // Fetchers may stage generated artifacts, but run_daily_update owns writes to
  // the canonical dashboard and published entry point.
  const resolved = path.resolve(file);
  const root = path.resolve(projectRoot);
  if (PUBLISHED_ARTIFACTS.some((name) => resolved === path.join(root, name))) {
    throw new Error(`staging_writer cannot write protected published artifact ${resolved}.`);
  }
}

function atomicWriteFile(file, contents, options = {}, dependencies = {}) {
  assertStagingWritePath(file, dependencies.projectRoot);
  const fileSystem = dependencies.fs || fs;
  const directory = path.dirname(file);
  fileSystem.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fileSystem.writeFileSync(temporary, contents, options);
    fileSystem.renameSync(temporary, file);
  } finally {
    if (fileSystem.existsSync(temporary)) fileSystem.unlinkSync(temporary);
  }
}

function atomicWriteJson(file, payload) {
  atomicWriteFile(file, `${JSON.stringify(payload, null, 2)}\n`);
}

module.exports = {
  atomicWriteFile,
  atomicWriteJson
};
