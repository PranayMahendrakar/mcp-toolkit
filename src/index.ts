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
import { z } from "zod";

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
}

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
  }
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
