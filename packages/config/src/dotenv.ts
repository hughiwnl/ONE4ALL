import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Load a `.env` file from the monorepo root into process.env (without
 * overriding variables that are already set), whatever the current working
 * directory is. Walks up from `startDir` until it finds `pnpm-workspace.yaml`.
 *
 * In Docker the environment is passed explicitly and no `.env` exists, so this
 * is a no-op there. Parsing is intentionally minimal (KEY=value, quotes, #
 * comments); anything fancier belongs in a real secrets manager.
 */
export function loadDotenv(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i += 1) {
    const candidate = path.join(dir, '.env');
    const isRoot = existsSync(path.join(dir, 'pnpm-workspace.yaml'));
    if (existsSync(candidate) && (isRoot || i === 0)) {
      applyDotenv(readFileSync(candidate, 'utf8'));
      // Relative paths in .env (MEDIA_STORAGE_PATH) resolve against this directory.
      process.env.REPEAT_ROOT_DIR ??= dir;
      return candidate;
    }
    if (isRoot) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(' #');
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    result[key] = value;
  }
  return result;
}

function applyDotenv(content: string): void {
  for (const [key, value] of Object.entries(parseDotenv(content))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
