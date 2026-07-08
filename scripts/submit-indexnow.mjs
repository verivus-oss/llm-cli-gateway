#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_HOST = "llm-cli-gateway.dev";
const DEFAULT_SITE_DIR = "site";
const DEFAULT_ENDPOINT = "https://www.bing.com/indexnow";
const KEY_FILE_PATTERN = /^[a-f0-9]{32}\.txt$/i;

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

const host = process.env.INDEXNOW_HOST || DEFAULT_HOST;
const siteDir = process.env.INDEXNOW_SITE_DIR || DEFAULT_SITE_DIR;
const endpoint = process.env.INDEXNOW_ENDPOINT || DEFAULT_ENDPOINT;

async function findKeyFile() {
  if (process.env.INDEXNOW_KEY_FILE) {
    return process.env.INDEXNOW_KEY_FILE;
  }

  const entries = await readdir(siteDir);
  const keyFiles = entries.filter(entry => KEY_FILE_PATTERN.test(entry));

  if (keyFiles.length !== 1) {
    throw new Error(
      `Expected exactly one IndexNow key file in ${siteDir}, found ${keyFiles.length}.`
    );
  }

  return path.join(siteDir, keyFiles[0]);
}

async function readSitemapUrls() {
  const sitemapPath = path.join(siteDir, "sitemap.xml");
  const sitemap = await readFile(sitemapPath, "utf8");
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1].trim());

  if (urls.length === 0) {
    throw new Error(`No <loc> entries found in ${sitemapPath}.`);
  }

  return urls;
}

const keyFile = await findKeyFile();
const key = (await readFile(keyFile, "utf8")).trim();

if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
  throw new Error(`IndexNow key file ${keyFile} does not contain a valid key.`);
}

const keyFileName = path.basename(keyFile);
const keyLocation = `https://${host}/${encodeURIComponent(keyFileName)}`;
const urlList = await readSitemapUrls();
const payload = {
  host,
  key,
  keyLocation,
  urlList,
};

if (dryRun) {
  console.log(
    `IndexNow dry run: ${urlList.length} URL(s), host=${host}, keyLocation=${keyLocation}, endpoint=${endpoint}`
  );
  for (const url of urlList) {
    console.log(`- ${url}`);
  }
  process.exit(0);
}

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json; charset=utf-8",
  },
  body: JSON.stringify(payload),
});

if (!response.ok) {
  const responseText = await response.text();
  throw new Error(
    `IndexNow submission failed: ${response.status} ${response.statusText} ${responseText}`.trim()
  );
}

console.log(
  `IndexNow submitted ${urlList.length} URL(s) to ${endpoint}: ${response.status} ${response.statusText}`
);
