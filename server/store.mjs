// Durable store for projects, sources, evidence, frameworks, assessments,
// baselines and comparisons. One SQLite file shared by every Claude session.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { setting, defaultDataDir, databaseFile } from "./config.mjs";

export const dataDir = () => setting("DATA") || defaultDataDir();

// Settings may also live in <data dir>/.env (KEY=value lines), so the
// Jev key works however Claude Code was started. The environment wins. It is
// re-read on demand, so a key added later needs no server restart.
export function loadEnvFile(env = process.env) {
  const file = join(dataDir(), ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
}

let db;
export function open(file = databaseFile(dataDir())) {
  if (db) return db;
  if (file !== ":memory:") mkdirSync(join(file, ".."), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, buyer TEXT NOT NULL,
  scope TEXT NOT NULL, region TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS companies(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, url TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('reference','competitor')),
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  url TEXT NOT NULL, domain TEXT NOT NULL, title TEXT NOT NULL, publisher TEXT NOT NULL,
  type TEXT NOT NULL, text TEXT NOT NULL, published_at TEXT, retrieved_at TEXT NOT NULL,
  capture TEXT NOT NULL DEFAULT 'supplied');
CREATE TABLE IF NOT EXISTS evidence(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  claim TEXT NOT NULL, excerpt TEXT NOT NULL, attribution TEXT NOT NULL,
  criterion_ids TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS frameworks(
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, criteria TEXT NOT NULL, status TEXT NOT NULL,
  approved_by TEXT, approved_at TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, version));
CREATE TABLE IF NOT EXISTS assessments(
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL, body TEXT NOT NULL, gate TEXT NOT NULL DEFAULT 'pending',
  gate_notes TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL,
  PRIMARY KEY(company_id, criterion_id));
CREATE TABLE IF NOT EXISTS claim_reviews(
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  target TEXT NOT NULL, text TEXT NOT NULL, evidence_ids TEXT NOT NULL,
  verdict TEXT NOT NULL, confidence REAL, checker TEXT NOT NULL, created_at TEXT NOT NULL,
  basis TEXT NOT NULL DEFAULT 'fact');
CREATE TABLE IF NOT EXISTS baselines(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  framework_version INTEGER NOT NULL, company_id TEXT NOT NULL, snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS narratives(
  company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  body TEXT NOT NULL, gate TEXT NOT NULL DEFAULT 'pending', gate_notes TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reports(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL, baseline_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blocked_domains(
  domain TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, message TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counters(project_id TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY(project_id, kind));
`);
  // Databases created before claim bases existed.
  try {
    db.exec("ALTER TABLE claim_reviews ADD COLUMN basis TEXT NOT NULL DEFAULT 'fact'");
  } catch {}
  return db;
}
export function close() {
  db?.close();
  db = undefined;
}

export const now = () => new Date().toISOString();
export const uid = (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`;

export function tx(fn) {
  const d = open();
  if (d.isTransaction) return fn();
  d.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    d.exec("COMMIT");
    return value;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}
export const all = (sql, ...args) => open().prepare(sql).all(...args);
export const one = (sql, ...args) => open().prepare(sql).get(...args);
export const run = (sql, ...args) => open().prepare(sql).run(...args);

// Short ids (S1, E12) keep citations cheap for models to copy. They are
// unique across the store, so a citation can never resolve in another project.
export function nextId(kind) {
  run(
    "INSERT INTO counters VALUES('*',?,1) ON CONFLICT(project_id,kind) DO UPDATE SET n=n+1",
    kind,
  );
  return `${kind}${one("SELECT n FROM counters WHERE project_id='*' AND kind=?", kind).n}`;
}
export function log(projectId, message) {
  run(
    "INSERT INTO events(project_id,message,created_at) VALUES(?,?,?)",
    projectId,
    message,
    now(),
  );
}
export const parse = (row, ...fields) => {
  if (!row) return row;
  const out = { ...row };
  for (const f of fields) out[f] = JSON.parse(out[f]);
  return out;
};
