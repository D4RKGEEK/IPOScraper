import { test, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { writeAtomicSync } = require('../utils/atomicWrite.js');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('writes file atomically and content is correct', () => {
  const testPath = path.join(__dirname, 'test_atomic_file.json');
  const testData = { success: true, value: 42 };

  writeAtomicSync(testPath, testData);

  expect(fs.existsSync(testPath)).toBe(true);
  const readData = JSON.parse(fs.readFileSync(testPath, 'utf8'));
  expect(readData).toEqual(testData);

  fs.unlinkSync(testPath);
});

test('overwrites an existing file atomically', () => {
  const testPath = path.join(__dirname, 'test_atomic_overwrite.json');
  writeAtomicSync(testPath, { version: 1 });
  writeAtomicSync(testPath, { version: 2 });

  const readData = JSON.parse(fs.readFileSync(testPath, 'utf8'));
  expect(readData.version).toBe(2);

  fs.unlinkSync(testPath);
});

test('leaves no temp file after successful write', () => {
  const testPath = path.join(__dirname, 'test_atomic_notemp.json');
  writeAtomicSync(testPath, { clean: true });

  const dir = path.dirname(testPath);
  const temps = fs.readdirSync(dir).filter(f => f.startsWith('.tmp_'));
  expect(temps.length).toBe(0);

  fs.unlinkSync(testPath);
});

test('writes valid JSON with 2-space indentation', () => {
  const testPath = path.join(__dirname, 'test_atomic_indent.json');
  writeAtomicSync(testPath, { a: 1 });

  const raw = fs.readFileSync(testPath, 'utf8');
  expect(raw).toBe(JSON.stringify({ a: 1 }, null, 2));

  fs.unlinkSync(testPath);
});
