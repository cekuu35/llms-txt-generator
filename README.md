# llms.txt Generator — Make Any Website AI-Readable

Generate **`llms.txt`** and **`llms-full.txt`** for a public website without installing a crawler. Point the Actor at a URL; it crawls same-domain pages, extracts clean main content, and saves two downloadable files plus a per-page dataset.

**[Run a 10-page test on Apify →](https://apify.com/nacred_corner/llms-txt-generator?utm_source=github&utm_medium=referral&utm_campaign=readme_primary)**

## Start small, then scale

Apify currently lists this Actor at **$5 per 1,000 results ($0.005 per processed page)**. Set `maxPages` to control the result-charge ceiling before a run:

- `maxPages: 10` → up to **$0.05** in result charges.
- `maxPages: 50` → up to **$0.25** in result charges.
- `maxPages: 1000` → up to **$5.00** in result charges.

Apify shows the live pricing before execution and may list a separate small Actor-start event. A 10-page run is the simplest way to inspect the output before processing a larger site.

## What you receive

- **`llms.txt`** — a concise, linked index of the processed pages.
- **`llms-full.txt`** — clean full text for documentation, retrieval, or RAG workflows.
- **Exportable dataset** — one record per processed page with URL, title, description, and content length.

The generated files are stored in the run's key-value store, while page records can be exported as JSON or CSV.

## Why use an Actor instead of a one-page web form?

- **API-callable:** run it from your own scripts through the Apify API.
- **Batch-friendly:** repeat the same workflow across client or project sites.
- **Pipeline-ready:** connect runs to n8n, cron, or CI workflows.
- **Cost-controlled:** `maxPages` caps how many page results the Actor can produce.

Chrome Lighthouse includes `llms.txt` in its Agentic Browsing audits. Publishing a generated file can give machines a cleaner map of a site's content, but it does **not** guarantee crawling, rankings, citations, or traffic.

## Input

| Field | Type | Default | Description |
|---|---|---|---|
| `websiteUrl` | string | — | Public site to crawl (required). |
| `maxPages` | integer | 50 | Maximum pages processed. |
| `includeFullText` | boolean | true | Also generate `llms-full.txt`. |
| `maxContentCharsPerPage` | integer | 12000 | Truncate very long page content in the full file. |

### Recommended first run

```json
{
  "websiteUrl": "https://example.com",
  "maxPages": 10,
  "includeFullText": true
}
```

Review the two files, then raise `maxPages` only if you need broader coverage. When ready, publish the reviewed `llms.txt` at your domain root, for example `https://example.com/llms.txt`.

## Good fit

- Agencies generating the same deliverable across multiple client sites.
- Developers preparing documentation or marketing sites for retrieval workflows.
- Teams that need structured page text for an internal RAG pipeline.
- Automation builders who want an API, dataset exports, and repeatable runs.

## Important limits

- The Actor processes public, reachable pages; it does not bypass authentication or access controls.
- Generated content should be reviewed before publication.
- Source-site permissions, copyright, privacy, and publication choices remain the user's responsibility.
- `llms.txt` is a content map, not a promise of AI visibility or business results.

**[Generate the files on Apify →](https://apify.com/nacred_corner/llms-txt-generator?utm_source=github&utm_medium=referral&utm_campaign=readme_bottom)**