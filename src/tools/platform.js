/**
 * Platform detection — linux or macos.
 */

function getPlatform() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return 'unknown';
}

module.exports = { getPlatform };
