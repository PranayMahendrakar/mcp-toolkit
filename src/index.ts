/**
 * MCP Toolkit — a tiny, free, open remote MCP server.
 *
 * One server, two platforms: the same public HTTPS URL plugs into both
 * Claude ("Custom connector") and ChatGPT ("Developer mode" connector),
 * because both now speak the open Model Context Protocol (MCP).
 *
 * It runs on Cloudflare Workers' free tier. Each MCP session gets its own
 * Durable Object instance of the MyMCP class below.
 *
 * Endpoints once deployed:
 *   GET  /            -> friendly landing page (open it in a browser to confirm it's live)
 *   POST /mcp         -> MCP over Streamable HTTP  (recommended — use this URL in Claude & ChatGPT)
 *        /sse         -> MCP over SSE              (legacy transport, for older clients)
 *
 * Add your own tools inside init() — see the three examples below.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import yaml from "js-yaml";
import { z } from "zod";

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
}

// Caps keep us inside the free tier's 10ms CPU budget. The diff is O(n*m).
const MAX_DIFF_LINES = 300;

export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "MCP Toolkit",
    version: "1.0.0",
  });

  async init() {
    // ---------------------------------------------------------------------
    // Tool 1: current time in any timezone.
    // LLMs don't actually know "now" — this gives them a real clock.
    // ---------------------------------------------------------------------
    this.server.registerTool(
      "get_current_time",
      {
        title: "Get current time",
        description:
          "Get the real current date and time, optionally in a specific IANA timezone " +
          "(e.g. 'Asia/Kolkata', 'America/New_York', 'Europe/London'). Defaults to UTC. " +
          "Use this whenever the actual current time matters — the model's own sense of time is unreliable.",
        inputSchema: {
          timezone: z
            .string()
            .optional()
            .describe("IANA timezone name, e.g. 'Asia/Kolkata'. Defaults to UTC."),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ timezone }) => {
        const tz = timezone && timezone.trim() ? timezone.trim() : "UTC";
        const now = new Date();
        try {
          const human = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            dateStyle: "full",
            timeStyle: "long",
            hour12: false,
          }).format(now);

          return {
            content: [
              {
                type: "text",
                text:
                  `Current time in ${tz}:\n${human}\n\n` +
                  `ISO 8601 (UTC): ${now.toISOString()}\n` +
                  `Unix timestamp: ${Math.floor(now.getTime() / 1000)}`,
              },
            ],
          };
        } catch {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `Unknown timezone: "${tz}". Use an IANA name such as ` +
                  `"UTC", "Asia/Kolkata", "America/New_York", or "Europe/London".`,
              },
            ],
          };
        }
      },
    );

    // ---------------------------------------------------------------------
    // Tool 2: precise calculator.
    // LLMs make arithmetic mistakes; this evaluates exactly, no eval().
    // ---------------------------------------------------------------------
    this.server.registerTool(
      "calculate",
      {
        title: "Calculate",
        description:
          "Evaluate a math expression precisely and return the exact result. " +
          "Supports + - * / % ^ (power), parentheses, and decimals, " +
          "e.g. '(12.5% of 349)' should be written as '349 * 12.5 / 100', or '2 ^ 10', or '(3 + 4) * 5'.",
        inputSchema: {
          expression: z
            .string()
            .min(1)
            .max(500)
            .describe("The arithmetic expression, e.g. '349 * 12.5 / 100'"),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ expression }) => {
        try {
          const result = evaluateExpression(expression);
          if (!Number.isFinite(result)) {
            throw new Error("Result is not a finite number (check for division by zero).");
          }
          return {
            content: [{ type: "text", text: `${expression.trim()} = ${result}` }],
          };
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Could not evaluate "${expression}": ${
                  err instanceof Error ? err.message : String(err)
                }`,
              },
            ],
          };
        }
      },
    );

    // ---------------------------------------------------------------------
    // Tool 3: text statistics.
    // Exact counts the model can't reliably produce by eyeballing.
    // ---------------------------------------------------------------------
    this.server.registerTool(
      "word_count",
      {
        title: "Word & text stats",
        description:
          "Return exact statistics for a piece of text: word count, character counts " +
          "(with and without spaces), sentence count, paragraph count, and estimated reading time.",
        inputSchema: {
          text: z.string().min(1).describe("The text to analyze."),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ text }) => {
        const words = (text.match(/\b[\p{L}\p{N}'’-]+\b/gu) ?? []).length;
        const charsWithSpaces = [...text].length;
        const charsNoSpaces = [...text.replace(/\s/g, "")].length;
        const sentences = (text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? []).length || (text.trim() ? 1 : 0);
        const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length;
        const minutes = words / 200; // ~200 words per minute
        const readingTime =
          minutes < 1 ? "under 1 minute" : `about ${Math.round(minutes)} minute${Math.round(minutes) === 1 ? "" : "s"}`;

        return {
          content: [
            {
              type: "text",
              text:
                `Words: ${words}\n` +
                `Characters (with spaces): ${charsWithSpaces}\n` +
                `Characters (no spaces): ${charsNoSpaces}\n` +
                `Sentences: ${sentences}\n` +
                `Paragraphs: ${paragraphs}\n` +
                `Estimated reading time: ${readingTime}`,
            },
          ],
        };
      },
    );

    // ---------------------------------------------------------------------
    // Tool 4: regex — actually executed, not guessed.
    // ---------------------------------------------------------------------
    this.server.registerTool(
      "test_regex",
      {
        title: "Test a regex (really runs it)",
        description:
          "Compile and ACTUALLY RUN a regular expression against test strings, returning the real matches, positions and capture groups. Models routinely guess regex behaviour wrong — this executes it. Use whenever a regex is written, debugged, or claimed to work.",
        inputSchema: {
          pattern: z.string().min(1).max(500).describe("The regex pattern, without delimiters."),
          tests: z.array(z.string().max(2000)).min(1).max(20).describe("Strings to test the pattern against."),
          flags: z.string().max(8).optional().describe("Regex flags, e.g. 'gi', 'm'. Default none."),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ pattern, tests, flags }) => {
        let re: RegExp;
        try {
          re = new RegExp(pattern, flags ?? "");
        } catch (e) {
          return { isError: true, content: [{ type: "text", text: `Invalid regex: ${e instanceof Error ? e.message : String(e)}` }] };
        }
        const groups = (m: RegExpMatchArray) =>
          m.length > 1 ? ` groups: [${m.slice(1).map((x) => JSON.stringify(x ?? null)).join(", ")}]` : "";
        const lines = tests.map((t, i) => {
          try {
            if (flags?.includes("g")) {
              const ms = [...t.matchAll(re)];
              if (ms.length === 0) return `${i + 1}. ✗ no match — ${JSON.stringify(t)}`;
              return `${i + 1}. ✓ ${ms.length} match(es) — ${JSON.stringify(t)}\n   ${ms.map((m) => `"${m[0]}" @${m.index}${groups(m)}`).join("\n   ")}`;
            }
            const m = re.exec(t);
            if (!m) return `${i + 1}. ✗ no match — ${JSON.stringify(t)}`;
            return `${i + 1}. ✓ "${m[0]}" @${m.index}${groups(m)} — ${JSON.stringify(t)}`;
          } catch (e) {
            return `${i + 1}. ⚠️ error: ${e instanceof Error ? e.message : String(e)}`;
          }
        });
        const hits = lines.filter((l) => l.includes("✓")).length;
        return { content: [{ type: "text", text: `Regex: /${pattern}/${flags ?? ""}\nMatched ${hits} of ${tests.length} test string(s).\n\n${lines.join("\n")}` }] };
      },
    );

    // ---------------------------------------------------------------------
    // Tool 5: exact diff. Models miscount changes when eyeballing text.
    // ---------------------------------------------------------------------
    this.server.registerTool(
      "diff_text",
      {
        title: "Exact text diff",
        description:
          "Compute an EXACT line-by-line diff between two texts, with true added/removed counts. Models miscount and invent changes when comparing by eye — this computes it. Use to compare two versions of text, config, or code.",
        inputSchema: {
          a: z.string().describe("Original text."),
          b: z.string().describe("Changed text."),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ a, b }) => {
        const la = a.split(/\r?\n/);
        const lb = b.split(/\r?\n/);
        if (la.length > MAX_DIFF_LINES || lb.length > MAX_DIFF_LINES) {
          return {
            isError: true,
            content: [{ type: "text", text: `Too large: ${la.length} vs ${lb.length} lines (limit ${MAX_DIFF_LINES} each, to stay inside the free CPU budget). Diff a smaller section.` }],
          };
        }
        const d = diffLines(la, lb);
        const added = d.filter((x) => x.t === "+").length;
        const removed = d.filter((x) => x.t === "-").length;
        if (added === 0 && removed === 0) {
          return { content: [{ type: "text", text: "Identical — no differences." }] };
        }
        const body = d.map((x) => `${x.t} ${x.line}`).join("\n");
        return { content: [{ type: "text", text: `+${added} added  -${removed} removed  (${d.filter((x) => x.t === " ").length} unchanged)\n\n${body}` }] };
      },
    );

    // ---------------------------------------------------------------------
    // Tool 6: token/cost estimate. Honest: exact counts + a LABELLED estimate.
    // ---------------------------------------------------------------------
    this.server.registerTool(
      "estimate_tokens",
      {
        title: "Estimate tokens & cost",
        description:
          "Estimate how many tokens a piece of text is, and optionally what it costs. Returns EXACT character and word counts plus an approximate token range. Use when sizing a prompt against a context window or budgeting API spend.",
        inputSchema: {
          text: z.string().min(1).describe("The text to size."),
          usd_per_million_tokens: z.number().positive().optional().describe("Your model's price per 1M tokens, to compute cost. Supply it yourself — prices change and this tool does not guess them."),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ text, usd_per_million_tokens }) => {
        const chars = [...text].length;
        const words = (text.match(/\S+/g) ?? []).length;
        const byChars = Math.round(chars / 4);
        const byWords = Math.round(words / 0.75);
        const lo = Math.min(byChars, byWords);
        const hi = Math.max(byChars, byWords);
        const mid = Math.round((lo + hi) / 2);
        const cost =
          usd_per_million_tokens !== undefined
            ? `\nEstimated cost: $${((mid / 1_000_000) * usd_per_million_tokens).toFixed(6)} (range $${((lo / 1_000_000) * usd_per_million_tokens).toFixed(6)}–$${((hi / 1_000_000) * usd_per_million_tokens).toFixed(6)}) at $${usd_per_million_tokens}/1M tokens`
            : `\nCost: pass usd_per_million_tokens to compute it (this tool does not hardcode prices, which change).`;
        return {
          content: [{
            type: "text",
            text:
              `EXACT counts:\n• Characters: ${chars}\n• Words: ${words}\n\n` +
              `APPROXIMATE tokens: ~${mid} (range ${lo}–${hi})${cost}\n\n` +
              `Note: this is a heuristic (~4 chars/token, ~0.75 words/token), typically within ~10–20% for English prose. It is NOT a real BPE tokenizer — code, non-English text, and unusual symbols tokenize differently. For exact counts use the provider's tokenizer/count-tokens endpoint.`,
          }],
        };
      },
    );

    // ---------------------------------------------------------------------
    // Tool 7: JSON/YAML validation with a real parser and a real error position.
    // ---------------------------------------------------------------------
    this.server.registerTool(
      "validate_data",
      {
        title: "Validate JSON / YAML",
        description:
          "Validate JSON or YAML with a real parser and report the exact error and its location. Models guess at syntax errors; this parses. Use whenever JSON/YAML is written or someone reports a config/parse error.",
        inputSchema: {
          text: z.string().min(1).describe("The JSON or YAML text."),
          format: z.enum(["json", "yaml", "auto"]).optional().describe("Default auto — detects from the content."),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ text, format }) => {
        const t = text.trim();
        const fmt = !format || format === "auto" ? (t.startsWith("{") || t.startsWith("[") ? "json" : "yaml") : format;
        try {
          if (fmt === "json") {
            const v = JSON.parse(t);
            return { content: [{ type: "text", text: `✅ Valid JSON.\nTop-level type: ${Array.isArray(v) ? `array (${v.length} items)` : typeof v === "object" && v !== null ? `object (${Object.keys(v).length} keys: ${Object.keys(v).slice(0, 10).join(", ")})` : typeof v}` }] };
          }
          const v = yaml.load(t);
          return { content: [{ type: "text", text: `✅ Valid YAML.\nTop-level type: ${Array.isArray(v) ? `array (${v.length} items)` : typeof v === "object" && v !== null ? `object (${Object.keys(v as object).length} keys: ${Object.keys(v as object).slice(0, 10).join(", ")})` : typeof v}` }] };
          } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { isError: true, content: [{ type: "text", text: `❌ Invalid ${fmt.toUpperCase()}.\n\n${msg}` }] };
        }
      },
    );

    // ---------------------------------------------------------------------
    // Tool 8: JWT decode. Decoding is NOT verifying — the tool says so.
    // ---------------------------------------------------------------------
    this.server.registerTool(
      "decode_jwt",
      {
        title: "Decode a JWT",
        description:
          "Decode a JWT's header and payload and render its claims, including expiry as a real date. Does NOT verify the signature (that needs the secret/public key) — the output says so explicitly. Use to inspect a token's contents or check whether it has expired.",
        inputSchema: { token: z.string().min(10).describe("The JWT (three dot-separated base64url parts).") },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ token }) => {
        const parts = token.trim().split(".");
        if (parts.length < 2) {
          return { isError: true, content: [{ type: "text", text: "Not a JWT: expected at least two dot-separated base64url parts (header.payload[.signature])." }] };
        }
        try {
          const header = JSON.parse(b64urlDecode(parts[0]));
          const payload = JSON.parse(b64urlDecode(parts[1])) as Record<string, unknown>;
          const when = (k: string) => {
            const v = payload[k];
            return typeof v === "number" ? `\n• ${k}: ${v} → ${new Date(v * 1000).toISOString()}` : "";
          };
          const exp = typeof payload.exp === "number" ? payload.exp * 1000 : null;
          const state = exp === null ? "no exp claim — does not expire" : exp < Date.now() ? `EXPIRED ${Math.round((Date.now() - exp) / 60000)} min ago` : `valid for another ${Math.round((exp - Date.now()) / 60000)} min`;
          return {
            content: [{
              type: "text",
              text:
                `Header:\n${JSON.stringify(header, null, 2)}\n\nPayload:\n${JSON.stringify(payload, null, 2)}\n\n` +
                `Timing: ${state}${when("iat")}${when("nbf")}${when("exp")}\n\n` +
                `⚠️ Signature NOT verified — decoding only. Anyone can read a JWT's contents; only the key holder can prove it's authentic. Treat these claims as unverified until the signature is checked server-side.\n` +
                `⚠️ A JWT is a credential. Avoid pasting live production tokens into any third-party tool, including this one.`,
            }],
          };
        } catch (e) {
          return { isError: true, content: [{ type: "text", text: `Could not decode: ${e instanceof Error ? e.message : String(e)}` }] };
        }
      },
    );
  }
}

/** Base64url -> UTF-8 string. */
function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Classic LCS line diff. O(n*m) — callers must cap input size. */
function diffLines(a: string[], b: string[]): Array<{ t: "+" | "-" | " "; line: string }> {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Array<{ t: "+" | "-" | " "; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) out.push({ t: " ", line: a[i++] }), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: "-", line: a[i++] });
    else out.push({ t: "+", line: b[j++] });
  }
  while (i < m) out.push({ t: "-", line: a[i++] });
  while (j < n) out.push({ t: "+", line: b[j++] });
  return out;
}

/**
 * Safely evaluate an arithmetic expression WITHOUT eval().
 * Recursive-descent parser. Supports + - * / % ^, parentheses, unary +/-, decimals.
 */
function evaluateExpression(input: string): number {
  const s = input;
  let i = 0;

  const skipWs = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };

  const parsePrimary = (): number => {
    skipWs();
    if (s[i] === "(") {
      i++;
      const v = parseExpression();
      skipWs();
      if (s[i] !== ")") throw new Error("missing closing parenthesis");
      i++;
      return v;
    }
    const start = i;
    while (i < s.length && /[0-9.]/.test(s[i])) i++;
    if (start === i) {
      throw new Error(`unexpected character '${s[i] ?? "end of input"}' at position ${i}`);
    }
    const num = Number.parseFloat(s.slice(start, i));
    if (Number.isNaN(num)) throw new Error("invalid number");
    return num;
  };

  const parseUnary = (): number => {
    skipWs();
    if (s[i] === "+") {
      i++;
      return parseUnary();
    }
    if (s[i] === "-") {
      i++;
      return -parseUnary();
    }
    return parsePrimary();
  };

  const parsePower = (): number => {
    const base = parseUnary();
    skipWs();
    if (s[i] === "^") {
      i++;
      return Math.pow(base, parsePower()); // right-associative
    }
    return base;
  };

  const parseTerm = (): number => {
    let value = parsePower();
    skipWs();
    while (s[i] === "*" || s[i] === "/" || s[i] === "%") {
      const op = s[i++];
      const rhs = parsePower();
      value = op === "*" ? value * rhs : op === "/" ? value / rhs : value % rhs;
      skipWs();
    }
    return value;
  };

  const parseExpression = (): number => {
    let value = parseTerm();
    skipWs();
    while (s[i] === "+" || s[i] === "-") {
      const op = s[i++];
      const rhs = parseTerm();
      value = op === "+" ? value + rhs : value - rhs;
      skipWs();
    }
    return value;
  };

  skipWs();
  const result = parseExpression();
  skipWs();
  if (i < s.length) {
    throw new Error(`unexpected trailing input '${s.slice(i)}'`);
  }
  return result;
}

// A small human-readable landing page + MCP routing.
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // MCP over Streamable HTTP (current spec) — use THIS url in Claude & ChatGPT.
    if (url.pathname === "/mcp") {
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }

    // MCP over SSE (deprecated) — kept for older MCP clients.
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    // Anything else -> a friendly page so a browser visit confirms it's running.
    if (url.pathname === "/") {
      const origin = url.origin;
      return new Response(landingPage(origin), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

function landingPage(origin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MCP Toolkit — live</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.6; }
  code { background: #f2f2f2; padding: .15rem .35rem; border-radius: .25rem; }
  .ok { color: #0a7d28; font-weight: 600; }
</style>
</head>
<body>
  <h1>MCP Toolkit <span class="ok">✔ live</span></h1>
  <p>This is a running <strong>Model Context Protocol</strong> server. Add it to Claude or ChatGPT
  as a custom connector using this URL:</p>
  <p><code>${origin}/mcp</code></p>
  <h2>Tools it adds</h2>
  <ul>
    <li><code>get_current_time</code> — the real current time in any timezone</li>
    <li><code>calculate</code> — precise math</li>
    <li><code>word_count</code> — exact text statistics</li>
  </ul>
  <p>Source &amp; setup instructions: see the project's README.</p>
</body>
</html>`;
}
