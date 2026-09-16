#!/usr/bin/env node
/**
 * Run a command with the monorepo-root .env loaded, so `pnpm db:migrate`,
 * `pnpm db:seed` and friends work from any directory. Variables already set in
 * the environment win (Docker passes them explicitly and has no .env).
 *
 *   node scripts/with-env.mjs prisma migrate dev
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function loadRootEnv(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i += 1) {
    const isRoot = existsSync(path.join(dir, 'pnpm-workspace.yaml'));
    const candidate = path.join(dir, '.env');
    if (isRoot) {
      if (existsSync(candidate)) {
        for (const line of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
          const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
          if (!match || line.trim().startsWith('#')) continue;
          let value = match[2].trim();
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          )
            value = value.slice(1, -1);
          if (process.env[match[1]] === undefined) process.env[match[1]] = value;
        }
        process.env.REPEAT_ROOT_DIR ??= dir;
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

loadRootEnv(process.cwd());
const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: with-env.mjs <command> [args...]');
  process.exit(2);
}
const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
