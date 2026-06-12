const fs = require('fs');
const path = require('path');

/**
 * POSIX-compliant atomic file writer using the write-temp-then-rename pattern.
 * Flushes to physical disk using fsync to prevent database corruption.
 * @param {string} filePath Target destination path
 * @param {any} data JSON serializable data to write
 */
function writeAtomicSync(filePath, data) {
  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const randomStr = Math.random().toString(36).substring(2, 9);
  const tempPath = path.join(directory, `.tmp_${baseName}_${randomStr}`);
  
  try {
    // Write JSON formatted with 2-space indentation
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    
    // Flush changes to physical storage
    const fd = fs.openSync(tempPath, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    
    // Atomically rename to target location (POSIX guaranteed atomic replacement)
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    // Cleanup temp file if it was created
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (unlinkError) {
        // Ignore cleanup error to propagate original write error
      }
    }
    throw error;
  }
}

module.exports = { writeAtomicSync };
