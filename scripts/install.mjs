import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, modify, applyEdits } from "jsonc-parser";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "opencode",
  "plugins",
);
await mkdir(dir, { recursive: true });
const path = join(dir, "foreman.js");
const content = `// Installed by opencode-foreman. Remove this file to uninstall.\nexport { ForemanPlugin } from ${JSON.stringify(pathToFileURL(join(root, "dist/opencode/plugin.js")).href)};\n`;
try {
  const old = await readFile(path, "utf8");
  if (!old.startsWith("// Installed by opencode-foreman."))
    throw new Error("Refusing to overwrite an unrelated existing plugin");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
await writeFile(path, content, { mode: 0o600 });
console.log(`Installed ${path}\nRestart OpenCode to load the plugin.`);

// UI plugins are registered separately; putting this module in plugins/ would
// incorrectly ask the server to load a TUI-only module.
const configDir = dirname(dir);
let tuiPath = join(configDir, "tui.json");
try {
  await readFile(join(configDir, "tui.jsonc"));
  tuiPath = join(configDir, "tui.jsonc");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
let original = "{}\n";
try {
  original = await readFile(tuiPath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const errors = [];
const config = parse(original, errors, { allowTrailingComma: true });
if (
  errors.length ||
  !config ||
  Array.isArray(config) ||
  typeof config !== "object" ||
  (config.plugin !== undefined && !Array.isArray(config.plugin))
) {
  throw new Error(
    "Invalid TUI configuration; preserved without changes: " + tuiPath,
  );
}
const target = pathToFileURL(join(root, "dist/opencode/tui.jsx")).href;
const plugins = config.plugin ?? [];
if (
  !plugins.some((entry) => (Array.isArray(entry) ? entry[0] : entry) === target)
) {
  const updated = applyEdits(
    original,
    modify(original, ["plugin"], [...plugins, target], {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  );
  const temporary = tuiPath + ".foreman-" + process.pid + ".tmp";
  await writeFile(temporary, updated, { mode: 0o600 });
  await rename(temporary, tuiPath);
}
console.log(
  `Registered Foreman sidebar in ${tuiPath}. Restart the OpenCode terminal UI.`,
);
