import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "opencode",
  "plugins",
);
await mkdir(dir, { recursive: true });
const path = join(dir, "jev-supervisor.js");
const content = `// Installed by opencode-jev-supervisor. Remove this file to uninstall.\nexport { JevSupervisor } from ${JSON.stringify(pathToFileURL(join(root, "dist/opencode/plugin.js")).href)};\n`;
try {
  const old = await readFile(path, "utf8");
  if (!old.startsWith("// Installed by opencode-jev-supervisor."))
    throw new Error("Refusing to overwrite an unrelated existing plugin");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
await writeFile(path, content, { mode: 0o600 });
console.log(`Installed ${path}\nRestart OpenCode to load the plugin.`);
