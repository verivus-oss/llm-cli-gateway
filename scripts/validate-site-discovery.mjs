#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoPublicInternalMcpAliases } from "./public-site-mcp-policy.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const siteArg = process.argv.find(arg => arg.startsWith("--site-dir="));
const siteDir = siteArg ? resolve(siteArg.slice("--site-dir=".length)) : join(repoRoot, "site");

// Strip a trailing run of any character in `chars` with a linear backward scan.
// A `[chars]+$` regex backtracks quadratically on a long run followed by a
// non-member ("...////x"); this cannot.
function stripTrailingChars(value, chars) {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1])) end--;
  return value.slice(0, end);
}

const baseArg = process.argv.find(arg => arg.startsWith("--base-url="));
const mode = baseArg ? "remote" : "local";
const baseUrl = baseArg ? stripTrailingChars(baseArg.slice("--base-url=".length), "/") : undefined;

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
  {
    path: "/tools.fixture.json",
    type: "application/json",
    json: true,
    required: ["siteVersion", "toolCount", "tools"],
  },
  { path: "/llms.txt", type: "text/plain" },
  { path: "/docs", type: "text/html" },
  { path: "/api", type: "text/html" },
  { path: "/developers", type: "text/html" },
  { path: "/about", type: "text/html" },
  { path: "/contact", type: "text/html" },
  { path: "/privacy", type: "text/html" },
  {
    path: "/openapi.json",
    type: "application/vnd.oai.openapi+json",
    json: true,
    required: ["openapi", "info", "paths"],
  },
  { path: "/install.md", type: "text/markdown" },
  { path: "/agents.md", type: "text/markdown" },
  { path: "/tools.md", type: "text/markdown" },
  { path: "/guides/coding-agent-gateway-technical-guide.md", type: "text/markdown" },
  { path: "/guides/personal-agent-config-kit.md", type: "text/markdown" },
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

function headerPatternMatches(pattern, routePath) {
  // Collapse consecutive `*` to one first: otherwise "***" becomes ".*.*.*",
  // which backtracks catastrophically against a non-matching path.
  const escaped = pattern
    .replace(/\*+/g, "*")
    .split("*")
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(routePath);
}

function parseHeadersFile(body) {
  const rules = [];
  let current = null;
  for (const rawLine of body.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(rawLine)) {
      current = { pattern: rawLine.trim(), headers: new Map() };
      rules.push(current);
      continue;
    }
    if (!current) fail("site/_headers contains a header before any route pattern");
    const header = rawLine.trim();
    const separator = header.indexOf(":");
    if (separator <= 0) fail(`site/_headers contains an invalid header line: ${header}`);
    current.headers.set(
      header.slice(0, separator).trim().toLowerCase(),
      header.slice(separator + 1).trim()
    );
  }
  return rules;
}

function defaultStaticContentType(path) {
  return (
    new Map([
      [".html", "text/html; charset=utf-8"],
      [".json", "application/json; charset=utf-8"],
      [".md", "text/markdown; charset=utf-8"],
      [".txt", "text/plain; charset=utf-8"],
      [".xml", "application/xml; charset=utf-8"],
    ]).get(extname(path).toLowerCase()) ?? "application/octet-stream"
  );
}

function localContentType(routePath, filePath) {
  const headersPath = join(siteDir, "_headers");
  if (!existsSync(headersPath)) fail(`site/_headers missing local file ${headersPath}`);
  let contentType = defaultStaticContentType(filePath);
  for (const rule of parseHeadersFile(readFileSync(headersPath, "utf8"))) {
    if (!headerPatternMatches(rule.pattern, routePath)) continue;
    const declared = rule.headers.get("content-type");
    if (declared) contentType = declared;
  }
  return contentType;
}

async function readLocal(route) {
  const path = fileForPath(route.path);
  // A path that is absent, or that resolves to a directory (e.g. a
  // trailing-slash self-link like /guides/), is not a servable page here.
  // Treating it as 404 keeps a directory-resolving link a clean validation
  // failure instead of an uncaught EISDIR from readFileSync.
  if (!existsSync(path) || statSync(path).isDirectory()) {
    return { status: 404, contentType: "", body: "", finalUrl: route.path };
  }
  let body;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return { status: 404, contentType: "", body: "", finalUrl: route.path };
  }
  return {
    status: 200,
    contentType: localContentType(route.path, path),
    body,
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
  const cleanUrl = url => stripTrailingChars(url, ">)].,;:");
  const links = [];
  // The link text run is bounded ({1,1000}, far longer than any real link text)
  // so a run of unmatched `[` cannot make `[^\]]+` scan to EOF from every bracket
  // and go quadratic on attacker-controlled markdown.
  for (const match of body.matchAll(
    /\[[^\]]{1,1000}\]\((https:\/\/llm-cli-gateway\.dev\/[^)]{1,2000})\)/g
  )) {
    links.push(cleanUrl(match[1]));
  }
  for (const match of body.matchAll(/https:\/\/llm-cli-gateway\.dev\/[^\s`]+/g)) {
    links.push(cleanUrl(match[0]));
  }
  return [...new Set(links)];
}

// A quote/bracket/JSON-safe self-link extractor for the repo-wide sweep, which
// reads Markdown, HTML, and JSON alike. Stops at whitespace and any delimiter
// that can close a URL in those formats, then trims trailing prose punctuation.
function extractSelfLinks(body) {
  const links = new Set();
  // The URL run stops at `)` deliberately, matching both GFM inline-link syntax
  // (`[text](url)`, where `)` closes the link) and GFM autolink boundaries; a
  // literal parenthesis inside a real URL path must be percent-encoded (%28/%29)
  // and so is not truncated. Extending the class to accept `)` would over-consume
  // the closing paren of every Markdown link.
  for (const match of body.matchAll(/https:\/\/llm-cli-gateway\.dev\/[^\s"'`)<>\]}]*/g)) {
    const cleaned = stripTrailingChars(match[0], ".,;:>)]}");
    links.add(cleaned);
  }
  return links;
}

// Heading slug for Markdown fragment validation. Approximates github-slugger
// without a Markdown-parser dependency: link syntax contributes only its visible
// text, inline code and emphasis markers (backtick, asterisk, tilde) are
// dropped, and Unicode letters/numbers plus underscores survive. Underscores are
// KEPT (github-slugger keeps connector punctuation); this repo's headings use
// identifier names like `codex_request`, so stripping `_` would reject a valid
// fragment. Input is capped so the link regexes stay linear on a pathological
// heading. Known approximations vs a full GFM parser: nested-bracket link text
// (`[a [b]]`) and underscore-emphasis headings (`_x_`) are not special-cased,
// and hyphen runs are collapsed. Duplicate disambiguation is handled by the
// caller so it sees the whole document.
function slugifyHeading(text) {
  return (
    text
      .slice(0, 256)
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
      .replace(/[`*~]/g, "")
      // ALL underscores are kept: this repo's headings are code-span identifiers
      // (`output_`, `codex_request`) whose underscores GitHub renders literally.
      // Dropping word-boundary underscores to special-case emphasis headings
      // (`_Setup_`) would wrongly strip a code-span identifier's trailing `_`, so
      // emphasis-underscore headings stay a documented approximation (below).
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_ -]/gu, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
  );
}

// Strip GFM FENCED code blocks so a line that looks like a heading (or an
// explicit anchor) inside one cannot mint a spurious anchor. A block opens on a
// line of three or more backticks or tildes, indented at most three spaces (GFM's
// top-level fence indent), and closes on a later line of the SAME character, at
// least as long, carrying no info string; an unclosed fence runs to the end of
// the document. A length comparison cannot be a backreference, so this scans
// lines.
//
// Bounded scope (best-effort fragment layer, atop lychee and the repo-wide
// self-link sweep): INDENTED code blocks and fenced/heading examples nested
// inside a list item or block-quote are NOT stripped. Distinguishing indented
// code from live list-item content requires tracking each open container's
// content-indent column, i.e. a real CommonMark block parser, which this repo
// deliberately omits (see slugifyHeading). A previous line-scanner attempt was
// wrong in both directions: it dropped live list-paragraph anchors (a false CI
// failure, the worse fault) while still mishandling Setext/table/link-reference
// boundaries. So a `#fragment` that resolves ONLY to an anchor defined inside
// indented or container-nested code may over-resolve. No such construct exists
// in this repo's tracked docs (verified), and this fails OPEN, never closed.
function stripFencedBlocks(body) {
  const kept = [];
  let fence = null;
  // Split on CRLF or LF, so a Windows-authored file's fence close (```\r\n) is
  // recognised. A trailing \r would otherwise defeat the `[ \t]*$` close anchor,
  // leaving the fence open to EOF and hiding every heading after it.
  for (const line of body.split(/\r?\n/)) {
    if (fence) {
      // A close is a run of ONE character type, at least as long as the opener,
      // with no trailing content. Matching a single type (not [`~]) stops a
      // mixed run like ```~ from closing a backtick block.
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      // A backtick fence's info string may not contain a backtick (GFM), so a
      // line like ```lang`x is not a fence open and must not swallow the rest of
      // the document to EOF. Tilde fences carry no such restriction.
      if (open[1][0] === "`" && open[2].includes("`")) {
        kept.push(line);
        continue;
      }
      fence = { char: open[1][0], length: open[1].length };
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function markdownAnchors(body) {
  const anchors = new Set();
  const withoutFences = stripFencedBlocks(body);
  // GitHub disambiguates repeated heading slugs with -1, -2, ... in document
  // order, and reserves each emitted slug so a literal "Setup 1" heading and the
  // auto-generated "setup-1" cannot collide. Mirror that occurrence loop.
  const used = new Map();
  const reserve = base => {
    if (!base) return;
    let candidate = base;
    let n = used.get(base) ?? 0;
    while (anchors.has(candidate)) {
      n += 1;
      candidate = `${base}-${n}`;
    }
    used.set(base, n);
    anchors.add(candidate);
  };
  // One document-ordered pass over the fence-stripped lines so ATX and Setext
  // headings interleave correctly for the disambiguation counter.
  const lines = withoutFences.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    // Capture the heading text greedily to `$` (linear), then strip an optional
    // GFM closing hash sequence (a trailing run of `#` preceded by whitespace)
    // with a backward scan. A regex `[ \t]+#+[ \t]*$` here would backtrack
    // quadratically on a space-heavy line ("# a" + " ".repeat(N) + "x").
    const atx = /^ {0,3}#{1,6}[ \t]+(.*)$/.exec(lines[idx]);
    if (atx) {
      let text = atx[1].trimEnd();
      let hashEnd = text.length;
      while (hashEnd > 0 && text[hashEnd - 1] === "#") hashEnd--;
      if (hashEnd < text.length && hashEnd > 0 && /[ \t]/.test(text[hashEnd - 1])) {
        text = text.slice(0, hashEnd).trimEnd();
      }
      reserve(slugifyHeading(text));
      continue;
    }
    // Setext heading: a line of only `=` (h1) or only `-` (h2) directly under a
    // paragraph. GFM lets the paragraph span multiple lines, and the heading text
    // is ALL of them joined, so gather every consecutive preceding content line.
    // A line that is an ATX heading, another underline, a list item, or a
    // blockquote is not paragraph content and stops the gather. A `---` under a
    // blank line (no content above) is a thematic break, not a heading. Bounded
    // scope (as with fences): a Setext heading nested INSIDE a list item or
    // blockquote is not recognised, which this repo's docs do not use.
    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(lines[idx]);
    if (setext && idx > 0) {
      const isContent = line =>
        line.trim() &&
        !/^ {0,3}#/.test(line) &&
        !/^ {0,3}(=+|-+)[ \t]*$/.test(line) &&
        !/^ {0,3}([-+*]|\d+[.)])[ \t]/.test(line) &&
        !/^ {0,3}>/.test(line);
      // Walk back to the paragraph start, then slice+join once. Building the
      // array with unshift would be O(n^2) on a pathological run of content
      // lines; scanning an index and slicing is linear.
      let back = idx - 1;
      while (back >= 0 && isContent(lines[back])) back--;
      const paragraphStart = back + 1;
      if (paragraphStart < idx) {
        const heading = lines
          .slice(paragraphStart, idx)
          .map(line => line.trim())
          .join(" ");
        reserve(slugifyHeading(heading));
      }
    }
  }
  // Explicit anchors survive the slugger: inline HTML ids and {#custom-id}. Read
  // from the fence-stripped body so an `<a id>` or `{#id}` written as an example
  // INSIDE a fenced code block does not mint a live anchor (a fragment pointing
  // at documentation-only markup would otherwise resolve). The attribute span is
  // bounded ({0,1000}, far longer than any real tag) so a malformed run of `<a `
  // prefixes with no closing `>` cannot scan to EOF from each position and go
  // quadratic on attacker-controlled markdown.
  for (const match of withoutFences.matchAll(/<a\b[^>]{0,1000}\b(?:id|name)=["']([^"']+)["']/gi)) {
    anchors.add(match[1]);
  }
  for (const match of withoutFences.matchAll(/\{#([A-Za-z0-9_-]+)\}/g)) {
    anchors.add(match[1]);
  }
  return anchors;
}

// Binary payloads never carry a text self-link; skipping them keeps the sweep
// from decoding fonts and images as UTF-8. SVG is deliberately absent: it is
// XML and can carry clickable href self-links, so it must be swept as text.
const SWEEP_BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".wasm",
  ".mp4",
  ".webm",
]);

// Directories the link-rot scan treats as historical evidence. Mirrors the
// docs/archive and docs/reviews entries in lychee.toml exclude_path so the
// sweep and lychee agree on scope; a dead self-link in an archived artefact is
// evidence, not a bug.
const SWEEP_EXCLUDE_DIRS = new Set(["archive", "reviews"]);

function* walkTextFiles(dir, excludeTopLevelDirs = new Set()) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // Do not silently prune an unreadable directory: the sweep is the only thing
    // resolving these self-links, so a swallowed error is a fail-open hole.
    fail(`unable to read directory ${dir} for the self-link sweep: ${error.message}`);
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (excludeTopLevelDirs.has(entry.name)) continue;
      yield* walkTextFiles(full);
    } else if (entry.isFile()) {
      if (SWEEP_BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      yield full;
    }
  }
}

function assertCodexPromptTransportContract(bodies) {
  const required = new Map([
    [
      "/llms.txt",
      [
        "Codex new and resume prompts use stdin.",
        "`codex_fork_session` remains argv-bound",
        "non-retryable `input_too_large`",
      ],
    ],
    [
      "/agents.md",
      [
        "Codex new and resume prompts use stdin.",
        "`codex_fork_session` remains argv-bound",
        "non-retryable `input_too_large`",
      ],
    ],
    ["/tools.md", ["`codex_fork_session`", "prompt remains argv-bound", "input_too_large"]],
  ]);

  for (const [path, fragments] of required) {
    const body = bodies.get(path);
    if (typeof body !== "string") fail(`${path} is unavailable for prompt transport validation`);
    const normalized = body.replace(/\s+/g, " ");
    for (const fragment of fragments) {
      if (!normalized.includes(fragment)) {
        fail(`${path} is missing the Codex prompt transport contract fragment: ${fragment}`);
      }
    }
    if (/\bCodex prompts use stdin\b/.test(normalized)) {
      fail(`${path} overgeneralizes Codex stdin support and omits codex_fork_session`);
    }
  }
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
  // Fragment validation for Markdown targets, where anchors are deterministic
  // heading slugs we can resolve from the local file. Fragments on the site
  // root / HTML pages are intentionally NOT checked: there they are schema.org
  // JSON-LD @id identifiers (e.g. /#software, /#api), not navigable anchors.
  if (parsed.hash && mode === "local" && parsed.pathname.endsWith(".md")) {
    const fragment = decodeURIComponent(parsed.hash.slice(1));
    // Memoize per target path: many fragment links can point at the same file,
    // and re-parsing its whole body for each one is quadratic in link count.
    let anchors = markdownAnchorsCache.get(parsed.pathname);
    if (!anchors) {
      anchors = markdownAnchors(result.body);
      markdownAnchorsCache.set(parsed.pathname, anchors);
    }
    if (!anchors.has(fragment)) {
      fail(`${url} references #${fragment}, absent from the headings of ${parsed.pathname}`);
    }
  }
}

// Cache of resolved Markdown targets' anchor sets, keyed by pathname, so a file
// referenced by many fragment links is parsed once, not once per link.
const markdownAnchorsCache = new Map();

// Repo-wide self-link sweep. lychee excludes the whole llm-cli-gateway.dev
// domain because unreleased pages 404 on the live site, so this local check is
// the ONLY thing that resolves those links against the tree being merged. It
// must cover every file that can carry one, not just the enumerated routes: a
// self-link in site/maintainers.md, site/robots.txt, site/index.html, or
// docs/launch/ was previously checked by neither lychee nor this validator.
async function sweepRepoSelfLinks() {
  const docsDir = join(repoRoot, "docs");
  const sources = [
    ...walkTextFiles(siteDir),
    ...(existsSync(docsDir) ? walkTextFiles(docsDir, SWEEP_EXCLUDE_DIRS) : []),
  ];
  for (const file of sources) {
    let body;
    try {
      body = readFileSync(file, "utf8");
    } catch (error) {
      // walkTextFiles already confirmed this is a regular, non-binary file, so a
      // read failure is anomalous. Surface it rather than skip the file's links.
      fail(`unable to read ${file} for the self-link sweep: ${error.message}`);
    }
    if (!body.includes("llm-cli-gateway.dev/")) continue;
    for (const url of extractSelfLinks(body)) {
      await assertInternalLink(url);
    }
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
      fail(
        `${route.path} content-type "${result.contentType}" does not start with "${route.type}"`
      );
    }
    if (isHtmlHomepage(result.body) && route.path !== "/") {
      fail(`${route.path} returned homepage HTML`);
    }
    if (route.json) {
      const value = parseJson(route, result.body);
      assertRequired(route, value);
      if (route.path === "/tools.fixture.json") {
        assertNoPublicInternalMcpAliases(value, route.path);
      }
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

  assertCodexPromptTransportContract(bodies);

  // In local mode this is the backstop for every self-link lychee's whole-domain
  // exclusion skips, resolved against the tree being merged. Remote mode already
  // probes the deployed site, so a local-tree sweep would not describe it.
  if (mode === "local") {
    await sweepRepoSelfLinks();
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

  process.stdout.write(
    `site discovery validation passed (${mode}${baseUrl ? ` ${baseUrl}` : ""})\n`
  );
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
