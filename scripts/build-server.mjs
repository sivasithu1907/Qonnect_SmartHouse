// Bundles the API and CLI entry points for production (node_modules stay external).
import { build } from 'esbuild';

await build({
  entryPoints: {
    index: 'server/index.ts',
    migrate: 'server/cli/migrate.ts',
    seed: 'server/cli/seed.ts',
    'create-admin': 'server/cli/create-admin.ts',
    'generate-vapid-keys': 'server/cli/generate-vapid-keys.ts',
    backup: 'server/cli/backup.ts',
  },
  outdir: 'dist-server',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
