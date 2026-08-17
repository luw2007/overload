#!/usr/bin/env bun
// PROTOTYPE — throwaway static server for the dashboard + Island mockups.
// Answers UI questions only; not part of the real web/server.ts design.
// Run: bun src/web/prototype/serve-prototype.ts
import { join } from "node:path";

const port = 4871;
const dashboard = Bun.file(join(import.meta.dir, "PROTOTYPE-dashboard.html"));
const island = Bun.file(join(import.meta.dir, "PROTOTYPE-island.html"));

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const body = path === "/island" ? island : dashboard;
    return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

console.log(`prototype dashboard: http://127.0.0.1:${port}/?variant=a  (also ?variant=b / ?variant=c)`);
console.log(`prototype island:    http://127.0.0.1:${port}/island?variant=a  (also ?variant=b / ?variant=c)`);
