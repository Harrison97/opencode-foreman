import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  cp,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");
test("managed installer installs, updates, and preserves existing data on failure", async () => {
  const temp = await mkdtemp(join(tmpdir(), "foreman installer "));
  try {
    const bin = join(temp, "bin");
    const fixture = join(temp, "source");
    const config = join(temp, "config");
    const destination = join(temp, "managed install");
    await mkdir(bin);
    await mkdir(join(fixture, "scripts"), { recursive: true });
    await cp(
      join(root, "scripts/install.mjs"),
      join(fixture, "scripts/install.mjs"),
    );
    await writeFile(join(fixture, "package.json"), '{"type":"module"}');
    await symlink(join(root, "node_modules"), join(fixture, "node_modules"));
    await mkdir(join(config, "opencode"), { recursive: true });
    const tui = join(config, "opencode/tui.jsonc");
    await writeFile(
      tui,
      '// keep this comment\n{"theme":"existing", "plugin":["other-plugin"]}\n',
    );
    for (const [name, body] of Object.entries({
      git: 'for last; do :; done\ncp -R "$FIXTURE" "$last"',
      npm: '[ "${FAIL_BUILD:-0}" != 1 ] || exit 42\nmkdir -p dist/opencode\ntouch dist/opencode/plugin.js dist/opencode/tui.jsx',
      opencode: "exit 0",
    }))
      await writeFile(
        join(bin, name),
        `#!/usr/bin/env bash\nset -e\n${body}\n`,
        { mode: 0o755 },
      );
    const run = (extra = {}) =>
      spawnSync("bash", [join(root, "site/install.sh")], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          FIXTURE: fixture,
          XDG_CONFIG_HOME: config,
          FOREMAN_INSTALL_DIR: destination,
          ...extra,
        },
        encoding: "utf8",
      });
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    const plugin = join(config, "opencode/plugins/foreman.js");
    const firstPlugin = await readFile(plugin, "utf8");
    const firstTui = await readFile(tui, "utf8");
    assert.match(firstTui, /keep this comment/);
    assert.match(firstTui, /other-plugin/);
    assert.match(firstTui, /existing/);
    assert.match(firstPlugin, /managed%20install/);
    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(tui, "utf8"),
      firstTui,
      "update must not duplicate the sidebar",
    );
    await writeFile(join(destination, "old-install-proof"), "keep");
    result = run({ FAIL_BUILD: "1" });
    assert.notEqual(result.status, 0);
    assert.equal(
      await readFile(join(destination, "old-install-proof"), "utf8"),
      "keep",
    );
    assert.equal(await readFile(plugin, "utf8"), firstPlugin);
    await writeFile(tui, "invalid config");
    result = run();
    assert.notEqual(result.status, 0);
    assert.equal(
      await readFile(join(destination, "old-install-proof"), "utf8"),
      "keep",
      "registration failure restores installation",
    );
    assert.equal(await readFile(tui, "utf8"), "invalid config");
    assert.equal(await readFile(plugin, "utf8"), firstPlugin);
    const unmanaged = join(temp, "unmanaged");
    await mkdir(unmanaged);
    await writeFile(join(unmanaged, "user-file"), "keep");
    result = run({ FOREMAN_INSTALL_DIR: unmanaged });
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(join(unmanaged, "user-file"), "utf8"), "keep");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
