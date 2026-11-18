import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Target } from './config.js';

/** File-name slug of a target name: lower case, ASCII letters, digits and dashes. */
export function slug(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || 'target';
}

export function snapshotFile(target: Target): string {
  return `${slug(target.name)}.${target.mode === 'fields' ? 'json' : 'md'}`;
}

/**
 * One readable file per target: `<slug>.md` (text mode) or `<slug>.json` (fields
 * mode, sorted keys). Files hold only the compared content, no timestamps, so a git
 * commit of the directory changes only when a page changed.
 */
export class SnapshotStore {
  constructor(readonly dir: string) {}

  path(target: Target): string {
    return join(this.dir, snapshotFile(target));
  }

  async read(target: Target): Promise<string | null> {
    try {
      return await readFile(this.path(target), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async write(target: Target, content: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = this.path(target);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, file);
  }
}
