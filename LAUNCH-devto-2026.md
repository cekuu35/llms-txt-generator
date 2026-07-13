---
title: "I built an API-callable llms.txt generator after Lighthouse added an audit"
published: false
description: "Generate llms.txt and llms-full.txt from a website, then call the same workflow from Apify, an API, or a schedule."
tags: ai, webdev, seo, opensource
---

## Lighthouse made `llms.txt` harder to ignore

In May 2026, Chrome Lighthouse documented an optional `llms.txt` check in its new Agentic Browsing category.

That does **not** mean `llms.txt` is a guaranteed ranking factor. Lighthouse currently marks a missing file as N/A and flags server errors when it tries to retrieve one. The practical signal is narrower: machine-readable site summaries are becoming part of the tooling used to evaluate an agent-friendly web.

The file itself is simple Markdown at the root of a domain:

```markdown
# Example Product

> One sentence explaining what the product does.

## Pages
- [Documentation](https://example.com/docs): Setup and API guides.
- [Pricing](https://example.com/pricing): Plans and limits.
```

The companion `llms-full.txt` can include the full text of the selected pages for RAG and content-ingestion workflows.

## The repetitive part was the reason I automated it

Creating one file by hand is easy. Repeating the work across client sites, documentation portals, or scheduled content snapshots is not.

So I built an Apify Actor that:

- crawls same-domain pages up to a limit you choose;
- prefers a site's sitemap when available;
- extracts page titles, descriptions, and main content;
- outputs both `llms.txt` and `llms-full.txt`;
- stores a page-level dataset that can be exported as JSON or CSV;
- runs from the Apify UI, API, schedules, or automation workflows.

Try it here: **[llms.txt Generator on Apify](https://apify.com/nacred_corner/llms-txt-generator)**

Example input:

```json
{
  "websiteUrl": "https://example.com",
  "maxPages": 50,
  "includeFullText": true
}
```

When the run finishes, download the generated files from the run's key-value store and review them before publishing at your domain root.

## When this is useful

- You manage several client sites and want the same repeatable workflow for each.
- You want a clean text snapshot for a RAG pipeline.
- You want to regenerate files on a schedule as documentation changes.
- You need a page inventory alongside the generated files.

The project is intentionally small and open source. If you try it on a site that exposes an edge case, open an issue or leave a comment with the URL pattern and expected output.

Source: **[GitHub](https://github.com/cekuu35/llms-txt-generator)**

Reference: **[Chrome Lighthouse llms.txt audit documentation](https://developer.chrome.com/docs/lighthouse/agentic-browsing/llms-txt)**
