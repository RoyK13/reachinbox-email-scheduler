import { execSync } from 'node:child_process';
import path from 'node:path';
import { config } from 'dotenv';

/** Applies migrations to the dedicated test database once per integration run. */
export default function setup(): void {
  const root = path.resolve(__dirname, '..');
  const parsed = config({ path: path.join(root, '.env.test'), processEnv: {}, quiet: true }).parsed ?? {};
  execSync('npx prisma migrate deploy', {
    cwd: root,
    stdio: 'pipe',
    env: { ...process.env, ...parsed },
  });
}
