#!/usr/bin/env node
// Plugin entry point: the MCP server on stdio plus the local web UI.
import { open, loadEnvFile } from "./store.mjs";
import { serveStdio } from "./mcp.mjs";
import { setUiUrl } from "./tools.mjs";
import { startWeb } from "./web.mjs";
import { APP } from "./config.mjs";

loadEnvFile();
open();
let url = "Starting…";
setUiUrl(() => url);
startWeb()
  .then((web) => {
    url = web.url;
    console.error(`${APP.name} web UI: ${url.split("#")[0]}`);
  })
  .catch((e) => {
    url = `Web UI unavailable: ${e.message}`;
    console.error(url);
  });
serveStdio();
