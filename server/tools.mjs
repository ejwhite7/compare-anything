// MCP tool definitions. Descriptions are the contract Claude follows, so they
// state each gate plainly.
import { writeFileSync } from "node:fs";
import * as engine from "./engine.mjs";
import { runGate } from "./gates.mjs";
import { fetchPage } from "./fetch.mjs";
import { one } from "./store.mjs";

const PAGE = 30000;
function readSource(source_id, offset = 0) {
  const src = one("SELECT id,url,title,text FROM sources WHERE id=?", source_id);
  if (!src) throw new engine.GateError(`Unknown source ${source_id}`);
  const text = src.text.slice(offset, offset + PAGE);
  return {
    source_id: src.id,
    url: src.url,
    title: src.title,
    offset,
    total_chars: src.text.length,
    next_offset: offset + PAGE < src.text.length ? offset + PAGE : null,
    text,
  };
}

const s = (description, extra = {}) => ({ type: "string", description, ...extra });
const ids = (description) => ({ type: "array", items: { type: "string" }, description });
const obj = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

let uiUrl = () => "The web UI is not running";
export const setUiUrl = (fn) => (uiUrl = fn);

function nextAction(detail) {
  const { research, approve, freeze, compare } = detail.steps;
  if (research.status !== "done")
    return "Step 1: research the reference company — add sources and verbatim evidence, then propose a framework.";
  if (approve.status === "todo") return "Step 1: propose a criteria framework.";
  if (approve.status === "waiting_for_user")
    return "Step 2: ask the user to review and approve the framework (web UI or explicit confirmation).";
  if (freeze.status !== "done")
    return "Step 3: assess every criterion for the reference, run gate_run until no criterion fails, then baseline_freeze.";
  if (compare.status === "todo") return "Step 4: add a competitor with competitor_add.";
  return "Step 4: research the competitor, assess it against the frozen framework, write the narrative, gate_run, then comparison_finalize.";
}

function compactStatus(detail) {
  const framework =
    detail.frameworks.find((f) => f.status === "approved") ||
    detail.frameworks.find((f) => f.status === "draft");
  return {
    project: detail.project,
    steps: detail.steps,
    next_action: nextAction(detail),
    framework: framework && {
      version: framework.version,
      status: framework.status,
      criteria: framework.criteria.map((c) => ({
        id: c.id,
        label: c.label,
        required_evidence: c.required_evidence,
      })),
    },
    baseline_id: detail.baseline?.id ?? null,
    companies: detail.companies.map((c) => ({
      company_id: c.id,
      name: c.name,
      role: c.role,
      url: c.url,
      sources: c.sources.length,
      evidence: c.evidence.length,
      evidence_by_criterion: Object.fromEntries(
        (framework?.criteria ?? []).map((cr) => [
          cr.id,
          c.evidence.filter((e) => e.criterion_ids.includes(cr.id)).length,
        ]),
      ),
      assessments: c.assessments.map((a) => ({
        criterion_id: a.criterion_id,
        status: a.status,
        gate: a.gate,
        failed_claims: a.gate_notes,
      })),
      narrative_gate: c.narrative?.gate,
    })),
    reports: detail.reports,
    web_ui: uiUrl(),
  };
}

const assessment = obj(
  {
    criterion_id: s("Criterion id from the approved framework"),
    status: s("known | unknown | conflicting | not_applicable", { enum: engine.STATUSES }),
    answer: s("Plain-language answer (omit when unknown). Say only what the cited excerpts support."),
    unknown_reason: s("Required when unknown", { enum: engine.UNKNOWN_REASONS }),
    evidence_ids: ids("Evidence ids (E…) supporting the answer"),
    contradicting_evidence_ids: ids("Evidence ids that contradict it (required for conflicting)"),
    explanation: s("One to three sentences explaining the answer and its limits"),
    attribution: s("Who asserts it", { enum: engine.ATTRIBUTIONS }),
  },
  ["criterion_id", "status", "explanation"],
);

export const tools = [
  {
    name: "project_create",
    description:
      "Start a comparison project for a reference company (step 1). Returns project_id and the reference company_id.",
    inputSchema: obj(
      {
        name: s("Project name"),
        buyer: s("Who the comparison is for and what they need to decide"),
        scope: s("Product scope, e.g. 'Marketing mix modelling platforms'"),
        region: s("Market region"),
        reference: obj({ name: s("Reference company name"), url: s("Its website") }),
      },
      ["name", "buyer", "reference"],
    ),
    handler: engine.createProject,
  },
  {
    name: "project_list",
    description: "List comparison projects.",
    inputSchema: obj({}, []),
    handler: () => engine.listProjects(),
  },
  {
    name: "project_status",
    description:
      "Where a project stands in the four steps, the next action, framework criteria, evidence counts per criterion, and gate results. Call this first when resuming.",
    inputSchema: obj({ project_id: s("Project id") }),
    handler: ({ project_id }) => compactStatus(engine.projectDetail(project_id)),
  },
  {
    name: "competitor_add",
    description: "Add a competitor to compare against the frozen baseline (step 4).",
    inputSchema: obj({ project_id: s("Project id"), name: s("Company name"), url: s("Website") }),
    handler: engine.addCompetitor,
  },
  {
    name: "page_fetch",
    description:
      "Preferred way to capture a source: fetches the page in the plugin (honoring robots.txt), stores its text and returns the first 30k characters to read. Uncrawlable domains are excluded automatically; do not retry them. Use source_read for the rest of a long page.",
    inputSchema: obj(
      {
        company_id: s("Company the page is about"),
        url: s("Page URL"),
        publisher: s("Who published it"),
        type: s("Source type", { enum: engine.SOURCE_TYPES }),
        published_at: s("Publication or last-updated date if known (YYYY-MM-DD)"),
      },
      ["company_id", "url", "publisher", "type"],
    ),
    handler: async ({ company_id, url, publisher, type, published_at }) => {
      engine.company(company_id);
      const page = await fetchPage(url);
      if (page.text.length < 200)
        throw new engine.GateError(
          `Only ${page.text.length} characters of text at ${page.url}; the page may need JavaScript. Try another source.`,
        );
      const { source_id, existing } = engine.addSource({
        company_id,
        url: page.url,
        title: page.title || page.url,
        publisher,
        type,
        text: page.text,
        published_at,
        capture: "fetched",
      });
      // A page already stored is not resent; read it with source_read.
      if (existing)
        return { source_id, existing: true, note: "Already captured; use source_read if needed" };
      return readSource(source_id);
    },
  },
  {
    name: "source_read",
    description: "Read a stored source's text from an offset (30k characters per call).",
    inputSchema: obj(
      { source_id: s("Source id (S…)"), offset: { type: "integer", description: "Character offset" } },
      ["source_id"],
    ),
    handler: ({ source_id, offset }) => readSource(source_id, offset ?? 0),
  },
  {
    name: "source_add",
    description:
      "Fallback when page_fetch cannot read a page (PDFs, JavaScript-only pages): store text you obtained another way. Pass the text exactly as retrieved, never a summary; excerpts are checked against it. Fails for excluded domains. Returns a source id (S…).",
    inputSchema: obj(
      {
        company_id: s("Company the source is about"),
        url: s("Page URL"),
        title: s("Page title"),
        publisher: s("Who published it"),
        type: s("Source type", { enum: engine.SOURCE_TYPES }),
        text: s("The retrieved page text"),
        published_at: s("Publication or last-updated date if shown (YYYY-MM-DD)"),
      },
      ["company_id", "url", "title", "publisher", "type", "text"],
    ),
    handler: engine.addSource,
  },
  {
    name: "source_block",
    description:
      "Exclude a domain from all evidence when it cannot be crawled (robots.txt disallow, 401/403, login wall, paywall). Never retry an excluded domain.",
    inputSchema: obj({ url: s("Any URL on the domain"), reason: s("Why it is uncrawlable") }),
    handler: ({ url, reason }) => engine.blockDomain(url, reason),
  },
  {
    name: "evidence_add",
    description:
      "Record evidence from stored sources. Each excerpt must be copied verbatim from the source text (checked); the claim is your one-sentence reading of it. Tag the criteria it informs. Returns evidence ids (E…) and any rejected items with reasons.",
    inputSchema: obj({
      company_id: s("Company the evidence is about"),
      items: {
        type: "array",
        items: obj(
          {
            source_id: s("Source id (S…)"),
            excerpt: s("Exact passage copied from the source, 15-1500 chars"),
            claim: s("What the excerpt establishes, in one sentence"),
            attribution: s("Who asserts it", { enum: engine.ATTRIBUTIONS }),
            criterion_ids: ids("Framework criterion ids this informs"),
          },
          ["source_id", "excerpt", "claim"],
        ),
      },
    }),
    handler: engine.addEvidence,
  },
  {
    name: "evidence_list",
    description: "List a company's evidence (id, claim, excerpt, source), optionally for one criterion.",
    inputSchema: obj({ company_id: s("Company id"), criterion_id: s("Optional criterion id") }, ["company_id"]),
    handler: ({ company_id, criterion_id }) =>
      engine
        .evidenceFor(company_id)
        .filter((e) => !criterion_id || e.criterion_ids.includes(criterion_id))
        .map(({ id, claim, excerpt, attribution, criterion_ids, publisher, title, url, source_type }) => ({
          id, claim, excerpt, attribution, criterion_ids, source: { publisher, title, url, type: source_type },
        })),
  },
  {
    name: "framework_propose",
    description:
      "Propose the criteria framework from the reference research (end of step 1). The user must approve it before any assessment. Proposing again replaces the pending draft.",
    inputSchema: obj({
      project_id: s("Project id"),
      criteria: {
        type: "array",
        items: obj(
          {
            id: s("snake_case id"),
            label: s("Short label"),
            definition: s("What the criterion asks, precisely"),
            answer_type: s("Answer type", { enum: engine.ANSWER_TYPES }),
            required_evidence: ids("What evidence would answer it"),
            comparison_rule: s("How to compare two answers fairly"),
            importance: s("Buyer importance", { enum: ["essential", "important", "optional"] }),
          },
          ["id", "label", "definition", "answer_type", "required_evidence"],
        ),
      },
    }),
    handler: engine.proposeFramework,
  },
  {
    name: "framework_approve",
    description:
      "Step 2, the human gate. Call ONLY after the user has explicitly approved this framework version in this conversation; quote their words. The user can also approve in the web UI.",
    inputSchema: obj({
      project_id: s("Project id"),
      version: { type: "integer", description: "Framework version" },
      user_confirmation: s("The user's own words approving it"),
    }),
    handler: ({ project_id, version, user_confirmation }) =>
      engine.approveFramework({
        project_id,
        version,
        approved_by: `user via Claude: "${String(user_confirmation).slice(0, 80)}"`,
      }),
  },
  {
    name: "assessments_set",
    description:
      "Record answers for a company against the approved framework (steps 3 and 4). Known answers must cite evidence; prefer unknown over a guess. Resets that company's gate to pending.",
    inputSchema: obj({
      company_id: s("Company id"),
      assessments: { type: "array", items: assessment },
    }),
    handler: engine.setAssessments,
  },
  {
    name: "gate_run",
    description:
      "Run the gates for one company: structure, citations, and the Jev fact check of every factual sentence against its cited excerpts (confidence ≥ 0.8). Returns failed claims to fix.",
    inputSchema: obj({ company_id: s("Company id") }),
    handler: (input) => runGate(input),
  },
  {
    name: "baseline_freeze",
    description:
      "Step 3: freeze the reference company's answers as the baseline. Requires every criterion assessed and no gate failures; unknowns are allowed and listed as gaps. Irreversible.",
    inputSchema: obj({ project_id: s("Project id") }),
    handler: engine.freezeBaseline,
  },
  {
    name: "narrative_set",
    description:
      "Step 4: write the comparison narrative for a competitor against the baseline. Every item cites evidence from either company. No universal winner; preserve unknowns.",
    inputSchema: obj({
      company_id: s("Competitor company id"),
      narrative: obj(
        {
          summary: {
            type: "array",
            items: obj({ text: s("One factual sentence or two"), evidence_ids: ids("Citations") }),
          },
          tradeoffs: {
            type: "array",
            items: obj({ text: s("A supported trade-off"), evidence_ids: ids("Citations") }),
          },
          buyer_questions: {
            type: "array",
            items: obj({ question: s("Question"), answer: s("Answer"), evidence_ids: ids("Citations") }),
          },
          limitations: { type: "array", items: s("A research limitation") },
          criterion_comparisons: {
            type: "array",
            description:
              "One per framework criterion: how the two companies' answers differ or match, citing both. Required for every criterion unless both answers are unknown.",
            items: obj({
              criterion_id: s("Framework criterion id"),
              text: s("One or two factual sentences comparing the two answers"),
              evidence_ids: ids("Citations from either company"),
            }),
          },
        },
        ["summary"],
      ),
    }),
    handler: engine.setNarrative,
  },
  {
    name: "comparison_finalize",
    description:
      "Step 4: save the comparison report once the competitor's answers and narrative pass the gate.",
    inputSchema: obj({ company_id: s("Competitor company id") }),
    handler: engine.finalizeComparison,
  },
  {
    name: "report_get",
    description:
      "Get a saved report as markdown or JSON; optionally write it to a file path.",
    inputSchema: obj(
      {
        report_id: s("Report id"),
        format: s("markdown or json", { enum: ["markdown", "json"] }),
        save_path: s("Optional absolute file path to write"),
      },
      ["report_id"],
    ),
    handler: ({ report_id, format = "markdown", save_path }) => {
      const report = engine.reportGet(report_id);
      const text =
        format === "json"
          ? JSON.stringify(report.body, null, 2)
          : engine.reportMarkdown(report);
      if (save_path) writeFileSync(save_path, text);
      return save_path ? { saved: save_path, chars: text.length } : text;
    },
  },
  {
    name: "ui_url",
    description: "The local web interface URL for reviewing projects and approving frameworks.",
    inputSchema: obj({}, []),
    handler: () => ({ url: uiUrl() }),
  },
];

export async function callTool(name, args) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new engine.GateError(`Unknown tool ${name}`);
  return tool.handler(args ?? {});
}
