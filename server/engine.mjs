// The four-step workflow: research -> approve framework -> freeze baseline ->
// compare & review. Claude does the research and writing; this module owns
// the rules every step must satisfy before it can advance.
import { all, one, run, tx, now, uid, nextId, log, parse } from "./store.mjs";

export class GateError extends Error {}
const fail = (message) => {
  throw new GateError(message);
};
const str = (v, name, min = 1, max = 4000) => {
  if (typeof v !== "string" || v.trim().length < min || v.length > max)
    fail(`${name} must be text of ${min}-${max} characters`);
  return v.trim();
};
const arr = (v, name) => {
  if (!Array.isArray(v)) fail(`${name} must be an array`);
  return v;
};
const oneOf = (v, name, values) => {
  if (!values.includes(v)) fail(`${name} must be one of: ${values.join(", ")}`);
  return v;
};

export const SOURCE_TYPES = [
  "vendor_site",
  "documentation",
  "pricing_page",
  "customer_case_study",
  "independent_review",
  "analyst_report",
  "news",
  "other",
];
export const ATTRIBUTIONS = [
  "vendor_claim",
  "independent_report",
  "customer_review",
  "direct_observation",
];
export const ANSWER_TYPES = [
  "boolean",
  "number",
  "price",
  "categorical",
  "list",
  "text",
  "link",
];
export const STATUSES = ["known", "unknown", "conflicting", "not_applicable"];
export const UNKNOWN_REASONS = [
  "not_found",
  "inaccessible",
  "stale",
  "insufficient_detail",
];

// ---------- domains ----------
const TWO_PART = /\.(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/;
export function siteDomain(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    fail(`Invalid URL: ${url}`);
  }
  const parts = host.split(".");
  return parts.slice(TWO_PART.test(host) ? -3 : -2).join(".");
}
export const blockedDomain = (url) =>
  one("SELECT domain,reason FROM blocked_domains WHERE domain=?", siteDomain(url));
// A domain that refuses crawling (robots.txt, 401/403, paywall) is excluded
// from all later evidence so no session retries it.
export function blockDomain(url, reason) {
  const domain = siteDomain(url);
  run(
    "INSERT INTO blocked_domains VALUES(?,?,?) ON CONFLICT(domain) DO NOTHING",
    domain,
    str(reason, "reason", 3, 500),
    now(),
  );
  return { domain, blocked: true };
}

// ---------- projects ----------
export function createProject(input) {
  return tx(() => {
    const id = uid("proj");
    run(
      "INSERT INTO projects VALUES(?,?,?,?,?,?)",
      id,
      str(input.name, "name", 1, 200),
      str(input.buyer, "buyer", 1, 1000),
      str(input.scope ?? "Product and commercial comparison", "scope", 1, 2000),
      str(input.region ?? "Global", "region", 1, 200),
      now(),
    );
    const reference = addCompany(id, input.reference, "reference");
    log(id, `Project created with reference ${reference.name}`);
    return { project_id: id, reference_company_id: reference.id };
  });
}
function addCompany(projectId, company, role) {
  if (!company || typeof company !== "object")
    fail(`${role} company {name, url} is required`);
  const c = {
    id: uid("co"),
    name: str(company.name, "company name", 1, 200),
    url: str(company.url, "company url", 4, 500),
  };
  siteDomain(c.url);
  run(
    "INSERT INTO companies VALUES(?,?,?,?,?,?)",
    c.id,
    projectId,
    c.name,
    c.url,
    role,
    now(),
  );
  return c;
}
export function addCompetitor({ project_id, name, url }) {
  return tx(() => {
    project(project_id);
    const c = addCompany(project_id, { name, url }, "competitor");
    log(project_id, `Competitor added: ${c.name}`);
    return { company_id: c.id };
  });
}
export const project = (id) =>
  one("SELECT * FROM projects WHERE id=?", id) || fail(`Unknown project ${id}`);
export const company = (id) =>
  one("SELECT * FROM companies WHERE id=?", id) || fail(`Unknown company ${id}`);
export const listProjects = () =>
  all(
    "SELECT p.id,p.name,p.buyer,p.created_at,(SELECT name FROM companies WHERE project_id=p.id AND role='reference') AS reference FROM projects p ORDER BY created_at DESC",
  );
export const reference = (projectId) =>
  one(
    "SELECT * FROM companies WHERE project_id=? AND role='reference'",
    projectId,
  );

// ---------- step 1: research ----------
export function addSource(input) {
  return tx(() => {
    const c = company(input.company_id);
    const url = str(input.url, "url", 4, 2000);
    const blocked = blockedDomain(url);
    if (blocked)
      fail(
        `Domain ${blocked.domain} is excluded (${blocked.reason}). Use another source.`,
      );
    const existing = one(
      "SELECT id FROM sources WHERE company_id=? AND url=?",
      c.id,
      url,
    );
    if (existing) return { source_id: existing.id, existing: true };
    const text = str(input.text, "text (the captured page text)", 200, 400000);
    const id = nextId("S");
    run(
      "INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      c.project_id,
      c.id,
      url,
      siteDomain(url),
      str(input.title, "title", 1, 500),
      str(input.publisher, "publisher", 1, 200),
      oneOf(input.type, "type", SOURCE_TYPES),
      text,
      input.published_at ?? null,
      now(),
      input.capture === "fetched" ? "fetched" : "supplied",
    );
    log(c.project_id, `${c.name}: source ${id} ${url}`);
    return { source_id: id };
  });
}
// Quotes must be copied, not paraphrased. Whitespace, quote marks and dashes
// are normalised because page captures vary on those alone.
export const normalize = (s) =>
  s
    .toLowerCase()
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

export function addEvidence({ company_id, items }) {
  return tx(() => {
    const c = company(company_id);
    const added = [];
    const rejected = [];
    arr(items, "items").forEach((item, index) => {
      try {
        const source = one(
          "SELECT * FROM sources WHERE id=?",
          String(item.source_id),
        );
        if (!source || source.company_id !== c.id)
          fail(`source ${item.source_id} is not a source for ${c.name}`);
        const excerpt = str(item.excerpt, "excerpt", 15, 1500);
        if (!normalize(source.text).includes(normalize(excerpt)))
          fail(
            "excerpt is not verbatim text from the source; copy the exact passage",
          );
        const id = nextId("E");
        run(
          "INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?)",
          id,
          c.project_id,
          c.id,
          source.id,
          str(item.claim, "claim", 3, 600),
          excerpt,
          oneOf(item.attribution ?? "vendor_claim", "attribution", ATTRIBUTIONS),
          JSON.stringify(arr(item.criterion_ids ?? [], "criterion_ids")),
          now(),
        );
        added.push({ index, evidence_id: id });
      } catch (e) {
        if (!(e instanceof GateError)) throw e;
        rejected.push({ index, reason: e.message });
      }
    });
    if (added.length)
      log(c.project_id, `${c.name}: ${added.length} evidence items added`);
    return { added, rejected };
  });
}

// ---------- step 2: framework ----------
export const latestFramework = (projectId, status) =>
  parse(
    one(
      `SELECT * FROM frameworks WHERE project_id=? ${status ? "AND status=?" : ""} ORDER BY version DESC LIMIT 1`,
      ...(status ? [projectId, status] : [projectId]),
    ),
    "criteria",
  );
export const approvedFramework = (projectId) =>
  latestFramework(projectId, "approved");
export const currentBaseline = (projectId) =>
  parse(
    one(
      "SELECT * FROM baselines WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      projectId,
    ),
    "snapshot",
  );

export function proposeFramework({ project_id, criteria }) {
  return tx(() => {
    project(project_id);
    if (currentBaseline(project_id))
      fail(
        "A baseline is frozen on the approved framework. Start a new project to change criteria.",
      );
    const list = arr(criteria, "criteria");
    if (list.length < 3 || list.length > 25)
      fail("A framework needs 3-25 criteria");
    const ids = new Set();
    const clean = list.map((c, i) => {
      const id = str(c.id, `criteria[${i}].id`, 2, 60);
      if (!/^[a-z0-9_]+$/.test(id))
        fail(`criteria[${i}].id must be snake_case`);
      if (ids.has(id)) fail(`Duplicate criterion id ${id}`);
      ids.add(id);
      return {
        id,
        label: str(c.label, `${id}.label`, 2, 120),
        definition: str(c.definition, `${id}.definition`, 10, 1000),
        answer_type: oneOf(c.answer_type, `${id}.answer_type`, ANSWER_TYPES),
        required_evidence: arr(c.required_evidence, `${id}.required_evidence`)
          .map((r, j) => str(r, `${id}.required_evidence[${j}]`, 3, 300))
          .slice(0, 8),
        comparison_rule: str(
          c.comparison_rule ?? "Compare like for like; note scope differences.",
          `${id}.comparison_rule`,
          3,
          500,
        ),
        importance: oneOf(c.importance ?? "important", `${id}.importance`, [
          "essential",
          "important",
          "optional",
        ]),
      };
    });
    clean.forEach((c) => {
      if (!c.required_evidence.length)
        fail(`${c.id} needs at least one required_evidence item`);
    });
    const version =
      (one(
        "SELECT MAX(version) AS v FROM frameworks WHERE project_id=?",
        project_id,
      ).v ?? 0) + 1;
    run(
      "UPDATE frameworks SET status='superseded' WHERE project_id=? AND status='draft'",
      project_id,
    );
    run(
      "INSERT INTO frameworks VALUES(?,?,?,?,?,?,?)",
      project_id,
      version,
      JSON.stringify(clean),
      "draft",
      null,
      null,
      now(),
    );
    log(project_id, `Framework v${version} proposed (${clean.length} criteria)`);
    return { version, status: "draft", criteria: clean.length };
  });
}
// The human gate: only the user approves a framework, in the web UI or by
// telling Claude explicitly.
export function approveFramework({ project_id, version, approved_by }) {
  return tx(() => {
    project(project_id);
    const f = one(
      "SELECT * FROM frameworks WHERE project_id=? AND version=?",
      project_id,
      Number(version),
    );
    if (!f) fail(`Framework v${version} does not exist`);
    if (f.status === "approved") return { version: f.version, status: "approved" };
    if (f.status !== "draft") fail(`Framework v${version} is ${f.status}`);
    if (currentBaseline(project_id))
      fail("A baseline is already frozen on an earlier framework");
    run(
      "UPDATE frameworks SET status='superseded' WHERE project_id=? AND status='approved'",
      project_id,
    );
    run(
      "UPDATE frameworks SET status='approved',approved_by=?,approved_at=? WHERE project_id=? AND version=?",
      str(approved_by, "approved_by", 1, 100),
      now(),
      project_id,
      f.version,
    );
    log(project_id, `Framework v${f.version} approved by ${approved_by}`);
    return { version: f.version, status: "approved" };
  });
}

// ---------- step 3/4: assessments ----------
export function setAssessments({ company_id, assessments }) {
  return tx(() => {
    const c = company(company_id);
    const framework = approvedFramework(c.project_id);
    if (!framework) fail("Approve a framework before recording assessments");
    if (c.role === "reference" && currentBaseline(c.project_id))
      fail("The baseline is frozen; reference assessments cannot change");
    const criteria = new Map(framework.criteria.map((x) => [x.id, x]));
    const saved = [];
    for (const [i, a] of arr(assessments, "assessments").entries()) {
      const id = String(a.criterion_id);
      if (!criteria.has(id))
        fail(`assessments[${i}]: ${id} is not in framework v${framework.version}`);
      const status = oneOf(a.status, `${id}.status`, STATUSES);
      const body = {
        criterion_id: id,
        status,
        answer:
          status === "unknown"
            ? null
            : str(a.answer, `${id}.answer`, 1, 2000),
        unknown_reason:
          status === "unknown"
            ? oneOf(a.unknown_reason, `${id}.unknown_reason`, UNKNOWN_REASONS)
            : null,
        evidence_ids: arr(a.evidence_ids ?? [], `${id}.evidence_ids`).map(String),
        contradicting_evidence_ids: arr(
          a.contradicting_evidence_ids ?? [],
          `${id}.contradicting_evidence_ids`,
        ).map(String),
        explanation: str(a.explanation, `${id}.explanation`, 3, 3000),
        attribution: oneOf(
          a.attribution ?? "vendor_claim",
          `${id}.attribution`,
          ATTRIBUTIONS,
        ),
      };
      const cited = [...body.evidence_ids, ...body.contradicting_evidence_ids];
      for (const e of cited) {
        const row = one("SELECT company_id FROM evidence WHERE id=?", e);
        if (!row || row.company_id !== c.id)
          fail(`${id}: ${e} is not evidence collected for ${c.name}`);
      }
      if (["known", "conflicting"].includes(status) && !body.evidence_ids.length)
        fail(`${id}: a ${status} answer must cite evidence`);
      if (status === "conflicting" && !body.contradicting_evidence_ids.length)
        fail(`${id}: a conflicting answer must cite contradicting evidence`);
      run(
        "INSERT INTO assessments VALUES(?,?,?,'pending','[]',?) ON CONFLICT(company_id,criterion_id) DO UPDATE SET body=excluded.body,gate='pending',gate_notes='[]',updated_at=excluded.updated_at",
        c.id,
        id,
        JSON.stringify(body),
        now(),
      );
      saved.push(id);
    }
    log(c.project_id, `${c.name}: ${saved.length} assessments recorded`);
    return { saved, gate: "pending — run gate_run" };
  });
}
export const assessmentsFor = (companyId) =>
  all(
    "SELECT * FROM assessments WHERE company_id=? ORDER BY rowid",
    companyId,
  ).map((r) => ({
    ...JSON.parse(r.body),
    gate: r.gate,
    gate_notes: JSON.parse(r.gate_notes),
  }));
export const evidenceFor = (companyId) =>
  all(
    "SELECT e.*,s.url,s.title,s.publisher,s.type AS source_type,s.published_at FROM evidence e JOIN sources s ON s.id=e.source_id WHERE e.company_id=? ORDER BY CAST(substr(e.id,2) AS INTEGER)",
    companyId,
  ).map((e) => ({ ...e, criterion_ids: JSON.parse(e.criterion_ids) }));

// Deterministic checks that need no model.
export function structuralIssues(c, framework) {
  const rows = assessmentsFor(c.id);
  const issues = [];
  const have = new Set(rows.map((r) => r.criterion_id));
  for (const cr of framework.criteria)
    if (!have.has(cr.id)) issues.push(`${cr.id}: no assessment recorded`);
  for (const r of rows)
    if (!framework.criteria.some((x) => x.id === r.criterion_id))
      issues.push(`${r.criterion_id}: not in the approved framework`);
  return issues;
}

export function freezeBaseline({ project_id }) {
  return tx(() => {
    project(project_id);
    if (currentBaseline(project_id))
      fail("A baseline is already frozen for this project");
    const framework = approvedFramework(project_id) ||
      fail("Approve a framework first");
    const ref = reference(project_id);
    const issues = structuralIssues(ref, framework);
    const rows = assessmentsFor(ref.id);
    for (const r of rows)
      if (r.gate === "pending") issues.push(`${r.criterion_id}: gate not run`);
      else if (r.gate === "failed")
        issues.push(
          `${r.criterion_id}: failed the fact gate — revise or mark unknown`,
        );
    if (issues.length) fail(`Baseline not ready:\n- ${issues.join("\n- ")}`);
    const cited = new Set(
      rows.flatMap((r) => [...r.evidence_ids, ...r.contradicting_evidence_ids]),
    );
    const snapshot = {
      company: { id: ref.id, name: ref.name, url: ref.url },
      framework,
      assessments: rows,
      evidence: evidenceFor(ref.id).filter((e) => cited.has(e.id)),
      verification: rows.some((r) => r.gate === "passed_unverified")
        ? "unverified"
        : "jev",
      gaps: rows
        .filter((r) => r.status === "unknown")
        .map((r) => ({ criterion_id: r.criterion_id, reason: r.unknown_reason })),
    };
    const id = uid("base");
    run(
      "INSERT INTO baselines VALUES(?,?,?,?,?,?)",
      id,
      project_id,
      framework.version,
      ref.id,
      JSON.stringify(snapshot),
      now(),
    );
    log(
      project_id,
      `Baseline frozen (${rows.length} criteria, ${snapshot.gaps.length} gaps)`,
    );
    return { baseline_id: id, gaps: snapshot.gaps };
  });
}

// ---------- step 4: narrative and report ----------
export function setNarrative({ company_id, narrative }) {
  return tx(() => {
    const c = company(company_id);
    if (c.role !== "competitor") fail("Narratives belong to a competitor");
    const baseline = currentBaseline(c.project_id) || fail("Freeze the baseline first");
    const framework = baseline.snapshot.framework;
    const ref = reference(c.project_id);
    const cited = (item, name) => {
      const ids = arr(item.evidence_ids, `${name}.evidence_ids`).map(String);
      if (!ids.length) fail(`${name} must cite evidence`);
      for (const e of ids) {
        const row = one("SELECT company_id FROM evidence WHERE id=?", e);
        if (!row || ![c.id, ref.id].includes(row.company_id))
          fail(`${name}: ${e} is not evidence for ${c.name} or ${ref.name}`);
      }
      return ids;
    };
    const n = narrative || fail("narrative is required");
    const body = {
      summary: arr(n.summary, "summary").map((s, i) => ({
        text: str(s.text, `summary[${i}].text`, 3, 1200),
        evidence_ids: cited(s, `summary[${i}]`),
      })),
      tradeoffs: arr(n.tradeoffs ?? [], "tradeoffs").map((s, i) => ({
        text: str(s.text, `tradeoffs[${i}].text`, 3, 1200),
        evidence_ids: cited(s, `tradeoffs[${i}]`),
      })),
      buyer_questions: arr(n.buyer_questions ?? [], "buyer_questions").map(
        (q, i) => ({
          question: str(q.question, `buyer_questions[${i}].question`, 3, 400),
          answer: str(q.answer, `buyer_questions[${i}].answer`, 3, 1200),
          evidence_ids: cited(q, `buyer_questions[${i}]`),
        }),
      ),
      limitations: arr(n.limitations ?? [], "limitations").map((l, i) =>
        str(l, `limitations[${i}]`, 3, 600),
      ),
      criterion_comparisons: arr(
        n.criterion_comparisons ?? [],
        "criterion_comparisons",
      ).map((x, i) => {
        const id = String(x.criterion_id);
        if (!framework.criteria.some((cr) => cr.id === id))
          fail(`criterion_comparisons[${i}]: ${id} is not a framework criterion`);
        return {
          criterion_id: id,
          text: str(x.text, `criterion_comparisons[${i}].text`, 3, 800),
          evidence_ids: cited(x, `criterion_comparisons[${i}]`),
        };
      }),
    };
    if (!body.summary.length) fail("summary needs at least one item");
    const seen = new Set();
    for (const x of body.criterion_comparisons) {
      if (seen.has(x.criterion_id))
        fail(`Two comparisons for ${x.criterion_id}`);
      seen.add(x.criterion_id);
    }
    run(
      "INSERT INTO narratives VALUES(?,?,'pending','[]',?) ON CONFLICT(company_id) DO UPDATE SET body=excluded.body,gate='pending',gate_notes='[]',updated_at=excluded.updated_at",
      c.id,
      JSON.stringify(body),
      now(),
    );
    log(c.project_id, `${c.name}: comparison narrative recorded`);
    return { saved: true, gate: "pending — run gate_run" };
  });
}
export const narrativeFor = (companyId) => {
  const r = one("SELECT * FROM narratives WHERE company_id=?", companyId);
  return r && { ...parse(r, "body", "gate_notes") };
};

export function finalizeComparison({ company_id }) {
  return tx(() => {
    const c = company(company_id);
    if (c.role !== "competitor") fail("Finalize a competitor comparison");
    const baseline = currentBaseline(c.project_id) ||
      fail("Freeze the baseline first");
    const issues = structuralIssues(c, baseline.snapshot.framework);
    const rows = assessmentsFor(c.id);
    for (const r of rows)
      if (r.gate === "pending") issues.push(`${r.criterion_id}: gate not run`);
      else if (r.gate === "failed")
        issues.push(`${r.criterion_id}: failed the fact gate`);
    const narrative = narrativeFor(c.id);
    if (!narrative) issues.push("narrative: not written");
    else if (narrative.gate === "pending") issues.push("narrative: gate not run");
    else if (narrative.gate === "failed")
      issues.push("narrative: failed the fact gate");
    // Every criterion needs a side-by-side summary unless both are unknown.
    if (narrative)
      for (const cr of baseline.snapshot.framework.criteria) {
        const both = [
          baseline.snapshot.assessments.find((a) => a.criterion_id === cr.id),
          rows.find((a) => a.criterion_id === cr.id),
        ];
        const compared = (narrative.body.criterion_comparisons ?? []).some(
          (x) => x.criterion_id === cr.id,
        );
        if (!compared && !both.every((a) => a?.status === "unknown"))
          issues.push(`${cr.id}: no side-by-side summary in the narrative`);
      }
    if (issues.length) fail(`Comparison not ready:\n- ${issues.join("\n- ")}`);
    const cited = new Set([
      ...rows.flatMap((r) => [...r.evidence_ids, ...r.contradicting_evidence_ids]),
      ...[
        ...narrative.body.summary,
        ...narrative.body.tradeoffs,
        ...narrative.body.buyer_questions,
        ...(narrative.body.criterion_comparisons ?? []),
      ].flatMap((x) => x.evidence_ids),
    ]);
    const evidence = [
      ...baseline.snapshot.evidence,
      ...evidenceFor(c.id),
      ...evidenceFor(baseline.company_id),
    ].filter(
      (e, i, list) => cited.has(e.id) && list.findIndex((x) => x.id === e.id) === i,
    );
    const p = project(c.project_id);
    const body = {
      project: { id: p.id, name: p.name, buyer: p.buyer, scope: p.scope, region: p.region },
      baseline_id: baseline.id,
      framework: baseline.snapshot.framework,
      reference: { ...baseline.snapshot.company, assessments: baseline.snapshot.assessments },
      competitor: { id: c.id, name: c.name, url: c.url, assessments: rows },
      narrative: narrative.body,
      evidence,
      verification:
        baseline.snapshot.verification === "jev" &&
        !rows.some((r) => r.gate === "passed_unverified") &&
        ["passed", "passed_vendor"].includes(narrative.gate)
          ? "jev"
          : "unverified",
    };
    const id = uid("rep");
    run(
      "INSERT INTO reports VALUES(?,?,?,?,?,?)",
      id,
      p.id,
      c.id,
      baseline.id,
      JSON.stringify(body),
      now(),
    );
    log(p.id, `Comparison report saved for ${c.name}`);
    return { report_id: id };
  });
}
export const reportGet = (id) =>
  parse(one("SELECT * FROM reports WHERE id=?", id), "body") ||
  fail(`Unknown report ${id}`);

// The narrative's comparison for one criterion. When both sides are
// unknown there is nothing to compare, so the status line is generated here
// rather than written (and fact-checked) as prose.
export function criterionSummary(narrative, id, ref, comp, refName, compName) {
  const x = (narrative?.criterion_comparisons ?? []).find((c) => c.criterion_id === id);
  if (x) return `${x.text} ${x.evidence_ids.map((e) => `[${e}]`).join("")}`;
  if (ref?.status === "unknown" && comp?.status === "unknown")
    return `Unknown for both (${refName}: ${ref.unknown_reason.replace("_", " ")}; ${compName}: ${comp.unknown_reason.replace("_", " ")}).`;
  return "—";
}

export function reportMarkdown(report) {
  const r = report.body;
  const ev = new Map(r.evidence.map((e) => [e.id, e]));
  const cite = (ids) => ids.map((i) => `[${i}]`).join("");
  const cell = (a) =>
    !a
      ? "—"
      : a.status === "unknown"
        ? `Unknown (${a.unknown_reason.replace("_", " ")})`
        : `${a.answer}${a.gate === "passed_vendor" ? " _(vendor-documented)_" : ""} ${cite(a.evidence_ids)}`.replace(/\|/g, "/");
  const lines = [
    `# ${r.reference.name} vs ${r.competitor.name}`,
    "",
    `For: ${r.project.buyer} · Scope: ${r.project.scope} · Region: ${r.project.region}`,
    `Verification: ${r.verification === "jev" ? "every factual sentence passed the Jev fact gate. Answers marked (vendor-documented) were checked against the company's own website and are not independently verified" : "NOT fact-checked by Jev"}`,
    "",
    "## Summary",
    ...r.narrative.summary.map((s) => `- ${s.text} ${cite(s.evidence_ids)}`),
  ];
  if (r.narrative.tradeoffs.length)
    lines.push("", "## Trade-offs", ...r.narrative.tradeoffs.map((s) => `- ${s.text} ${cite(s.evidence_ids)}`));
  lines.push(
    "",
    "## Criteria",
    "",
    `| Criterion | ${r.reference.name} | ${r.competitor.name} | Summary |`,
    "|---|---|---|---|",
    ...r.framework.criteria.map((c) => {
      const ref = r.reference.assessments.find((a) => a.criterion_id === c.id);
      const comp = r.competitor.assessments.find((a) => a.criterion_id === c.id);
      return `| ${c.label} | ${cell(ref)} | ${cell(comp)} | ${criterionSummary(r.narrative, c.id, ref, comp, r.reference.name, r.competitor.name).replace(/\|/g, "/")} |`;
    }),
  );
  if (r.narrative.buyer_questions.length)
    lines.push(
      "",
      "## Buyer questions",
      ...r.narrative.buyer_questions.flatMap((q) => [
        `**${q.question}**`,
        `${q.answer} ${cite(q.evidence_ids)}`,
        "",
      ]),
    );
  if (r.narrative.limitations.length)
    lines.push("", "## Limitations", ...r.narrative.limitations.map((l) => `- ${l}`));
  lines.push(
    "",
    "## Evidence",
    ...[...ev.values()].map(
      (e) =>
        `- **[${e.id}]** ${e.publisher}, “${e.title}” (${e.source_type.replace("_", " ")}) — “${e.excerpt}” <${e.url}>`,
    ),
  );
  return lines.join("\n") + "\n";
}

// ---------- status ----------
export function projectDetail(id) {
  const p = project(id);
  const companies = all(
    "SELECT * FROM companies WHERE project_id=? ORDER BY role DESC, created_at",
    id,
  ).map((c) => ({
    ...c,
    sources: all(
      "SELECT id,url,title,publisher,type,published_at,retrieved_at,capture,length(text) AS chars FROM sources WHERE company_id=? ORDER BY CAST(substr(id,2) AS INTEGER)",
      c.id,
    ),
    evidence: evidenceFor(c.id),
    assessments: assessmentsFor(c.id),
    narrative: c.role === "competitor" ? narrativeFor(c.id) : undefined,
    claim_reviews: all(
      "SELECT target,text,evidence_ids,verdict,confidence,checker,basis FROM claim_reviews WHERE company_id=? ORDER BY rowid DESC LIMIT 400",
      c.id,
    ).map((r) => ({ ...r, evidence_ids: JSON.parse(r.evidence_ids) })),
  }));
  const frameworks = all(
    "SELECT * FROM frameworks WHERE project_id=? ORDER BY version DESC",
    id,
  ).map((f) => parse(f, "criteria"));
  const baseline = currentBaseline(id);
  const reports = all(
    "SELECT id,company_id,created_at FROM reports WHERE project_id=? ORDER BY created_at DESC",
    id,
  );
  return {
    project: p,
    companies,
    frameworks,
    baseline,
    reports,
    steps: steps(id, companies, frameworks, baseline, reports),
    events: all(
      "SELECT message,created_at FROM events WHERE project_id=? ORDER BY id DESC LIMIT 50",
      id,
    ),
  };
}
function steps(id, companies, frameworks, baseline, reports) {
  const ref = companies.find((c) => c.role === "reference");
  const approved = frameworks.find((f) => f.status === "approved");
  const draft = frameworks.find((f) => f.status === "draft");
  const research = {
    status: ref.evidence.length ? "done" : "todo",
    detail: `${ref.sources.length} sources, ${ref.evidence.length} evidence items`,
  };
  const approve = {
    status: approved ? "done" : draft ? "waiting_for_user" : "todo",
    detail: approved
      ? `v${approved.version} approved by ${approved.approved_by}`
      : draft
        ? `v${draft.version} awaiting approval`
        : "no framework proposed",
  };
  const freeze = {
    status: baseline ? "done" : approved ? "todo" : "blocked",
    detail: baseline
      ? `frozen with ${baseline.snapshot.gaps.length} gaps`
      : `${ref.assessments.filter((a) => a.gate.startsWith("passed")).length}/${approved?.criteria.length ?? 0} criteria passed the gate`,
  };
  const competitors = companies.filter((c) => c.role === "competitor");
  const compare = {
    status: !baseline
      ? "blocked"
      : reports.length
        ? "done"
        : competitors.length
          ? "in_progress"
          : "todo",
    detail: competitors.length
      ? competitors
          .map(
            (c) =>
              `${c.name}: ${reports.some((r) => r.company_id === c.id) ? "report saved" : `${c.assessments.filter((a) => a.gate.startsWith("passed")).length} criteria passed`}`,
          )
          .join("; ")
      : "no competitor added",
  };
  return { research, approve, freeze, compare };
}
