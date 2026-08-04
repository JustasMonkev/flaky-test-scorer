import { readFileSync } from "node:fs";
import { InputError } from "../ingest.js";
import { loadAi } from "./lazy-ai.js";

export async function runAuthStatus(): Promise<number> {
  // No try/catch: `authStatus` reads the config through a swallow-everything
  // reader, so it has no throwing path.
  // A guard that cannot fire only hides the next one that can.
  for (const s of (await loadAi()).authStatus()) {
    const state = s.available ? "available" : "unavailable";
    process.stdout.write(
      `${s.provider.padEnd(7)} ${state.padEnd(12)} ${s.source}${s.keyTail ? `  ${s.keyTail}` : ""}\n`,
    );
  }
  return 0;
}

/**
 * A read-only or missing config home is an expected environment problem (CI
 * containers, locked-down HOME), not a bug: report it as an input error with a
 * message instead of the raw stack the generic catch would print.
 */
export function writeConfig(mutate: () => void): void {
  try {
    mutate();
  } catch (err) {
    throw new InputError(`could not write the config file: ${(err as Error).message}`);
  }
}

export function readKeyFromStdin(): string {
  if (process.stdin.isTTY) {
    throw new InputError("no key given: pass --key <k> or pipe the key on stdin");
  }
  const key = readFileSync(0, "utf8").trim();
  if (!key) throw new InputError("empty key on stdin");
  return key;
}
