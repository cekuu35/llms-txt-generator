# AI/RAG Readiness & llms.txt Change Monitor

Generate review-ready **`llms.txt`** and **`llms-full.txt`** files, then keep them fresh. Each successful run also creates a hashed site manifest and compares it with the previous comparable run, so scheduled workflows can see which public pages were added or changed.

**[Run a 10-page test on Apify →](https://apify.com/nacred_corner/llms-txt-generator?utm_source=github&utm_medium=referral&utm_campaign=readme_primary)**

## The result

One run produces:

- **`llms.txt`** — concise linked index for review and publication.
- **`llms-full.txt`** — optional clean full text for documentation or RAG workflows.
- **`manifest.json`** — normalized URLs, metadata, word counts, and SHA-256 content fingerprints.
- **`changes.json`** — added, changed, unchanged, and possibly removed pages since the previous successful run.
- **Dataset** — one visible record per processed page for JSON, CSV, Excel, API, n8n, or MCP workflows.

The Actor also records whether `robots.txt`, an existing `/llms.txt`, and `/sitemap.xml` were reachable before generation. It does not invent an “AI ranking” score.

## Why this is more useful than a one-time generator

- **Schedule it:** re-run daily or weekly and receive deterministic content-change data.
- **Automate it:** use the Apify API, webhooks, n8n, Make, CI, or an AI agent.
- **Control cost:** `maxPages` limits visible page results and page-processing charges.
- **Audit the input:** inspect titles, canonical URLs, meta robots, H1 counts, word counts, and content hashes.
- **Keep a private baseline:** the previous manifest is stored in a named key-value store inside the Actor user's own Apify account.

## Pricing and a safe first run

Apify currently lists this Actor at **$5 per 1,000 delivered `result` records ($0.005 per page record)**. In the billing API this is Apify's synthetic `apify-default-dataset-item` event; the platform may also show a separate small Actor-start event. Check the live Pricing tab before every run.

```json
{
  "websiteUrl": "https://example.com",
  "maxPages": 10,
  "includeFullText": true,
  "trackChanges": true,
  "respectRobotsTxt": true
}
```

A 10-page run represents up to **$0.05** in page-result charges at the listed rate. The Actor stops gracefully when the run spending limit is reached and does not include an unpaid page in generated deliverables.

## Change monitoring

1. Run once to create the first manifest and baseline.
2. Save the input as an Apify Task or schedule the same Actor input.
3. On later successful runs, open `changes.json`.

Example summary:

```json
{
  "added": 2,
  "changed": 1,
  "unchanged": 46,
  "removedCandidates": 1
}
```

`removedCandidates` are URLs that appeared in the previous comparable crawl but not the current one. Confirm them before treating them as deleted; crawl limits, temporary failures, robots rules, or sitemap changes can affect coverage. A failed or spending-limit-truncated run does not overwrite the last clean baseline.

## Inputs

| Field | Default | Purpose |
|---|---:|---|
| `websiteUrl` | required | Public HTTP(S) site to process. Local/private-network targets are rejected. |
| `maxPages` | `50` | Maximum visible page results and main cost control. |
| `includeFullText` | `true` | Also generate `llms-full.txt`. |
| `trackChanges` | `true` | Compare with and update the previous successful baseline. |
| `respectRobotsTxt` | `true` | Skip URLs disallowed by `robots.txt`. |
| `maxContentCharsPerPage` | `12000` | Maximum extracted characters used per page. |

The Actor caps `maxPages` at 1,000, per-page extracted content at 50,000 characters, and total delivered extracted content at 10,000,000 characters. If the total safety limit is reached, the current unpaid page is excluded, prior paid pages remain deliverable, and the partial run does not replace the clean change baseline.

## What counts as a change?

The Actor normalizes each URL and hashes the normalized page title, meta description, and extracted main text. Whitespace-only differences do not change the fingerprint. A title, description, or content change does.

## Good fit

- Agencies maintaining AI/RAG deliverables across client documentation sites.
- Documentation teams that need a repeatable content inventory.
- Developers feeding reviewed public content into retrieval pipelines.
- Automation builders who need structured change events instead of manually comparing files.

## Important limits

- The Actor processes public pages only and does not bypass authentication or access controls.
- HTTP-first extraction does not render client-only JavaScript content.
- Generated files and removal candidates require human review before publication or destructive action.
- `llms.txt` is an emerging, optional convention. Chrome Lighthouse's Agentic Browsing audit can check it, but publishing one does **not** guarantee crawling, ranking, citations, recommendations, or traffic.
- Process only sites and content you are authorized to crawl and reuse. Source-site copyright, privacy, robots policy, and publication choices remain the user's responsibility.

**[Generate and monitor the files on Apify →](https://apify.com/nacred_corner/llms-txt-generator?utm_source=github&utm_medium=referral&utm_campaign=readme_bottom)**

