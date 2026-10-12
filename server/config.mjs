// Product identity and settings. Settings read COMPARE_ANYTHING_* first and
// fall back to the pre-release COMP_ENGINE_* names.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP = {
  id: "compare-anything",
  name: "Compare Anything",
  by: "GrowthCast",
  version: "1.0.0",
};

export const setting = (name, env = process.env) =>
  env[`COMPARE_ANYTHING_${name}`] || env[`COMP_ENGINE_${name}`] || undefined;

// Projects made before the rename live in ~/.comp-engine; keep using them.
export function defaultDataDir(home = homedir()) {
  const current = join(home, ".compare-anything");
  const legacy = join(home, ".comp-engine");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}
export function databaseFile(dir) {
  const legacy = join(dir, "comp-engine.sqlite");
  return existsSync(legacy) ? legacy : join(dir, "compare-anything.sqlite");
}
