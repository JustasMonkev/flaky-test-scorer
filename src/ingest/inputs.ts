import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { InputError } from "./common.js";

const EXTENSIONS = [".xml", ".json", ".csv", ".jsonl"];

function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") i++;
        out += "(?:.*/)?";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

const SKIP_DIRS = new Set(["node_modules", ".git"]);

function walk(dir: string, recursive: boolean, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // Mode-000 subdirectories and dead mounts are ordinary CI-runner conditions,
    // not bugs: name the directory instead of printing a scandir stack.
    throw new InputError(`cannot read directory ${dir}: ${(err as Error).message}`);
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive && !SKIP_DIRS.has(entry.name)) walk(full, recursive, out);
    } else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Expand paths, directories and simple globs (`*`, `?`, `**`) into a sorted file list. */
export function expandInputs(patterns: string[], cwd = process.cwd()): string[] {
  const found = new Set<string>();
  for (const pattern of patterns) {
    if (!/[*?]/.test(pattern)) {
      if (!existsSync(pattern)) throw new InputError(`input not found: ${pattern}`);
      if (statSync(pattern).isDirectory()) {
        for (const file of walk(pattern, true)) {
          if (EXTENSIONS.some((e) => file.toLowerCase().endsWith(e))) found.add(resolve(file));
        }
      } else found.add(resolve(pattern));
      continue;
    }
    // Search from the longest literal directory prefix of the pattern.
    const parts = pattern.split("/");
    const wildcardAt = parts.findIndex((p) => /[*?]/.test(p));
    const literal = parts.slice(0, wildcardAt).join("/");
    const base = literal === "" ? cwd : resolve(cwd, literal);
    if (!existsSync(base) || !statSync(base).isDirectory()) continue;

    const re = globToRegExp(pattern);
    for (const file of walk(base, pattern.includes("**") || wildcardAt < parts.length - 1)) {
      const rel = relative(cwd, resolve(file)).split(sep).join("/");
      if (re.test(rel) || re.test(resolve(file).split(sep).join("/"))) found.add(resolve(file));
    }
  }
  if (found.size === 0) throw new InputError(`no input files matched: ${patterns.join(", ")}`);
  // Numeric-aware: file order is the chronological fallback for timestamp-less JUnit,
  // and plain sort() puts run-10 before run-2, which shuffles an order-sensitive flipRate.
  return [...found].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}
