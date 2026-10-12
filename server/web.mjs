// Local web interface: review every step, inspect evidence, approve the
// framework (the human gate) and download reports. Bound to 127.0.0.1 and
// protected by a token kept in the data directory.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./store.mjs";
import { APP, setting } from "./config.mjs";
import * as engine from "./engine.mjs";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
// A fixed list of files, so no request path can reach outside web/.
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/tokens.css": ["tokens.css", "text/css; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/favicon.jpg": ["favicon.jpg", "image/jpeg"],
  ...Object.fromEntries(
    readdirSync(join(WEB, "fonts"))
      .filter((f) => f.endsWith(".ttf"))
      .map((f) => [`/fonts/${f}`, [`fonts/${f}`, "font/ttf"]]),
  ),
};

export function uiToken(dir = dataDir()) {
  const file = join(dir, "ui-token");
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(24).toString("hex"), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return readFileSync(file, "utf8").trim();
}

const send = (res, status, body, type = "application/json; charset=utf-8") => {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 100000) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new engine.GateError("Invalid JSON"));
      }
    });
  });

export function createApp(token, port) {
  const expected = Buffer.from(token);
  const authorized = (req) => {
    const given = Buffer.from(String(req.headers["x-comp-token"] ?? ""));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  return createServer(async (req, res) => {
    // Reject DNS-rebinding requests that reach us under a foreign host name.
    const host = String(req.headers.host ?? "");
    if (![`127.0.0.1:${port()}`, `localhost:${port()}`].includes(host))
      return send(res, 421, { error: "Wrong host" });
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, readFileSync(join(WEB, file)), type);
    }
    if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found" });
    if (!authorized(req)) return send(res, 401, { error: "Missing or wrong token" });
    try {
      const parts = url.pathname.split("/").filter(Boolean).slice(1);
      if (req.method === "GET" && parts[0] === "health")
        return send(res, 200, { ok: true, app: APP.id });
      if (req.method === "GET" && parts[0] === "projects" && parts.length === 1)
        return send(res, 200, engine.listProjects());
      if (req.method === "GET" && parts[0] === "projects" && parts.length === 2)
        return send(res, 200, engine.projectDetail(parts[1]));
      if (
        req.method === "POST" &&
        parts[0] === "projects" &&
        parts[2] === "frameworks" &&
        parts[4] === "approve"
      ) {
        if (req.headers["content-type"] !== "application/json")
          return send(res, 415, { error: "JSON required" });
        const body = await readBody(req);
        return send(
          res,
          200,
          engine.approveFramework({
            project_id: parts[1],
            version: Number(parts[3]),
            approved_by: `${String(body.name || "user").slice(0, 60)} (web UI)`,
          }),
        );
      }
      if (req.method === "GET" && parts[0] === "reports" && parts.length === 2)
        return send(res, 200, engine.reportGet(parts[1]));
      if (req.method === "GET" && parts[0] === "reports" && parts[2] === "markdown")
        return send(
          res,
          200,
          engine.reportMarkdown(engine.reportGet(parts[1])),
          "text/markdown; charset=utf-8",
        );
      return send(res, 404, { error: "Not found" });
    } catch (e) {
      return send(res, e instanceof engine.GateError ? 400 : 500, {
        error: e instanceof engine.GateError ? e.message : "Server error",
      });
    }
  });
}

// One UI per data directory: a later session reuses a running one.
export async function startWeb({
  basePort = Number(setting("PORT") || 4317),
  token = uiToken(),
} = {}) {
  for (let port = basePort; port < basePort + 10; port++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { "x-comp-token": token },
        signal: AbortSignal.timeout(500),
      });
      if (r.ok && (await r.json()).app === APP.id)
        return { url: `http://127.0.0.1:${port}/#token=${token}`, reused: true };
    } catch {}
    const server = createApp(token, () => port);
    const ok = await new Promise((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (ok) {
      server.unref();
      return { url: `http://127.0.0.1:${port}/#token=${token}`, server };
    }
  }
  throw new Error("No free port for the web UI");
}
