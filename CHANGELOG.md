# Changelog

## 1.0.0
First release as **Compare Anything by GrowthCast**.
- Four gated steps: research, approve framework (human gate), freeze baseline, compare and review.
- `page_fetch` captures pages itself, honours robots.txt and permanently excludes domains that refuse crawling; every excerpt must appear verbatim in the captured page.
- Jev fact gate: one request per answer, three readings averaged, pass at a mean probability of 0.8. Claims backed only by the companies' own websites are checked as "vendor-documented" and labelled that way; independent sources are checked as facts.
- Reports with a side-by-side table per criterion, a fact-checked summary column, trade-offs, buyer questions and limitations; Markdown export.
- Local review UI in the GrowthCast visual system (light and dark).
- Projects from the pre-release `comp-engine` build in `~/.comp-engine` are picked up automatically; `COMP_ENGINE_*` settings still work.
