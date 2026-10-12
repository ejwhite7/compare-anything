import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.COMPARE_ANYTHING_DATA = mkdtempSync(join(tmpdir(), "compare-anything-test-"));
const store = await import("../server/store.mjs");
const engine = await import("../server/engine.mjs");
const { runGate, factRequest, pack } = await import("../server/gates.mjs");
const { callTool } = await import("../server/tools.mjs");
after(() => {
  store.close();
  rmSync(process.env.COMPARE_ANYTHING_DATA, { recursive: true, force: true });
});

const PAGE = `Acme Analytics pricing. The Growth plan costs $2,000 per month and includes weekly model refreshes. ${"Additional product detail. ".repeat(10)} Acme is SOC 2 Type II certified according to its trust page.`;
const RIVAL = `Rival Insights pricing. Rival's Team plan costs $1,500 per month with monthly model refreshes. ${"More detail about the rival. ".repeat(10)}`;

// Jev mock: claims citing a passage that contains the claim's number pass;
// anything else is unknown. Records requests to check their shape.
const jevRequests = [];
const jev = async (url, init) => {
  const body = JSON.parse(init.body);
  jevRequests.push({ url, body });
  const answers = Object.fromEntries(
    body.state.claims.map((c, i) => {
      const text = c.passages.map((p) => body.state.passages[p].excerpt).join(" ");
      const number = c.text.match(/\$[\d,]+/)?.[0];
      const ok = !/guaranteed/i.test(c.text) && (!number || text.includes(number));
      return [`claim_${i}`, { type: "choice", choice: ok ? "true" : "unknown", confidence: ok ? 0.93 : 0.4 }];
    }),
  );
  return new Response(JSON.stringify({ answers }), { status: 200 });
};
const gate = (company_id) =>
  runGate({ company_id }, { config: { mode: "jev", key: "test", model: "typesafe/jev-1.13" }, fetchImpl: jev });

const criteria = [
  { id: "pricing", label: "Entry price", definition: "Published monthly price of the entry plan", answer_type: "price", required_evidence: ["pricing page"] },
  { id: "refresh", label: "Model refresh", definition: "How often models are refreshed", answer_type: "text", required_evidence: ["product docs"] },
  { id: "security", label: "Security certification", definition: "Independent security certifications held", answer_type: "list", required_evidence: ["trust page or audit report"] },
];

test("four steps advance only through their gates", async () => {
  const { project_id, reference_company_id: ref } = engine.createProject({
    name: "MMM vendors",
    buyer: "Head of growth choosing an MMM vendor",
    reference: { name: "Acme Analytics", url: "https://acme.example" },
  });
  // Step 1: research with verbatim evidence.
  const { source_id } = engine.addSource({ company_id: ref, url: "https://acme.example/pricing", title: "Pricing", publisher: "Acme", type: "pricing_page", text: PAGE });
  const ev = engine.addEvidence({
    company_id: ref,
    items: [
      { source_id, excerpt: "The Growth plan costs $2,000 per month", claim: "Growth is $2,000/month", criterion_ids: ["pricing"] },
      { source_id, excerpt: "includes weekly  model refreshes", claim: "Weekly refreshes", criterion_ids: ["refresh"] },
      { source_id, excerpt: "The Growth plan costs $1,000 per month", claim: "Invented" },
    ],
  });
  assert.equal(ev.added.length, 2, "whitespace differences are tolerated");
  assert.match(ev.rejected[0].reason, /verbatim/);
  const [price, refresh] = ev.added.map((a) => a.evidence_id);

  assert.throws(() => engine.setAssessments({ company_id: ref, assessments: [] }), /Approve a framework/);
  const { version } = engine.proposeFramework({ project_id, criteria });
  assert.equal(engine.projectDetail(project_id).steps.approve.status, "waiting_for_user");

  // Step 2: only an explicit approval unlocks assessment.
  engine.approveFramework({ project_id, version, approved_by: "tester" });

  // Step 3: assessments, gate, freeze.
  engine.setAssessments({
    company_id: ref,
    assessments: [
      { criterion_id: "pricing", status: "known", answer: "$2,000 per month (Growth plan)", evidence_ids: [price], explanation: "The pricing page lists the Growth plan at $2,000 per month." },
      { criterion_id: "refresh", status: "known", answer: "Weekly, guaranteed", evidence_ids: [refresh], explanation: "Models refresh weekly." },
    ],
  });
  assert.throws(() => engine.freezeBaseline({ project_id }), /security: no assessment recorded/);
  engine.setAssessments({ company_id: ref, assessments: [{ criterion_id: "security", status: "unknown", unknown_reason: "insufficient_detail", explanation: "Only a vendor statement was found." }] });
  let result = await gate(ref);
  assert.equal(result.criteria.find((c) => c.criterion_id === "refresh").gate, "failed");
  assert.match(result.next, /Revise failed answers/);
  assert.throws(() => engine.freezeBaseline({ project_id }), /refresh: failed the fact gate/);

  engine.setAssessments({ company_id: ref, assessments: [{ criterion_id: "refresh", status: "known", answer: "Weekly", evidence_ids: [refresh], explanation: "The Growth plan includes weekly model refreshes." }] });
  result = await gate(ref);
  // Acme's own pages only: checked as vendor-documented. Unknowns need no check.
  assert.deepEqual(result.criteria.map((c) => c.gate), ["passed_vendor", "passed_vendor", "passed"]);
  const vendorQuestion = jevRequests.at(-1).body.questions.claim_0;
  assert.match(vendorQuestion.instructions, /what the company documents about itself/);
  assert.match(vendorQuestion.criteria.true, /own website/);
  const { baseline_id, gaps } = engine.freezeBaseline({ project_id });
  assert.deepEqual(gaps, [{ criterion_id: "security", reason: "insufficient_detail" }]);
  assert.throws(() => engine.setAssessments({ company_id: ref, assessments: [] }), /frozen/);
  assert.throws(() => engine.proposeFramework({ project_id, criteria }), /baseline is frozen/);

  // Jev received shared passages and the ported fact criteria.
  const req = jevRequests.at(-1);
  assert.equal(req.url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(req.body.model, "typesafe/jev-1.13");
  assert.ok(Object.keys(req.body.state.passages).every((k) => /^p\d+$/.test(k)));
  assert.ok(req.body.questions.claim_0.criteria.unknown);
  assert.ok(
    jevRequests.some((r) => r.body.state.claims.some((c) => c.text === "Entry price for Acme Analytics: $2,000 per month (Growth plan)")),
  );

  // Step 4: competitor, narrative, report.
  const { company_id: rival } = engine.addCompetitor({ project_id, name: "Rival Insights", url: "https://rival.example" });
  const rs = engine.addSource({ company_id: rival, url: "https://rival.example/pricing", title: "Pricing", publisher: "Rival", type: "pricing_page", text: RIVAL });
  const [rp, rr] = engine
    .addEvidence({ company_id: rival, items: [
      { source_id: rs.source_id, excerpt: "Rival's Team plan costs $1,500 per month", claim: "Team is $1,500/month" },
      { source_id: rs.source_id, excerpt: "with monthly model refreshes", claim: "Monthly refreshes" },
    ] })
    .added.map((a) => a.evidence_id);
  assert.throws(
    () => engine.setAssessments({ company_id: rival, assessments: [{ criterion_id: "pricing", status: "known", answer: "x", evidence_ids: [price], explanation: "Cites the wrong company." }] }),
    /not evidence collected for Rival/,
  );
  engine.setAssessments({
    company_id: rival,
    assessments: [
      { criterion_id: "pricing", status: "known", answer: "$1,500 per month (Team plan)", evidence_ids: [rp], explanation: "Rival lists the Team plan at $1,500 per month." },
      { criterion_id: "refresh", status: "known", answer: "Monthly", evidence_ids: [rr], explanation: "Rival refreshes models monthly." },
      { criterion_id: "security", status: "unknown", unknown_reason: "not_found", explanation: "No security page was found." },
    ],
  });
  assert.throws(() => engine.finalizeComparison({ company_id: rival }), /gate not run/);
  engine.setNarrative({
    company_id: rival,
    narrative: {
      summary: [{ text: "Rival's entry plan costs $1,500 per month and Acme's costs $2,000 per month.", evidence_ids: [rp, price] }],
      tradeoffs: [{ text: "Acme refreshes models weekly; Rival refreshes monthly.", evidence_ids: [refresh, rr] }],
      limitations: ["Neither security posture could be verified."],
    },
  });
  // Finalizing needs a side-by-side summary for every criterion not unknown for both.
  result = await gate(rival);
  assert.throws(() => engine.finalizeComparison({ company_id: rival }), /pricing: no side-by-side summary/);
  engine.setNarrative({
    company_id: rival,
    narrative: {
      summary: [{ text: "Rival's entry plan costs $1,500 per month and Acme's costs $2,000 per month.", evidence_ids: [rp, price] }],
      tradeoffs: [{ text: "Acme refreshes models weekly; Rival refreshes monthly.", evidence_ids: [refresh, rr] }],
      limitations: ["Neither security posture could be verified."],
      criterion_comparisons: [
        { criterion_id: "pricing", text: "Rival's entry plan costs $1,500 a month and Acme's costs $2,000.", evidence_ids: [rp, price] },
        { criterion_id: "refresh", text: "Acme refreshes weekly and Rival monthly.", evidence_ids: [refresh, rr] },
      ],
    },
  });
  assert.throws(
    () => engine.setNarrative({ company_id: rival, narrative: { summary: [{ text: "x y z", evidence_ids: [rp] }], criterion_comparisons: [{ criterion_id: "nope", text: "abc", evidence_ids: [rp] }] } }),
    /nope is not a framework criterion/,
  );
  result = await gate(rival);
  assert.equal(result.narrative.gate, "passed_vendor");
  const { report_id } = engine.finalizeComparison({ company_id: rival });
  const md = await callTool("report_get", { report_id });
  assert.match(md, /# Acme Analytics vs Rival Insights/);
  assert.match(md, /every factual sentence passed the Jev fact gate/);
  assert.match(md, /\| Entry price \| \$2,000 per month \(Growth plan\) _\(vendor-documented\)_ \[E1\] \| \$1,500 per month \(Team plan\) _\(vendor-documented\)_ \[E3\] \|/);
  assert.match(md, /Unknown \(insufficient detail\)/);
  assert.match(md, /\| Criterion \| Acme Analytics \| Rival Insights \| Summary \|/);
  assert.match(md, /Acme refreshes weekly and Rival monthly\. \[E2\]\[E4\] \|/);
  assert.match(md, /Unknown for both \(Acme Analytics: insufficient detail; Rival Insights: not found\)/);
  const detail = engine.projectDetail(project_id);
  assert.deepEqual(Object.values(detail.steps).map((s) => s.status), ["done", "done", "done", "done"]);
  assert.equal(detail.baseline.id, baseline_id);
});

test("blocked domains are excluded from evidence", () => {
  const { reference_company_id: ref } = engine.createProject({ name: "B", buyer: "x", reference: { name: "Co", url: "https://co.example" } });
  engine.blockDomain("https://www.linkedin.com/company/x", "robots.txt disallows the whole site");
  assert.throws(
    () => engine.addSource({ company_id: ref, url: "https://uk.linkedin.com/in/y", title: "t", publisher: "p", type: "other", text: PAGE }),
    /linkedin.com is excluded/,
  );
  assert.equal(engine.siteDomain("https://shop.example.co.uk/a"), "example.co.uk");
});

test("fact requests share passages and pack under the context budget", () => {
  const passage = (id) => ({ id, excerpt: "x".repeat(1400), source: {} });
  const claims = Array.from({ length: 80 }, (_, i) => ({ text: `Claim ${i}`, passages: [passage(`E${i % 50}`)], context: { company: "A" } }));
  const groups = pack(claims);
  assert.ok(groups.length > 1);
  for (const g of groups) {
    assert.ok(g.length <= 32);
    assert.ok(JSON.stringify(factRequest(g)).length <= 60000);
  }
  // Each answer is checked in its own request.
  const byTarget = pack([
    { ...claims[0], target: "a" },
    { ...claims[1], target: "a" },
    { ...claims[2], target: "b" },
  ]);
  assert.deepEqual(byTarget.map((g) => g.length), [2, 1]);
  const one = factRequest([claims[0], { ...claims[0], text: "Same passage" }]);
  assert.equal(Object.keys(one.state.passages).length, 1);
  assert.equal(one.state.contexts.length, 1);
});

test("the gate refuses to run without a Jev key unless explicitly off", async () => {
  const { jevConfig } = await import("../server/gates.mjs");
  assert.throws(() => jevConfig({}), /OPENROUTER_API_KEY/);
  assert.deepEqual(jevConfig({ COMPARE_ANYTHING_JEV: "off" }), { mode: "off" });
});

test("independent sources are checked as facts, not vendor documentation", async () => {
  const { project_id, reference_company_id: ref } = engine.createProject({ name: "Ind", buyer: "x", reference: { name: "Acme Two", url: "https://acme2.example" } });
  const review = engine.addSource({ company_id: ref, url: "https://reviews.example/acme2", title: "Review", publisher: "Reviews Inc", type: "independent_review", text: PAGE });
  const [e] = engine.addEvidence({ company_id: ref, items: [{ source_id: review.source_id, excerpt: "The Growth plan costs $2,000 per month", claim: "Growth is $2,000/month" }] }).added.map((a) => a.evidence_id);
  engine.proposeFramework({ project_id, criteria });
  engine.approveFramework({ project_id, version: 1, approved_by: "t" });
  engine.setAssessments({ company_id: ref, assessments: [
    { criterion_id: "pricing", status: "known", answer: "$2,000 per month", evidence_ids: [e], explanation: "An independent review lists $2,000 per month." },
    { criterion_id: "refresh", status: "unknown", unknown_reason: "not_found", explanation: "Not found." },
    { criterion_id: "security", status: "unknown", unknown_reason: "not_found", explanation: "Not found." },
  ] });
  const result = await gate(ref);
  assert.equal(result.criteria[0].gate, "passed");
  const q = jevRequests.at(-1).body.questions.claim_0;
  assert.match(q.instructions, /Do not merely verify that a speaker made the claim/);
  assert.ok(!JSON.stringify(jevRequests.at(-1).body.state).includes("acme2.example\",\"domain"));
  assert.ok(!("domain" in Object.values(jevRequests.at(-1).body.state.passages)[0]));
});

test("repeated Jev readings are averaged before the 0.8 threshold", async () => {
  const { combine, verdict } = await import("../server/gates.mjs");
  const read = (t) => ({ type: "choice", choice: "true", confidence: t, probabilities: { true: t, false: 0, unknown: 1 - t } });
  assert.equal(verdict(combine([read(0.74), read(0.95), read(0.9)])), "true");
  assert.equal(verdict(combine([read(0.6), read(0.7), read(0.95)])), "unknown");
  assert.equal(combine([read(0.9), undefined]).samples, 1);
});
