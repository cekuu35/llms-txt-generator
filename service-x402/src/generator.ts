export interface PageRecord {
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly content: string;
}

export interface GenerationFiles {
  readonly llmsTxt: string;
  readonly llmsFullTxt?: string;
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function byUrl(a: PageRecord, b: PageRecord): number {
  return a.url.localeCompare(b.url, "en");
}

export function generateFiles(site: string, pages: readonly PageRecord[], includeFullText: boolean): GenerationFiles {
  const sorted = [...pages].sort(byUrl);
  const origin = new URL(site).origin;
  const heading = "# " + origin;
  const indexLines = sorted.map((page) => {
    const description = normalizeLine(page.description || page.content.slice(0, 180));
    return "- [" + normalizeLine(page.title || page.url) + "](" + page.url + "): " + description;
  });
  const llmsTxt = [heading, "", "> Generated site context. Review before publishing.", "", "## Pages", ...indexLines, ""].join("\n");

  if (!includeFullText) return { llmsTxt };
  const sections = sorted.map((page) => [
    "## " + normalizeLine(page.title || page.url),
    "",
    "Source: " + page.url,
    "",
    page.content.trim(),
  ].join("\n"));
  return {
    llmsTxt,
    llmsFullTxt: [heading + " — Full text", "", ...sections, ""].join("\n"),
  };
}
