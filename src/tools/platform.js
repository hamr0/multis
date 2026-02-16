/**
 * Platform detection — linux, macos, or android (Termux).
 */

function getPlatform() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') {
    if (process.env.PREFIX?.includes('com.termux')) return 'android';
    return 'linux';
  }
  return 'unknown';
}

module.exports = { getPlatform };
