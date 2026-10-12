# Compare Anything by GrowthCast

A Claude Code plugin for evidence-backed comparisons of companies and products. Claude does the research and the writing; the
plugin stores every source and quote, enforces four gated steps, and has Jev (TypeSafe's fact model) check every factual
sentence against the verbatim excerpts it cites. It comes with a local review UI.

## Install
```
/plugin marketplace add ejwhite7/compare-anything
/plugin install compare-anything@growthcast
/compare-anything:ui
```
Restart Claude Code (or reconnect the server in `/mcp`) after installing. Needs Node 22.13+ (built-in `node:sqlite`) and has
no npm dependencies.

## The four steps
| Step | What happens | Gate |
|---|---|---|
| **1 · Research** | Claude finds sources and captures them with `page_fetch`, which honours robots.txt and permanently excludes domains that refuse crawling. Claude records quotes and proposes buyer-relevant criteria. | Every excerpt must appear verbatim in the captured page. |
| **2 · Approve framework** | You review the criteria, each with a definition, the evidence that would answer it and a fair comparison rule. | Only you can approve: in the UI, or by telling Claude explicitly. |
| **3 · Freeze baseline** | Claude answers every criterion for the reference company. | Every factual sentence passes Jev or is revised or marked unknown. Unknowns are kept as named gaps. The baseline is immutable. |
| **4 · Compare & review** | Each competitor is assessed against the frozen criteria; Claude writes a summary, trade-offs, buyer questions, limitations and a one-line comparison per criterion. | Same fact gate, plus a comparison for every criterion that isn't unknown for both. |

## How claims are checked
- Each answer is checked in its own Jev request; three readings are averaged and a claim passes at a mean probability of 0.8.
- Claims whose quotes all come from the compared companies' own websites are checked as **vendor-documented** ("does the
  company document this?") and labelled that way everywhere. Claims citing independent sources are checked as facts.
- A vendor's promise (a timeline, a guarantee) cannot establish itself; such answers are recorded as unknown.

## The review UI
Runs on `127.0.0.1` (port 4317 or the next free one) while Claude Code is open. Open it with `/compare-anything:ui`; the link
carries an access token stored in your data directory.

| Tab | What it shows |
|---|---|
| **Overview** | Step status, companies, activity |
| **Framework** | Criteria, versions, and the **Approve framework** button |
| **Side-by-side** | Every criterion across the baseline and all competitors, with status, check type and citations |
| **Evidence** | Sources and verbatim quotes per company, filterable by criterion |
| **Fact checks** | Every Jev verdict, failures first |
| **Report** | Summary, trade-offs, side-by-side table with a summary column, buyer questions, limitations; Markdown download |

Click any citation (E12) to see the exact quote and its source.

## Commands
| Command | Step |
|---|---|
| `/compare-anything:research <company or product> [who it's for]` | 1: research and propose a framework |
| `/compare-anything:approve` | 2: review the framework (you approve) |
| `/compare-anything:baseline` | 3: assess, pass the gates, freeze |
| `/compare-anything:compare <competitor>` | 4: compare, write, report |
| `/compare-anything:status` | Where each project stands |
| `/compare-anything:ui` | Link to the review UI |

## Configure
The fact gate runs Jev through OpenRouter. Put the key in the environment Claude Code starts from, or in
`~/.compare-anything/.env`:
```
OPENROUTER_API_KEY=sk-or-...
```
| Setting | Default | Meaning |
|---|---|---|
| `COMPARE_ANYTHING_DATA` | `~/.compare-anything` | Database, UI token and `.env` |
| `COMPARE_ANYTHING_PORT` | `4317` | First port tried for the UI |
| `COMPARE_ANYTHING_JEV_MODEL` | `typesafe/jev-1.13` | Fact-check model |
| `COMPARE_ANYTHING_JEV_SAMPLES` | `3` | Jev readings averaged per request |
| `COMPARE_ANYTHING_JEV` | — | `off` records results as unverified (labelled in every report) |

Jev checks cost about $0.0001 per claim. Projects from the pre-release `comp-engine` build (`~/.comp-engine`) are used
automatically, and `COMP_ENGINE_*` settings still work.

## Develop
```
npm test
```

MIT © GrowthCast
