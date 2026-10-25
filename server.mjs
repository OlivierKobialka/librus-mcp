#!/usr/bin/env node
// Lokalny serwer MCP (stdio) dla Claude Code i Claude Desktop.
//   node server.mjs           serwer MCP
//   node server.mjs --test    szybki test w terminalu
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./src/tools.mjs";

if (process.argv.includes("--test")) {
  const { runTest } = await import("./src/report.mjs");
  await runTest();
} else {
  await createServer().connect(new StdioServerTransport());
}
