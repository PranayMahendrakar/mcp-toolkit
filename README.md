# MCP Toolkit 🧰

A tiny, **free**, open-source **plugin for both Claude and ChatGPT**.

It's a single [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server. Because
Claude and ChatGPT both now speak MCP, the **same server** plugs into **both** — you build it once
and one public URL works everywhere.

### Tools it adds to the AI

**The theme: things AI is confidently bad at.** Every tool here *computes* rather than guesses.

| Tool | What it does | Why it helps |
|------|--------------|--------------|
| `get_current_time` | Real current time in any timezone | LLMs don't actually know "now" |
| `calculate` | Precise arithmetic (`+ - * / % ^`, parentheses) | LLMs make math mistakes |
| `word_count` | Exact word / character / sentence stats | LLMs can't reliably count |
| `test_regex` | **Actually runs** your regex against test strings — real matches, positions, capture groups | LLMs guess regex behaviour and are often wrong |
| `diff_text` | Exact line-by-line diff with true added/removed counts | LLMs miscount and invent changes when comparing by eye |
| `estimate_tokens` | Exact char/word counts + an approximate token range, and cost if you supply your rate | Sizing prompts and budgeting spend |
| `validate_data` | Validates JSON/YAML with a **real parser**, pinpointing the error line and column | LLMs guess at syntax errors |
| `decode_jwt` | Decodes header + payload, renders `exp`/`iat` as real dates, flags expiry | Inspecting tokens without a website |

All are **read-only** — they can't change or delete anything.

### Honest limits (deliberately stated)

- **`estimate_tokens` is an estimate**, not a BPE tokenizer (~4 chars/token heuristic, typically ±10–20% on English prose; code and non-English text differ). The character and word counts *are* exact. It never hardcodes model prices — you pass your own rate, because prices change.
- **`decode_jwt` decodes; it does not verify.** Verifying a signature needs the key. Anyone can read a JWT's contents — only the key holder can prove it's authentic. Don't paste live production tokens into any third-party tool, this one included.
- **`diff_text` caps at 300 lines per side** — the diff is O(n×m) and the free tier allows 10ms CPU per request.

---

## The one thing to understand first

> **GitHub stores your code for free, but it can't *run* a server.** (GitHub Pages only serves static
> files.) To be added to *live* Claude/ChatGPT, your server needs a public `https://` URL that's actually
> running. So we host the **code** on GitHub and **run** it on **Cloudflare Workers' free tier.**

```
   Your code on GitHub  ──deploy──▶  Cloudflare Workers (free)  ──▶  https://mcp-toolkit.<you>.workers.dev/mcp
        (free)                            (runs 24/7)                          │
                                                                               ├──▶ paste into Claude
                                                                               └──▶ paste into ChatGPT
```

Cloudflare Workers' free tier is **100,000 requests/day** — plenty for personal use, and it never sleeps.

---

## What you need (all free)

- [Node.js](https://nodejs.org) 18+ installed
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- A free [GitHub account](https://github.com) (to publish the code)

---

## Step 1 — Get the code & run it locally

```powershell
# from the mcp-toolkit folder
npm install
npm run dev
```

You'll see it running at `http://localhost:8787`. Open `http://localhost:8787/` in a browser — you should
see a "✔ live" page. (Your local MCP endpoint is `http://localhost:8787/mcp`.)

> **Tip:** to sanity-check the code before deploying, run `npm run type-check`.

---

## Step 2 — Deploy it (get your public URL)

```powershell
npx wrangler deploy
```

The first time, Wrangler opens a browser to log into Cloudflare. When it finishes it prints your live URL:

```
https://mcp-toolkit.<your-account>.workers.dev
```

**Your connector URL is that address with `/mcp` on the end:**

```
https://mcp-toolkit.<your-account>.workers.dev/mcp
```

Open the base URL in a browser to confirm you see the "✔ live" page. **Keep the `/mcp` URL handy** — you'll
paste it into Claude and ChatGPT next.

---

## Step 3 — Put the code on GitHub (make it public & free)

```powershell
git init
git add .
git commit -m "MCP Toolkit: free MCP plugin for Claude & ChatGPT"
git branch -M main
git remote add origin https://github.com/<your-username>/mcp-toolkit.git
git push -u origin main
```

That's it — the code is now public and anyone can use it for free (MIT license).

**Optional — auto-deploy on every push:** this repo includes [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).
Add a `CLOUDFLARE_API_TOKEN` secret in your repo (**Settings → Secrets and variables → Actions**), and every
`git push` will redeploy automatically. (Details are in the workflow file's comments.)

---

## Step 4 — Add it to **Claude**

Works on **Free, Pro, Max, Team, and Enterprise** (Free is limited to one custom connector).

1. Open **claude.ai** → your profile/**Settings** → **Connectors** (it may be under **Customize → Connectors**).
2. Click **Add** → **Add custom connector**.
3. Paste your URL: `https://mcp-toolkit.<your-account>.workers.dev/mcp`
4. Click **Add**. (Leave the OAuth fields blank — this server needs no login.)
5. In any chat, click the **+** menu → **Connectors**, enable **MCP Toolkit**, then ask:
   *"What time is it right now in Asia/Kolkata?"* or *"Use calculate: (349 * 12.5) / 100"*.

> Works the same in **Claude Desktop** (Settings → Connectors → Add custom connector).
> On **Team/Enterprise**, only an organization Owner can add it.

---

## Step 5 — Add it to **ChatGPT**

ChatGPT reaches custom MCP tools through **Developer Mode** (a beta). Requirements:
**Plus, Pro, Business, Enterprise, or Edu**, on **ChatGPT in a desktop web browser** (not the mobile app).

1. **ChatGPT (desktop web)** → **Settings** → **Connectors** → **Advanced** → turn on **Developer mode**.
   *(On Business/Enterprise, an admin may need to enable this first.)*
2. Back in **Connectors**, click **Create / Add**. Fill in:
   - **Name:** `MCP Toolkit`
   - **Description:** `Current time, precise math, and text stats`
   - **URL:** `https://mcp-toolkit.<your-account>.workers.dev/mcp`
   - **Authentication:** **None**
3. Save. In a chat, open the **+ / tools** menu, enable **MCP Toolkit**, and ask the same kind of question.

> **Why Developer Mode?** ChatGPT's older "Deep Research connectors" only accept servers that expose exactly
> two tools (`search` + `fetch`). Developer Mode lifts that restriction so *any* MCP tools work in normal chat.
> If your plan can't use Developer Mode, this general-purpose toolkit won't fit the Deep-Research path — but it
> works fully in Claude.

---

## Add your own tool (extend it)

Open [`src/index.ts`](src/index.ts) and copy the pattern inside `init()`:

```ts
this.server.registerTool(
  "reverse_text",
  {
    title: "Reverse text",
    description: "Reverse a string of text.",
    inputSchema: { text: z.string() },          // a plain object of zod fields
    annotations: { readOnlyHint: true },          // read-only = no confirmation prompt
  },
  async ({ text }) => ({
    content: [{ type: "text", text: [...text].reverse().join("") }],
  }),
);
```

Then `npx wrangler deploy` again (or just `git push` if you set up auto-deploy). Reconnect in Claude/ChatGPT
to pick up the new tool.

---

## Troubleshooting

| Problem | Fix |
|--------|-----|
| Connector won't connect | Make sure you used the **`/mcp`** URL and that opening the base URL in a browser shows the "✔ live" page. The server must be publicly reachable (Cloudflare's is). |
| `npx wrangler deploy` fails to log in | Run `npx wrangler login` once, then retry. |
| ChatGPT has no "Developer mode" | It needs a Plus+ plan on desktop web; on Business/Enterprise an admin must enable it. |
| Tools don't appear in a chat | Open the **+ / connectors** menu in that chat and toggle the connector **on**. |
| Don't put secrets in the URL | Never add `?token=...` to the URL — it's blocked by the MCP spec. Use proper auth if you need it. |

---

## How it's built (for the curious)

- **Runtime:** Cloudflare Workers (serverless, free tier, never sleeps)
- **Library:** [`agents`](https://www.npmjs.com/package/agents)' `McpAgent` + the official
  [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- **Transports served:** `/mcp` (Streamable HTTP, recommended) and `/sse` (legacy, for older clients)
- **Auth:** none (authless) — anyone with the URL can use the read-only tools

## License

MIT — free for anyone to use, modify, and share. Replace `<Your Name>` in [`LICENSE`](LICENSE).
