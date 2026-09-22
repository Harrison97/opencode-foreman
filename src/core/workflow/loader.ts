import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import YAML from "yaml";
import { parseWorkflow } from "./schema.js";
import type { Workflow } from "../types.js";

async function document(path: string): Promise<Record<string, any>> {
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > 256000)
    throw new Error("Workflow file exceeds 256 KB");
  const doc = YAML.parseDocument(text, {
    uniqueKeys: true,
    prettyErrors: false,
  });
  if (doc.errors.length || doc.warnings.length)
    throw new Error(
      "Invalid workflow YAML (duplicate keys or unsupported syntax)",
    );
  const value = doc.toJS({ maxAliasCount: 30 });
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Workflow YAML must be a mapping");
  return value;
}
async function asset(root: string, name: string): Promise<string> {
  if (typeof name !== "string" || isAbsolute(name))
    throw new Error("Asset reference must be relative");
  const path = await realpath(resolve(root, name));
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
    throw new Error("Workflow asset escapes package");
  return path;
}
export async function loadWorkflowFile(file: string): Promise<Workflow> {
  let path = await realpath(file);
  let raw = await document(path);
  if ("source" in raw) {
    if (Object.keys(raw).length !== 1 || typeof raw.source !== "string")
      throw new Error("source must be the only config field");
    path = await realpath(resolve(dirname(path), raw.source));
    raw = await document(path);
  }
  const root = dirname(path);
  const stack = new Set<string>();
  const collected: Record<string, any> = Object.create(null);
  async function collect(input: Record<string, any>, from: string) {
    if (stack.has(from)) throw new Error("Cyclic workflow imports");
    stack.add(from);
    if (
      input.imports !== undefined &&
      (!Array.isArray(input.imports) ||
        input.imports.some((x: unknown) => typeof x !== "string"))
    )
      throw new Error("imports must be relative YAML paths");
    for (const name of input.imports ?? []) {
      const imported = await asset(root, name);
      const library = await document(imported);
      if (
        Object.keys(library).some(
          (key) => !["imports", "capabilities"].includes(key),
        )
      )
        throw new Error(
          "Capability library accepts only imports and capabilities",
        );
      await collect(library, imported);
    }
    if (
      !input.capabilities ||
      typeof input.capabilities !== "object" ||
      Array.isArray(input.capabilities)
    )
      throw new Error("capabilities must be a mapping");
    for (const [id, definition] of Object.entries(input.capabilities)) {
      if (Object.hasOwn(collected, id))
        throw new Error("Duplicate capability: " + id);
      if (
        !definition ||
        typeof definition !== "object" ||
        Array.isArray(definition)
      )
        throw new Error("Capability must be a mapping");
      const c = { ...definition } as Record<string, any>;
      for (const key of ["instructions", "outputs"]) {
        if (
          c[key] &&
          typeof c[key] === "object" &&
          Object.keys(c[key]).length === 1 &&
          "file" in c[key]
        ) {
          const resolved = await asset(root, c[key].file);
          const text = await readFile(resolved, "utf8");
          if (Buffer.byteLength(text) > 128000)
            throw new Error("Workflow asset exceeds 128 KB");
          c[key] = key === "instructions" ? text : JSON.parse(text);
        }
      }
      collected[id] = c;
    }
    stack.delete(from);
  }
  await collect(raw, path);
  delete raw.imports;
  return parseWorkflow({ ...raw, capabilities: collected });
}
