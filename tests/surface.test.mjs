import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { fileURLToPath } from "node:url";

process.env.COMPARE_ANYTHING_DATA = mkdtempSync(join(tmpdir(), "compare-anything-surface-"));
const store = await import("../server/store.mjs");
const engine = await import("../server/engine.mjs");
const { robotsAllows, htmlToText, fetchPage } = await import("../server/fetch.mjs");
const { startWeb } = await import("../server/web.mjs");
const servers = [];
after(() => {
  servers.forEach((s) => s.close());
  store.close();
  rmSync(process.env.COMPARE_ANYTHING_DATA, { recursive: true, force: true });
});

test("robots rules use the longest match and agent groups", () => {
  const robots = "User-agent: *\nDisallow: /private\nAllow: /private/docs\n\nUser-agent: Googlebot\nDisallow: /";
  assert.equal(robotsAllows(robots, "/pricing"), true);
  assert.equal(robotsAllows(robots, "/private/x"), false);
  assert.equal(robotsAllows(robots, "/private/docs/a"), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /", "/a"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /*.pdf$", "/a.pdf"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /*.pdf$", "/a.pdf.html"), true);
});

test("html becomes readable text without scripts", () => {
  const { title, text } = htmlToText("<title>Plans &amp; pricing</title><script>evil()</script><h1>Plans</h1><p>Growth&nbsp;plan: $2,000&#47;mo</p><table><tr><td>A</td><td>B</td></tr></table>");
  assert.equal(title, "Plans & pricing");
  assert.ok(!text.includes("evil"));
  assert.match(text, /Growth plan: \$2,000\/mo/);
  assert.ok(!htmlToText("<p>a</p>\r\n\r\n<p>b</p>").text.includes("\r"));
});

test("a site that disallows crawling is blocked for every later fetch", async () => {
  let pageHits = 0;
  const fake = async (url) => {
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /", { status: 200 });
    pageHits++;
    return new Response("<p>x</p>", { headers: { "content-type": "text/html" } });
  };
  await assert.rejects(fetchPage("https://closed.example/a", fake), /robots.txt disallows/);
  await assert.rejects(fetchPage("https://www.closed.example/b", fake), /closed.example is excluded/);
  assert.equal(pageHits, 0);
  const forbidden = async (url) => new Response("", { status: url.endsWith("robots.txt") ? 404 : 403 });
  await assert.rejects(fetchPage("https://walled.example/a", forbidden), /HTTP 403.*domain excluded/);
  assert.ok(engine.blockedDomain("https://walled.example/other"));
});

test("web API requires the token and the local host, and approves frameworks", async () => {
  const web = await startWeb({ basePort: 46100, token: "t".repeat(48) });
  servers.push(web.server);
  const base = web.url.split("/#")[0];
  const { project_id } = engine.createProject({ name: "Web", buyer: "x", reference: { name: "Co", url: "https://co.example" } });
  engine.proposeFramework({
    project_id,
    criteria: ["a_one", "b_two", "c_three"].map((id) => ({ id, label: id, definition: "A definition here", answer_type: "text", required_evidence: ["docs"] })),
  });
  assert.equal((await fetch(`${base}/api/projects`)).status, 401);
  const headers = { "x-comp-token": "t".repeat(48) };
  assert.equal((await fetch(`${base}/api/projects`, { headers })).status, 200);
  // fetch cannot override Host, so send the rebinding request directly.
  const rebind = await new Promise((resolve, reject) =>
    request(`${base}/api/projects`, { headers: { ...headers, host: "evil.example" } }, resolve)
      .on("error", reject)
      .end(),
  );
  assert.equal(rebind.statusCode, 421);
  rebind.resume();
  const html = await fetch(`${base}/`);
  assert.match(html.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(await html.text(), /Compare Anything by GrowthCast/);
  for (const [path, type] of [["/tokens.css", "text/css"], ["/fonts/manrope-400.ttf", "font/ttf"], ["/favicon.jpg", "image/jpeg"]]) {
    const r = await fetch(`${base}${path}`);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get("content-type"), new RegExp(type));
  }
  assert.equal((await fetch(`${base}/fonts/../../server/web.mjs`)).status, 404);
  const approve = await fetch(`${base}/api/projects/${project_id}/frameworks/1/approve`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "Sam" }),
  });
  assert.equal(approve.status, 200);
  const detail = await (await fetch(`${base}/api/projects/${project_id}`, { headers })).json();
  assert.equal(detail.frameworks[0].status, "approved");
  assert.equal(detail.frameworks[0].approved_by, "Sam (web UI)");
  // A second session finds the running UI instead of starting another.
  const again = await startWeb({ basePort: 46100, token: "t".repeat(48) });
  assert.equal(again.reused, true);
});

test("the plugin's MCP server answers the handshake and lists tools", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(process.execPath, [join(root, "server/main.mjs")], {
    env: { ...process.env, COMPARE_ANYTHING_PORT: "46200" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = [];
  child.stdout.on("data", (d) => lines.push(...d.toString().split("\n").filter(Boolean)));
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  const wait = async (id) => {
    for (let i = 0; i < 100; i++) {
      const hit = lines.map((l) => JSON.parse(l)).find((m) => m.id === id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no reply ${id}`);
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal((await wait(1)).result.serverInfo.name, "compare-anything");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = (await wait(2)).result.tools.map((t) => t.name);
  for (const n of ["project_create", "page_fetch", "evidence_add", "framework_approve", "gate_run", "baseline_freeze", "comparison_finalize", "ui_url"])
    assert.ok(names.includes(n), n);
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "project_status", arguments: { project_id: "nope" } } });
  const err = await wait(3);
  assert.equal(err.result.isError, true);
  assert.match(err.result.content[0].text, /Unknown project/);
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ui_url", arguments: {} } });
  await new Promise((r) => setTimeout(r, 300));
  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ui_url", arguments: {} } });
  assert.match(JSON.parse((await wait(5)).result.content[0].text).url, /^http:\/\/127\.0\.0\.1:462\d\d\/#token=/);
  child.kill();
});
