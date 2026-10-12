// Compare Anything web UI. Renders only through h(), which sets text content, so
// captured source text can never inject markup.
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {}))
    if (v === undefined || v === false || v === null) continue;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  for (const c of children.flat(Infinity))
    if (c !== undefined && c !== null && c !== false)
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};
// replaceChildren does not flatten arrays, so every view goes through fill().
const fill = (el, ...children) =>
  el.replaceChildren(
    ...children.flat(Infinity).filter((c) => c !== undefined && c !== null && c !== false),
  );
const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : undefined);
const label = (s) => String(s).replaceAll("_", " ");
const badge = (s, text = label(s)) => h("span", { class: `badge ${s}` }, text);

// The token arrives in the URL fragment once, then lives in local storage.
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};
const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
if (fromHash) {
  store.set("comp-token", fromHash);
  history.replaceState(null, "", location.pathname);
}
const token = fromHash || store.get("comp-token");

async function api(path, options = {}) {
  const r = await fetch(`/api/${path}`, {
    ...options,
    headers: { "x-comp-token": token ?? "", ...(options.headers ?? {}) },
  });
  const type = r.headers.get("content-type") ?? "";
  const body = type.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error(body.error ?? r.statusText);
  return body;
}

const state = {
  projects: [],
  projectId: store.get("comp-project"),
  tab: store.get("comp-tab") || "overview",
  detail: null,
  companyId: null,
  criterion: "",
};
const main = document.getElementById("main");
const nav = document.getElementById("projects");
const drawer = document.getElementById("drawer");

function closeDrawer() {
  drawer.hidden = true;
  fill(drawer);
}
document.addEventListener("keydown", (e) => e.key === "Escape" && closeDrawer());

function evidenceIndex() {
  const map = new Map();
  for (const c of state.detail?.companies ?? [])
    for (const e of c.evidence) map.set(e.id, { ...e, company: c.name });
  for (const e of state.detail?.baseline?.snapshot.evidence ?? [])
    if (!map.has(e.id)) map.set(e.id, e);
  return map;
}
function showEvidence(id) {
  const e = evidenceIndex().get(id);
  fill(drawer, 
    h("div", { class: "row" }, h("strong", {}, id), h("span", { class: "flex1" }), h("button", { onclick: closeDrawer }, "Close")),
    e
      ? [
          h("p", {}, e.claim),
          h("blockquote", {}, e.excerpt),
          h("p", { class: "small" },
            h("strong", {}, e.publisher), " · ", e.title, " · ", label(e.source_type ?? ""),
            e.published_at ? ` · ${e.published_at}` : ""),
          h("p", { class: "small" }, badge("chip", label(e.attribution)), " ",
            e.company ? h("span", { class: "muted" }, e.company) : ""),
          safeUrl(e.url) && h("p", {}, h("a", { href: safeUrl(e.url), target: "_blank", rel: "noopener noreferrer" }, e.url)),
        ]
      : h("p", { class: "muted" }, "Evidence not found."),
  );
  drawer.hidden = false;
}
const cites = (ids = []) => ids.map((id) => h("button", { class: "cite", onclick: () => showEvidence(id), title: "Show evidence" }, id));

// ---------- views ----------
function stepsView(d) {
  const names = { research: "1 · Research", approve: "2 · Approve framework", freeze: "3 · Freeze baseline", compare: "4 · Compare & review" };
  return h("div", { class: "steps" },
    Object.entries(d.steps).map(([k, s]) =>
      h("div", { class: "step" }, h("b", {}, names[k]), badge(s.status), h("div", { class: "small muted" }, s.detail))));
}

function overview(d) {
  const draft = d.frameworks.find((f) => f.status === "draft");
  return [
    draft &&
      h("div", { class: "callout" },
        h("strong", {}, `Framework v${draft.version} is waiting for your approval. `),
        "Review the criteria in the Framework tab. Claude cannot assess anything until you approve.",
        " ", h("button", { onclick: () => setTab("framework") }, "Review framework")),
    h("h2", {}, "Companies"),
    h("div", { class: "list" },
      d.companies.map((c) =>
        h("div", {},
          h("div", { class: "row" }, h("strong", {}, c.name), badge(c.role), safeUrl(c.url) && h("a", { href: safeUrl(c.url), target: "_blank", rel: "noopener noreferrer", class: "small" }, c.url)),
          h("div", { class: "small muted" },
            `${c.sources.length} sources · ${c.evidence.length} evidence · ${c.assessments.length} answers · `,
            `${c.assessments.filter((a) => a.gate === "failed").length} failing the fact gate`)))),
    h("h2", {}, "Activity"),
    h("div", { class: "small" },
      d.events.map((e) => h("div", {}, h("span", { class: "muted" }, new Date(e.created_at).toLocaleString(), " — "), e.message))),
  ];
}

function framework(d) {
  if (!d.frameworks.length) return h("p", { class: "muted" }, "Claude has not proposed a framework yet.");
  const [f, ...older] = d.frameworks;
  const approve = async (btn, name) => {
    btn.disabled = true;
    try {
      await api(`projects/${d.project.id}/frameworks/${f.version}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await refresh();
    } catch (e) {
      alert(e.message);
      btn.disabled = false;
    }
  };
  const nameInput = h("input", { placeholder: "Your name", "aria-label": "Your name", value: store.get("comp-name") ?? "" });
  return [
    h("div", { class: "row" }, h("h2", { class: "m0" }, `Framework v${f.version}`), badge(f.status),
      f.approved_by && h("span", { class: "small muted" }, `approved by ${f.approved_by}`)),
    f.status === "draft" &&
      h("div", { class: "callout row" },
        h("span", {}, "Approving freezes these criteria for the baseline and every comparison."),
        nameInput,
        h("button", {
          class: "primary",
          onclick: (ev) => {
            store.set("comp-name", nameInput.value);
            approve(ev.currentTarget, nameInput.value || "user");
          },
        }, "Approve framework")),
    h("div", { class: "table-wrap" },
      h("table", {},
        h("thead", {}, h("tr", {}, ["Criterion", "Definition", "Evidence needed", "Answer", "Importance"].map((t) => h("th", {}, t)))),
        h("tbody", {},
          f.criteria.map((c) =>
            h("tr", {},
              h("td", {}, h("strong", {}, c.label), h("div", { class: "small muted" }, c.id)),
              h("td", {}, c.definition, h("div", { class: "small muted" }, c.comparison_rule)),
              h("td", { class: "small" }, h("ul", { class: "tight" }, c.required_evidence.map((r) => h("li", {}, r)))),
              h("td", {}, label(c.answer_type)),
              h("td", {}, badge(c.importance === "essential" ? "in_progress" : "chip", c.importance))))))),
    older.length > 0 && h("p", { class: "small muted" }, `Earlier versions: ${older.map((o) => `v${o.version} (${o.status})`).join(", ")}`),
  ];
}

function cell(a) {
  if (!a) return h("td", { class: "muted" }, "—");
  return h("td", {},
    h("div", { class: "row" }, badge(a.status), badge(a.gate, a.gate === "passed_vendor" ? "vendor-documented" : undefined)),
    h("div", {}, a.status === "unknown" ? h("span", { class: "muted" }, `Unknown — ${label(a.unknown_reason)}`) : a.answer, " ", cites(a.evidence_ids)),
    a.contradicting_evidence_ids.length > 0 && h("div", { class: "small" }, "Contradicted by ", cites(a.contradicting_evidence_ids)),
    h("div", { class: "small muted" }, a.explanation),
    a.gate_notes.length > 0 && h("ul", { class: "notes" }, a.gate_notes.map((n) => h("li", {}, n))));
}

function comparison(d) {
  const f = d.baseline?.snapshot.framework ?? d.frameworks.find((x) => x.status === "approved");
  if (!f) return h("p", { class: "muted" }, "Answers appear here once the framework is approved.");
  const ref = d.companies.find((c) => c.role === "reference");
  const refRows = d.baseline?.snapshot.assessments ?? ref.assessments;
  const competitors = d.companies.filter((c) => c.role === "competitor");
  return [
    h("p", { class: "small muted" },
      d.baseline ? `Baseline frozen ${new Date(d.baseline.created_at).toLocaleString()} · ${d.baseline.snapshot.gaps.length} gaps · verification: ${d.baseline.snapshot.verification}` : "Baseline not frozen yet; reference answers may still change."),
    h("div", { class: "table-wrap" },
      h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Criterion"), h("th", {}, `${ref.name} (reference)`), competitors.map((c) => h("th", {}, c.name)))),
        h("tbody", {},
          f.criteria.map((cr) =>
            h("tr", {},
              h("td", {}, h("strong", {}, cr.label), h("div", { class: "small muted" }, cr.definition)),
              cell(refRows.find((a) => a.criterion_id === cr.id)),
              competitors.map((c) => cell(c.assessments.find((a) => a.criterion_id === cr.id)))))))),
  ];
}

function evidence(d) {
  const company = d.companies.find((c) => c.id === state.companyId) ?? d.companies[0];
  const f = d.frameworks.find((x) => x.status === "approved") ?? d.frameworks[0];
  const items = company.evidence.filter((e) => !state.criterion || e.criterion_ids.includes(state.criterion));
  return [
    h("div", { class: "row mt" },
      d.companies.map((c) => h("button", { "aria-pressed": c.id === company.id, class: c.id === company.id ? "primary" : "", onclick: () => { state.companyId = c.id; render(); } }, c.name)),
      f && h("select", { "aria-label": "Filter by criterion", onchange: (e) => { state.criterion = e.target.value; render(); } },
        h("option", { value: "" }, "All criteria"),
        f.criteria.map((c) => h("option", { value: c.id, selected: state.criterion === c.id }, c.label)))),
    h("h2", {}, `Evidence (${items.length})`),
    h("div", { class: "list" },
      items.map((e) =>
        h("div", {},
          h("div", { class: "row" }, h("button", { class: "cite", onclick: () => showEvidence(e.id) }, e.id), h("strong", {}, e.claim)),
          h("blockquote", { class: "small" }, e.excerpt),
          h("div", { class: "small muted" }, `${e.publisher} · ${e.title} · ${label(e.attribution)} · ${e.criterion_ids.join(", ")}`)))),
    h("h2", {}, `Sources (${company.sources.length})`),
    h("div", { class: "table-wrap" },
      h("table", {},
        h("thead", {}, h("tr", {}, ["Id", "Source", "Type", "Captured"].map((t) => h("th", {}, t)))),
        h("tbody", {},
          company.sources.map((s) =>
            h("tr", {},
              h("td", {}, s.id),
              h("td", {}, safeUrl(s.url) ? h("a", { href: safeUrl(s.url), target: "_blank", rel: "noopener noreferrer" }, s.title) : s.title, h("div", { class: "small muted" }, s.publisher)),
              h("td", {}, label(s.type)),
              h("td", { class: "small" }, `${Math.round(s.chars / 1000)}k chars · ${new Date(s.retrieved_at).toLocaleDateString()}`)))))),
  ];
}

// The framework-based comparison for one competitor: one row per frozen
// criterion, reference answer beside the competitor's, with the rule for
// comparing them.
function sideBySide(d, c) {
  const f = d.baseline?.snapshot.framework;
  if (!f) return h("p", { class: "muted" }, "Freeze the baseline to compare against the framework.");
  const ref = d.baseline.snapshot;
  return h("div", { class: "table-wrap" },
    h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Criterion"), h("th", {}, `${ref.company.name} (baseline)`), h("th", {}, c.name), h("th", {}, "Summary"))),
      h("tbody", {},
        f.criteria.map((cr) =>
          h("tr", {},
            h("td", {}, h("strong", {}, cr.label), " ", badge(cr.importance === "essential" ? "in_progress" : "chip", cr.importance),
              h("div", { class: "small muted" }, cr.definition),
              h("div", { class: "small" }, h("em", {}, "How to compare: "), cr.comparison_rule)),
            cell(ref.assessments.find((a) => a.criterion_id === cr.id)),
            cell(c.assessments.find((a) => a.criterion_id === cr.id)),
            summaryCell(c, cr.id, ref.assessments.find((a) => a.criterion_id === cr.id), c.assessments.find((a) => a.criterion_id === cr.id), ref.company.name))))));
}

// Mirrors criterionSummary in the server's report export.
function summaryCell(c, id, refA, compA, refName) {
  const x = (c.narrative?.body.criterion_comparisons ?? []).find((s) => s.criterion_id === id);
  if (x) return h("td", { class: "summary" }, x.text, " ", cites(x.evidence_ids));
  if (refA?.status === "unknown" && compA?.status === "unknown")
    return h("td", { class: "summary muted" }, `Unknown for both (${refName}: ${label(refA.unknown_reason)}; ${c.name}: ${label(compA.unknown_reason)}).`);
  return h("td", { class: "muted" }, "—");
}

function reports(d) {
  const competitors = d.companies.filter((c) => c.role === "competitor");
  if (!competitors.length) return h("p", { class: "muted" }, "No competitor yet.");
  return competitors.map((c) => {
    const n = c.narrative;
    const report = d.reports.find((r) => r.company_id === c.id);
    const download = async () => {
      const text = await api(`reports/${report.id}/markdown`);
      const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/markdown" })), download: `${d.project.name} - ${c.name}.md` });
      a.click();
      URL.revokeObjectURL(a.href);
    };
    return h("section", {},
      h("div", { class: "row" }, h("h2", {}, `${d.baseline?.snapshot.company.name ?? "Reference"} vs ${c.name}`), n && badge(n.gate, n.gate === "passed_vendor" ? "vendor-documented" : undefined), report && badge("done", "report saved"),
        report && h("button", { onclick: download }, "Download markdown")),
      !n ? h("p", { class: "muted" }, "Narrative not written yet.") : [
        n.gate_notes.length > 0 && h("ul", { class: "notes" }, n.gate_notes.map((x) => h("li", {}, x))),
        h("h3", {}, "Summary"), h("ul", {}, n.body.summary.map((s) => h("li", {}, s.text, " ", cites(s.evidence_ids)))),
        n.body.tradeoffs.length > 0 && [h("h3", {}, "Trade-offs"), h("ul", {}, n.body.tradeoffs.map((s) => h("li", {}, s.text, " ", cites(s.evidence_ids))))],
        h("h3", {}, "Side-by-side by criterion"), sideBySide(d, c),
        n.body.buyer_questions.length > 0 && [h("h3", {}, "Buyer questions"), n.body.buyer_questions.map((q) => h("p", {}, h("strong", {}, q.question), h("br"), q.answer, " ", cites(q.evidence_ids)))],
        n.body.limitations.length > 0 && [h("h3", {}, "Limitations"), h("ul", {}, n.body.limitations.map((l) => h("li", {}, l)))],
      ]);
  });
}

function claims(d) {
  const rows = d.companies.flatMap((c) => c.claim_reviews.map((r) => ({ ...r, company: c.name })));
  if (!rows.length) return h("p", { class: "muted" }, "The fact gate has not run yet.");
  const order = { false: 0, unknown: 1, unchecked: 2, true: 3 };
  rows.sort((a, b) => order[a.verdict] - order[b.verdict]);
  return h("div", { class: "table-wrap" },
    h("table", {},
      h("thead", {}, h("tr", {}, ["Verdict", "Checked as", "Company", "Where", "Claim", "Evidence"].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows.map((r) =>
        h("tr", {},
          h("td", {}, badge(r.verdict), r.confidence != null && h("div", { class: "small muted" }, r.confidence.toFixed(2))),
          h("td", { class: "small" }, r.basis === "vendor" ? "vendor-documented" : "independent fact"),
          h("td", {}, r.company), h("td", { class: "small" }, r.target), h("td", {}, r.text), h("td", {}, cites(r.evidence_ids)))))));
}

const TABS = { overview: ["Overview", overview], framework: ["Framework", framework], comparison: ["Side-by-side", comparison], evidence: ["Evidence", evidence], claims: ["Fact checks", claims], reports: ["Report", reports] };
function setTab(t) {
  state.tab = t;
  store.set("comp-tab", t);
  render();
}

function render() {
  fill(nav, 
    h("div", { class: "small muted navlabel" }, "Projects"),
    state.projects.length ? state.projects.map((p) =>
      h("button", { "aria-current": p.id === state.projectId, onclick: () => selectProject(p.id) }, p.name, h("div", { class: "small muted" }, p.reference)))
      : h("p", { class: "small muted" }, "No projects. Ask Claude: /compare-anything:research"));
  const d = state.detail;
  if (!d) return;
  const [, view] = TABS[state.tab] ?? TABS.overview;
  fill(main, 
    h("h1", {}, d.project.name),
    h("div", { class: "muted small" }, `For ${d.project.buyer} · ${d.project.scope} · ${d.project.region}`),
    stepsView(d),
    h("div", { class: "tabs", role: "tablist" },
      Object.entries(TABS).map(([k, [name]]) => h("button", { role: "tab", "aria-selected": k === state.tab, onclick: () => setTab(k) }, name))),
    view(d));
}

async function selectProject(id) {
  state.projectId = id;
  state.companyId = null;
  store.set("comp-project", id);
  await refresh();
}
async function refresh() {
  if (!token) {
    fill(main, h("p", {}, "Open this page with the link from Claude (/compare-anything:ui) to sign in."));
    return;
  }
  try {
    state.projects = await api("projects");
    if (!state.projects.some((p) => p.id === state.projectId)) state.projectId = state.projects[0]?.id;
    state.detail = state.projectId ? await api(`projects/${state.projectId}`) : null;
    if (!state.detail) fill(main, h("p", { class: "muted" }, "No projects yet. In Claude Code, run /compare-anything:research <company or product>."));
    render();
  } catch (e) {
    fill(main, h("p", {}, `Could not load: ${e.message}`));
  }
}
refresh();
// Skip refreshes while a drawer is open or a field has focus.
setInterval(() => {
  const typing = ["INPUT", "SELECT"].includes(document.activeElement?.tagName);
  if (document.visibilityState === "visible" && drawer.hidden && !typing) refresh();
}, 4000);
