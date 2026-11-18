import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scan, deduplicate, formatReport } from '../src/index.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ts-hardlink-dedup-'));
}

async function writeFile(dir, name, content) {
  const full = path.join(dir, name);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  return full;
}

test('scan finds no duplicates in an empty directory', async () => {
  const dir = await makeTempDir();
  try {
    const groups = await scan(dir);
    assert.deepEqual(groups, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('scan finds no duplicates when all files differ', async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(dir, 'a.txt', 'alpha');
    await writeFile(dir, 'b.txt', 'bravo');
    await writeFile(dir, 'c.txt', 'charlie');
    const groups = await scan(dir);
    assert.deepEqual(groups, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('scan groups identical files by content', async () => {
  const dir = await makeTempDir();
  try {
    const content = 'duplicate content';
    await writeFile(dir, 'one.txt', content);
    await writeFile(dir, 'two.txt', content);
    await writeFile(dir, 'sub/three.txt', content);
    await writeFile(dir, 'unique.txt', 'unique');
    const groups = await scan(dir);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].size, content.length);
    assert.equal(groups[0].files.length, 3);
    assert.ok(groups[0].files.every((f) => f.endsWith('.txt')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('scan ignores files smaller than minSize', async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(dir, 'a.txt', 'x');
    await writeFile(dir, 'b.txt', 'x');
    const groups = await scan(dir, { minSize: 2 });
    assert.deepEqual(groups, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('scan ignores symlinks and directories', async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(dir, 'real.txt', 'same');
    await fs.mkdir(path.join(dir, 'subdir'));
    await fs.symlink(path.join(dir, 'real.txt'), path.join(dir, 'link.txt'));
    const groups = await scan(dir);
    assert.deepEqual(groups, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deduplicate replaces duplicates with hardlinks', async () => {
  const dir = await makeTempDir();
  try {
    const content = 'shared content';
    const a = await writeFile(dir, 'a.txt', content);
    const b = await writeFile(dir, 'b.txt', content);
    const groups = await scan(dir);
    assert.equal(groups.length, 1);
    const result = await deduplicate(groups);
    assert.equal(result.linked, 1);
    assert.equal(result.savedBytes, content.length);
    assert.deepEqual(result.errors, []);
    const statA = await fs.stat(a);
    const statB = await fs.stat(b);
    assert.equal(statA.ino, statB.ino);
    assert.equal(await fs.readFile(a, 'utf8'), content);
    assert.equal(await fs.readFile(b, 'utf8'), content);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deduplicate reports errors for missing files', async () => {
  const dir = await makeTempDir();
  try {
    const content = 'shared content';
    const a = await writeFile(dir, 'a.txt', content);
    const b = await writeFile(dir, 'b.txt', content);
    const groups = await scan(dir);
    await fs.unlink(b);
    const result = await deduplicate(groups);
    assert.equal(result.linked, 0);
    assert.equal(result.savedBytes, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].file, b);
    assert.ok(result.errors[0].error.length > 0);
    assert.equal(await fs.readFile(a, 'utf8'), content);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('formatReport prints a readable summary', async () => {
  const groups = [
    { hash: 'abc', size: 10, files: ['/a', '/b', '/c'] },
  ];
  const report = formatReport(groups);
  assert.ok(report.includes('Hash: abc'));
  assert.ok(report.includes('Size: 10 bytes'));
  assert.ok(report.includes('Wasted: 20 bytes'));
  assert.ok(report.includes('  /a'));
  assert.ok(report.includes('Total wasted: 20 bytes'));
});

test('formatReport handles no duplicates', () => {
  assert.equal(formatReport([]), 'No duplicate files found.\n');
});
