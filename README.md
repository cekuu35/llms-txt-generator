# llms.txt Generator — Make Any Website AI-Readable (llms.txt + llms-full.txt)

Generate **`llms.txt`** and **`llms-full.txt`** for any website — the emerging standard that tells AI models (ChatGPT, Claude, Perplexity, Gemini) what your site is about and how to reference it. Think **robots.txt, but for LLMs**.

Point this Actor at a URL. It crawls the site, extracts titles, descriptions, and clean main content, and produces two downloadable files ready to drop at your domain root.

**▶️ Run it now on Apify → https://apify.com/nacred_corner/llms-txt-generator** — no install, API-callable, pay per page.

## Pricing you can predict

Apify lists this Actor at **$5 per 1,000 results ($0.005 per result)**. The Actor writes one dataset result for each processed page, so your `maxPages` setting also gives you a clear result-cost ceiling:

- `maxPages: 10` → up to **$0.05** in result charges.
- `maxPages: 50` (default) → up to **$0.25** in result charges.
- `maxPages: 1000` → up to **$5.00** in result charges.

Apify defines a separate, very small Actor-start event, and shows the live pricing before you run. Start with 10 pages, review the files, then raise `maxPages` only when you need broader coverage.

## Why llms.txt matters in 2026

- **RAG is the default architecture** for AI apps — `llms.txt` files are pre-structured, information-dense input made for retrieval pipelines.
- **Google added `llms.txt` to Chrome Lighthouse's "Agentic Browsing" audit** (May 2026) as an AI-readiness check.
- AI search visibility (GEO/AEO) increasingly depends on giving models a clean, structured map of your content.

## What this Actor does

- Crawls a website (same-domain links, up to your `maxPages` limit).
- Extracts `title`, meta `description`, and clean main content (`<article>`/`<main>` aware, strips nav/footer/scripts).
- Builds **`llms.txt`** — a concise, linked index of your pages.
- Builds **`llms-full.txt`** — the full text of every page for complete LLM/RAG ingestion.
- Pushes a per-page dataset (URL, title, description) you can export as JSON/CSV.

## Built for developers & scale (not just one page)

Unlike one-off web UI tools, this Actor is **API-callable, batch-friendly, and pipeline-ready**:
- Generate `llms.txt` for **hundreds of client sites** programmatically.
- Wire it into a **content/RAG pipeline** (n8n, cron, CI) via the Apify API.
- Pay only for pages processed.

## Input

| Field | Type | Default | Description |
|---|---|---|---|
| `websiteUrl` | string | — | Site to crawl (required). |
| `maxPages` | integer | 50 | Max pages processed (controls cost/runtime). |
| `includeFullText` | boolean | true | Also generate `llms-full.txt`. |
| `maxContentCharsPerPage` | integer | 12000 | Truncate very long pages in the full file. |

## Output

- **Key-value store**: `llms.txt` and `llms-full.txt` (download from the run's Storage tab).
- **Dataset**: one record per page (`url`, `title`, `description`, `contentChars`).

## Example

```json
{
  "websiteUrl": "https://example.com",
  "maxPages": 100,
  "includeFullText": true
}
```

Then place the resulting `llms.txt` at `https://example.com/llms.txt` (root, like `robots.txt`).

## Use cases

- **AI SEO / GEO**: make your site discoverable and quotable by AI assistants.
- **RAG ingestion**: turn any docs/marketing site into clean, chunk-ready text.
- **Agencies**: batch-generate `llms.txt` for every client site.
- **AI agents**: give agents a structured, low-noise view of a domain.

---

*Tip: run on your documentation or marketing site first, review `llms.txt`, then publish it at your domain root.*


---

## ▶️ Run it on Replit (no setup)
[![Try on Replit](https://img.shields.io/badge/Try%20it%20on-Replit-F26207?logo=replit&logoColor=white)](https://replit.com/signup?referral=cnkkurtoglu&trackingContext=artifact_loading)

Prefer building in the browser? Clone and run this on Replit in one click.
New to Replit? **[Sign up for $20 in free credits »](https://replit.com/signup?referral=cnkkurtoglu&trackingContext=artifact_loading)**.
