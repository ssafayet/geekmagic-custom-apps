import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupFilePath } from '../src/device-manager.js';

/** Filenames come from the display's own listing, so they are untrusted input. */
describe('backupFilePath', () => {
  const directory = join('/data', 'device-backups', 'dev_1', 'bak_1');

  it('places a plain filename inside the backup directory', () => {
    expect(backupFilePath(directory, 'holiday.jpg')).toBe(resolve(directory, 'holiday.jpg'));
  });

  it.each([
    '../../master.key',
    '/etc/passwd',
    'sub/file.jpg',
    '..\\..\\x.jpg',
    '..',
    '.',
    '',
    'a\0b',
  ])('refuses %j', (filename) => {
    expect(() => backupFilePath(directory, filename)).toThrow(/unsafe backup filename/);
  });
});
