#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { run } from "./cli/program.js";

export { run };

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (entry === import.meta.url) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
