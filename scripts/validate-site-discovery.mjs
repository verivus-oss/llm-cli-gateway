#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = join(repoRoot, "site");

const baseArg = process.argv.find(arg => arg.startsWith("--base-url="));
const mode = baseArg ? "remote" : "local";
const baseUrl = baseArg?.slice("--base-url=".length).replace(/\/+$/, "");

const routes = [
  {
    path: "/.well-known/agent.json",
    type: "application/json",
    json: true,
    required: ["name", "description", "url", "repository", "mcp", "retrieval"],
  },
  {
    path: "/agent.json",
    type: "application/json",
    json: true,
    required: ["name", "description", "url", "repository", "mcp", "retrieval"],
    equivalentTo: "/.well-known/agent.json",
  },
  {
    path: "/.well-known/mcp/server-card.json",
    type: "application/json",
    json: true,
    required: ["name", "description", "repository", "documentation", "packages", "remotes"],
  },
  {
    path: "/.well-known/mcp.json",
    type: "application/json",
    json: true,
    required: ["name", "description", "repository", "documentation", "packages", "remotes"],
    equivalentTo: "/.well-known/mcp/server-card.json",
  },
  {
    path: "/.well-known/api-catalog",
    type: "application/linkset+json",
    json: true,
    required: ["linkset"],
  },
  {
    path: "/.well-known/ai-catalog.json",
    type: "application/json",
    json: true,
    required: ["linkset"],
    equivalentTo: "/.well-known/api-catalog",
  },
  {
    path: "/.well-known/integrations.json",
    type: "application/json",
    json: true,
    required: ["version", "surfaces"],
  },
  { path: "/llms.txt", type: "text/plain" },
  { path: "/docs", type: "text/html" },
  { path: "/api", type: "text/html" },
  { path: "/developers", type: "text/html" },
  { path: "/about", type: "text/html" },
  { path: "/contact", type: "text/html" },
  { path: "/privacy", type: "text/html" },
  { path: "/openapi.json", type: "application/vnd.oai.openapi+json", json: true, required: ["openapi", "info", "paths"] },
  { path: "/install.md", type: "text/markdown" },
  { path: "/agents.md", type: "text/markdown" },
  { path: "/tools.md", type: "text/markdown" },
  { path: "/guides/coding-agent-gateway-technical-guide.md", type: "text/markdown" },
  { path: "/workflows/cross-model-review.md", type: "text/markdown" },
  { path: "/DISCOVERY.md", type: "text/markdown" },
  { path: "/sitemap.md", type: "text/markdown" },
  { path: "/sitemap.xml", type: "application/xml" },
];

function fail(message) {
  throw new Error(message);
}

function fileForPath(path) {
  const rel = path === "/" ? "index.html" : path.replace(/^\//, "");
  return join(siteDir, rel);
}

function isHtmlHomepage(body) {
  return (
    /<!doctype html>|<html[\s>]/i.test(body) &&
    /<link rel="canonical" href="https:\/\/llm-cli-gateway\.dev\/" \/>|class="[^"]*hp-hero-main/i.test(
      body
    )
  );
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function parseJson(route, body) {
  try {
    return JSON.parse(body);
  } catch (error) {
    fail(`${route.path} is not valid JSON: ${error.message}`);
  }
}

function assertRequired(route, value) {
  if (!route.required) return;
  for (const key of route.required) {
    if (!(key in value)) {
      fail(`${route.path} missing required key "${key}"`);
    }
  }
}

async function readLocal(route) {
  const path = fileForPath(route.path);
  if (!existsSync(path)) fail(`${route.path} missing local file ${path}`);
  return {
    status: 200,
    contentType: route.type,
    body: readFileSync(path, "utf8"),
    finalUrl: route.path,
  };
}

async function readRemote(route) {
  const response = await fetch(`${baseUrl}${route.path}`, { redirect: "follow" });
  const body = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    cacheControl: response.headers.get("cache-control") ?? "",
    body,
    finalUrl: response.url,
  };
}

async function readRoute(route) {
  return mode === "remote" ? readRemote(route) : readLocal(route);
}

function extractCatalogLinks(catalog) {
  const links = [];
  for (const linkset of catalog.linkset ?? []) {
    for (const [rel, values] of Object.entries(linkset)) {
      if (rel === "anchor") continue;
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (typeof value?.href === "string") links.push(value.href);
      }
    }
  }
  return links;
}

function extractMarkdownLinks(body) {
  const cleanUrl = url => url.replace(/[>)\].,;:]+$/, "");
  const links = [];
  for (const match of body.matchAll(/\[[^\]]+\]\((https:\/\/llm-cli-gateway\.dev\/[^)]+)\)/g)) {
    links.push(cleanUrl(match[1]));
  }
  for (const match of body.matchAll(/https:\/\/llm-cli-gateway\.dev\/[^\s`]+/g)) {
    links.push(cleanUrl(match[0]));
  }
  return [...new Set(links)];
}

async function assertInternalLink(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== "llm-cli-gateway.dev") return;
  const route = { path: parsed.pathname, type: "", json: false };
  const result =
    mode === "remote"
      ? await readRemote(route)
      : existsSync(fileForPath(parsed.pathname))
        ? await readLocal({ ...route, type: "" })
        : { status: 404, body: "", contentType: "" };
  if (result.status < 200 || result.status >= 300) {
    fail(`${url} referenced by site metadata returned ${result.status}`);
  }
  if (isHtmlHomepage(result.body) && !parsed.pathname.endsWith("/") && parsed.pathname !== "/") {
    fail(`${url} resolved to homepage HTML`);
  }
}

async function main() {
  const bodies = new Map();
  for (const route of routes) {
    const result = await readRoute(route);
    if (result.status < 200 || result.status >= 300) {
      fail(`${route.path} returned ${result.status}`);
    }
    if (route.type && !result.contentType.toLowerCase().startsWith(route.type)) {
      fail(`${route.path} content-type "${result.contentType}" does not start with "${route.type}"`);
    }
    if (isHtmlHomepage(result.body) && route.path !== "/") {
      fail(`${route.path} returned homepage HTML`);
    }
    if (route.json) {
      const value = parseJson(route, result.body);
      assertRequired(route, value);
      if (route.path.includes("catalog")) {
        for (const href of extractCatalogLinks(value)) {
          await assertInternalLink(href);
        }
      }
    } else if (route.path.endsWith(".md") || route.path.endsWith(".txt")) {
      for (const href of extractMarkdownLinks(result.body)) {
        await assertInternalLink(href);
      }
    }
    bodies.set(route.path, result.body);
  }

  for (const route of routes.filter(r => r.equivalentTo)) {
    const source = bodies.get(route.equivalentTo);
    const alias = bodies.get(route.path);
    if (mode === "local") {
      if (alias !== source) {
        fail(
          `${route.path} is not byte-equivalent to ${route.equivalentTo} (${sha256(alias)} != ${sha256(source)})`
        );
      }
    } else {
      const sourceJson = JSON.stringify(JSON.parse(source));
      const aliasJson = JSON.stringify(JSON.parse(alias));
      if (aliasJson !== sourceJson) {
        fail(`${route.path} is not content-equivalent to ${route.equivalentTo}`);
      }
    }
  }

  const unknown =
    mode === "remote"
      ? await readRemote({ path: "/definitely-not-a-real-llm-cli-gateway-page", type: "" })
      : existsSync(join(siteDir, "404.html"))
        ? { status: 404, body: readFileSync(join(siteDir, "404.html"), "utf8") }
        : { status: 200, body: "" };
  if (unknown.status !== 404) {
    fail(`unknown path returned ${unknown.status}, expected 404`);
  }
  if (isHtmlHomepage(unknown.body)) {
    fail("unknown path returned homepage HTML");
  }

  process.stdout.write(`site discovery validation passed (${mode}${baseUrl ? ` ${baseUrl}` : ""})\n`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
