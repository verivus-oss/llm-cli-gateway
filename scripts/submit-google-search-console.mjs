#!/usr/bin/env node

import process from "node:process";

const DEFAULT_SITE_URL = "https://llm-cli-gateway.dev/";
const DEFAULT_SITEMAP_URL = "https://llm-cli-gateway.dev/sitemap.xml";
const DEFAULT_ENDPOINT = "https://searchconsole.googleapis.com/webmasters/v3";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

const siteUrl = process.env.GOOGLE_SEARCH_CONSOLE_SITE_URL || DEFAULT_SITE_URL;
const sitemapUrl = process.env.GOOGLE_SEARCH_CONSOLE_SITEMAP_URL || DEFAULT_SITEMAP_URL;
const endpoint = process.env.GOOGLE_SEARCH_CONSOLE_ENDPOINT || DEFAULT_ENDPOINT;
const accessToken = process.env.GOOGLE_ACCESS_TOKEN;

const submitUrl = `${endpoint}/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`;

if (dryRun) {
  console.log(`Google Search Console dry run: site=${siteUrl}, sitemap=${sitemapUrl}`);
  console.log(`PUT ${submitUrl}`);
  process.exit(0);
}

if (!accessToken) {
  throw new Error("GOOGLE_ACCESS_TOKEN is required for Google Search Console submission.");
}

const response = await fetch(submitUrl, {
  method: "PUT",
  headers: {
    authorization: `Bearer ${accessToken}`,
  },
});

if (!response.ok) {
  const responseText = await response.text();
  throw new Error(
    `Google Search Console sitemap submission failed: ${response.status} ${response.statusText} ${responseText}`.trim()
  );
}

console.log(
  `Google Search Console submitted sitemap ${sitemapUrl} for ${siteUrl}: ${response.status} ${response.statusText}`
);
