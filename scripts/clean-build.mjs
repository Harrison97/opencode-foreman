import { rm } from 'node:fs/promises';
// Only this package's generated output; no source files.
await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });
