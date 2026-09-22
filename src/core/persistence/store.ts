import {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Database } from "../types.js";
import { sanitize } from "../security.js";
import { parseDatabase } from "./schema.js";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export class StateStore {
  readonly dir: string;
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(root: string) {
    this.dir = join(root, ".jev");
    this.path = join(this.dir, "foreman-state.json");
  }
  async read(): Promise<Database> {
    try {
      return parseDatabase(JSON.parse(await readFile(this.path, "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { schema: 3, workflows: {} };
      throw e;
    }
  }
  async transaction<T>(fn: (db: Database) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await chmod(this.dir, 0o700);
      await writeFile(join(this.dir, ".gitignore"), "*\n", { mode: 0o600 });
      const lock = join(this.dir, "state.lock");
      const deadline = Date.now() + 35_000;
      while (true) {
        try {
          await writeFile(lock, String(process.pid), {
            flag: "wx",
            mode: 0o600,
          });
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          try {
            const pid = Number(await readFile(lock, "utf8"));
            if (pid > 0) {
              try {
                process.kill(pid, 0);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ESRCH")
                  await unlink(lock).catch(() => {});
              }
            }
          } catch {
            /* Another writer may have released the lock. */
          }
          if (Date.now() > deadline)
            throw new Error(
              "Jev state is busy; retry after the other host finishes",
              { cause: e },
            );
          await delay(25);
        }
      }
      let tmp: string | undefined;
      try {
        const db = await this.read();
        const result = await fn(db);
        const validated = parseDatabase(sanitize(db));
        const previous = await readFile(this.path, "utf8").catch((e) => {
          if (e.code === "ENOENT") return "";
          throw e;
        });
        if (previous && JSON.parse(previous).schema === 2) {
          await writeFile(join(this.dir, "foreman-state.v2.json"), previous, {
            mode: 0o600,
            flag: "wx",
          }).catch((e) => {
            if (e.code !== "EEXIST") throw e;
          });
        }
        tmp = join(this.dir, `.state-${randomUUID()}.tmp`);
        await writeFile(tmp, JSON.stringify(validated, null, 2) + "\n", {
          mode: 0o600,
        });
        await rename(tmp, this.path);
        return result;
      } finally {
        if (tmp) await unlink(tmp).catch(() => {});
        await unlink(lock).catch(() => {});
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
