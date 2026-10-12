// Fetches pages for evidence so excerpts are checked against what the site
// actually serves. Honors robots.txt; a domain that refuses crawling is
// excluded from all later evidence.
import { GateError, blockDomain, blockedDomain, siteDomain } from "./engine.mjs";

export const USER_AGENT = "CompareAnything/1.0 (GrowthCast evidence research; respects robots.txt)";
const MAX_BYTES = 3_000_000;
const robotsCache = new Map();

export function robotsAllows(robots, path, agent = "compareanything") {
  const groups = [];
  let current;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || current.rules.length) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
    } else if (current && (key === "allow" || key === "disallow"))
      current.rules.push({ allow: key === "allow", path: value });
  }
  const mine = groups.filter((g) =>
    g.agents.some((a) => a !== "*" && agent.includes(a)),
  );
  const rules = (mine.length ? mine : groups.filter((g) => g.agents.includes("*")))
    .flatMap((g) => g.rules)
    .filter((r) => r.path);
  let best;
  for (const r of rules) {
    const pattern = new RegExp(
      "^" +
        r.path
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\\\$$/, "$"),
    );
    if (pattern.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)))
      best = r;
  }
  return !best || best.allow;
}

async function checkRobots(url, fetchImpl) {
  const origin = new URL(url).origin;
  if (!robotsCache.has(origin)) {
    let text = "";
    try {
      const r = await fetchImpl(`${origin}/robots.txt`, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });
      if ([401, 403].includes(r.status)) {
        blockDomain(url, `robots.txt returned HTTP ${r.status}`);
        throw new GateError(`${siteDomain(url)} refuses crawlers (robots.txt HTTP ${r.status}); domain excluded`);
      }
      if (r.ok) text = (await r.text()).slice(0, 500000);
    } catch (e) {
      if (e instanceof GateError) throw e;
    }
    robotsCache.set(origin, text);
  }
  const { pathname, search } = new URL(url);
  if (!robotsAllows(robotsCache.get(origin), pathname + search)) {
    if (!robotsAllows(robotsCache.get(origin), "/"))
      blockDomain(url, "robots.txt disallows the whole site");
    throw new GateError(`robots.txt disallows ${url}`);
  }
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
    e[0] === "#"
      ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : (ENTITIES[e.toLowerCase()] ?? m),
  );
export function htmlToText(html) {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  const text = decode(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|hr)\b[^>]*>/gi, "\n")
      .replace(/<\/?(p|div|section|article|header|footer|li|ul|ol|h[1-6]|tr|table|blockquote|dd|dt|pre|main|nav|aside)\b[^>]*>/gi, "\n")
      .replace(/<(td|th)\b[^>]*>/gi, " | ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

export async function fetchPage(url, fetchImpl = fetch) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const parsed = new URL(current);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new GateError("Only http(s) pages can be fetched");
    const blocked = blockedDomain(current);
    if (blocked) throw new GateError(`Domain ${blocked.domain} is excluded (${blocked.reason})`);
    await checkRobots(current, fetchImpl);
    const r = await fetchImpl(current, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain;q=0.9,*/*;q=0.5" },
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      current = new URL(r.headers.get("location"), current).toString();
      continue;
    }
    if ([401, 402, 403, 451].includes(r.status)) {
      blockDomain(current, `HTTP ${r.status} (login wall, paywall or crawler block)`);
      throw new GateError(`HTTP ${r.status} from ${parsed.hostname}; domain excluded`);
    }
    if (!r.ok) throw new GateError(`HTTP ${r.status} fetching ${current}`);
    const type = r.headers.get("content-type") ?? "";
    if (!/text\/|html|xml|json/.test(type))
      throw new GateError(`Unsupported content type ${type || "unknown"}; fetch it another way and use source_add`);
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > MAX_BYTES) throw new GateError("Page is larger than 3 MB");
    const raw = body.toString("utf8");
    const page = /html|xml/.test(type) ? htmlToText(raw) : { title: "", text: raw.trim() };
    return { url: current, ...page };
  }
  throw new GateError("Too many redirects");
}
