const fs = require('fs');
const path = require('path');

function atomicWriteFile(file, contents, options = {}, dependencies = {}) {
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
