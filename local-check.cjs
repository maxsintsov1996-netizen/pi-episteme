#!/usr/bin/env node

"use strict";

const url = process.env.PI_EPISTEME_TEST_URL?.trim();
const model = process.env.PI_EPISTEME_TEST_MODEL?.trim();
const missing = [
  !url && "PI_EPISTEME_TEST_URL",
  !model && "PI_EPISTEME_TEST_MODEL",
].filter(Boolean);

if (missing.length > 0) {
  console.log(
    `SKIP: local smoke benchmark is opt-in; set ${missing.join(" and ")} to run it.`,
  );
  process.exit(0);
}

const prefix = [
  {
    role: "system",
    content: [
      "You are the EPISTEME local smoke benchmark.",
      "Preserve the stable project, research, and plan layers below.",
      "Reply with exactly one token.",
      "PROJECT: pi-episteme context compaction",
      "RESEARCH: stable prefixes can reuse provider-side KV caches.",
      "PLAN: compare two requests with an append-only ephemeral tail.",
    ].join("\n"),
  },
  {
    role: "user",
    content: "Stable context: benchmark this OpenAI-compatible chat endpoint.",
  },
];

const firstMessages = [
  ...prefix,
  { role: "user", content: "Ephemeral tail A: acknowledge the first request." },
];
const secondMessages = [
  ...firstMessages,
  { role: "assistant", content: "A" },
  { role: "user", content: "Ephemeral tail B: acknowledge the appended request." },
];

function bounded(value, limit = 1000) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

async function request(messages) {
  const headers = { "content-type": "application/json" };
  const apiKey = process.env.PI_EPISTEME_TEST_API_KEY;
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const started = performance.now();
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: 1,
      }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : error;
    throw new Error(`Network error: ${bounded(detail)}`);
  }
  const elapsedMs = performance.now() - started;

  let body;
  try {
    body = await response.text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : error;
    throw new Error(
      `HTTP ${response.status}; failed to read response body: ${bounded(detail)}`,
    );
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${bounded(body || response.statusText)}`);
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`HTTP ${response.status}; invalid JSON response: ${bounded(body)}`);
  }
  return { status: response.status, elapsedMs, data };
}

function report(label, result) {
  console.log(`${label}: HTTP ${result.status}; elapsed ${result.elapsedMs.toFixed(1)} ms`);
  if (result.data?.usage !== undefined) {
    console.log(`${label} usage: ${JSON.stringify(result.data.usage)}`);
  }
  if (result.data?.timings !== undefined) {
    console.log(`${label} timings: ${JSON.stringify(result.data.timings)}`);
  }
}

function reportedCachedTokens(data) {
  const candidates = [
    data?.usage?.prompt_tokens_details?.cached_tokens,
    data?.usage?.cached_tokens,
    data?.usage?.cacheRead,
    data?.usage?.cache_read_input_tokens,
    data?.timings?.cached_tokens,
    data?.timings?.cacheRead,
    data?.timings?.cache_n,
  ];
  return candidates.find(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
}

async function main() {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("PI_EPISTEME_TEST_URL must use http or https.");
  }

  console.log(`EPISTEME local smoke benchmark for model ${model}`);
  const first = await request(firstMessages);
  report("Request 1", first);
  const second = await request(secondMessages);
  report("Request 2", second);

  const cachedTokens = reportedCachedTokens(second.data);
  if (cachedTokens !== undefined) {
    console.log(`Cache read: provider explicitly reported ${cachedTokens} cached tokens.`);
  } else {
    console.log("Cache read: unverified; provider did not explicitly report cached tokens > 0.");
  }
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : error;
  console.error(`ERROR: ${bounded(detail)}`);
  process.exitCode = 1;
});
