import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Scan a directory tree and return groups of identical regular files.
 *
 * Files are considered identical if they have the same size and the same
 * SHA-256 hash of their contents. Directories and symlinks are ignored.
 *
 * @param {string} root - Absolute or relative path to the directory to scan.
 * @param {object} [options]
 * @param {number} [options.minSize=1] - Minimum file size in bytes to consider.
 * @returns {Promise<Array<{hash: string, size: number, files: string[]}>>}
 */
export async function scan(root, options = {}) {
  const minSize = options.minSize ?? 1;
  const filesBySize = new Map();

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EACCES') {
        return;
      }
      throw err;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        let stat;
        try {
          stat = await fs.stat(full);
        } catch (err) {
          if (err.code === 'ENOENT') continue;
          throw err;
        }
        if (stat.size < minSize) continue;
        const size = stat.size;
        if (!filesBySize.has(size)) filesBySize.set(size, []);
        filesBySize.get(size).push(full);
      }
    }
  }

  await walk(root);

  const groups = [];
  for (const [size, files] of filesBySize) {
    if (files.length < 2) continue;
    const byHash = new Map();
    for (const file of files) {
      const hash = await hashFile(file);
      if (!byHash.has(hash)) byHash.set(hash, []);
      byHash.get(hash).push(file);
    }
    for (const [hash, group] of byHash) {
      if (group.length >= 2) {
        groups.push({ hash, size, files: group });
      }
    }
  }

  return groups;
}

/**
 * Replace duplicate files with hardlinks.
 *
 * For each group of identical files, the first file in the group is kept
 * as the canonical copy; the remaining files are unlinked and re-created
 * as hardlinks to the canonical file. The original file contents are
 * preserved because hardlinks share the same inode.
 *
 * @param {Array<{hash: string, size: number, files: string[]}>} groups
 * @returns {Promise<{linked: number, savedBytes: number, errors: Array<{file: string, error: string}>}>}
 */
export async function deduplicate(groups) {
  let linked = 0;
  let savedBytes = 0;
  const errors = [];

  for (const group of groups) {
    const [canonical, ...duplicates] = group.files;
    for (const dup of duplicates) {
      try {
        await fs.unlink(dup);
        await fs.link(canonical, dup);
        linked++;
        savedBytes += group.size;
      } catch (err) {
        errors.push({ file: dup, error: err.message });
      }
    }
  }

  return { linked, savedBytes, errors };
}

/**
 * Format a scan result as a human-readable report.
 *
 * @param {Array<{hash: string, size: number, files: string[]}>} groups
 * @returns {string}
 */
export function formatReport(groups) {
  if (groups.length === 0) return 'No duplicate files found.\n';
  const lines = [];
  let totalWasted = 0;
  for (const group of groups) {
    const waste = group.size * (group.files.length - 1);
    totalWasted += waste;
    lines.push(`Hash: ${group.hash}`);
    lines.push(`Size: ${group.size} bytes`);
    lines.push(`Wasted: ${waste} bytes`);
    for (const file of group.files) {
      lines.push(`  ${file}`);
    }
    lines.push('');
  }
  lines.push(`Total wasted: ${totalWasted} bytes`);
  return lines.join('\n') + '\n';
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const stream = (await import('node:fs')).createReadStream(file);
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
