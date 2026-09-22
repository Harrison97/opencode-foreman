import { cp, mkdir } from 'node:fs/promises';
await mkdir(new URL('../../dist/workflows', import.meta.url), { recursive: true });
await cp(new URL('../../src/workflows', import.meta.url), new URL('../../dist/workflows', import.meta.url), {
  recursive: true, filter: source => !source.endsWith('.ts'),
});
