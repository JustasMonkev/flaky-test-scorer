#!/usr/bin/env node
// CLI entry point. The command implementations live in ./cli/*; this file is the
// bin shim and the public `run(argv)` surface.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { run } from "./cli/program.js";

export { run } from "./cli/program.js";

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (entry === import.meta.url) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
