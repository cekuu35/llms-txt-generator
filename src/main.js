import { Actor } from 'apify';
import { CheerioCrawler, Dataset, Sitemap, log } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { websiteUrl, maxPages = 50, includeFullText = true, maxContentCharsPerPage = 12000 } = input;

if (!websiteUrl) {
    await Actor.setValue('OUTPUT', { error: 'websiteUrl is required' });
    await Actor.exit({ exitCode: 1 });
}

const start = new URL(websiteUrl);
const host = start.host;

/** @type {{url:string,title:string,description:string,content:string}[]} */
const pages = [];

const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: maxPages,
    // Politeness + reliability
    maxConcurrency: 5,
    requestHandlerTimeoutSecs: 45,
    async requestHandler({ request, $, enqueueLinks }) {
        // Pay-per-event: charge one unit per processed page. No-op if PPE not configured.
        try { await Actor.charge({ eventName: 'page-processed' }); } catch { /* PPE not set — free run */ }

        // Strip non-content noise before extraction
        $('script, style, nav, footer, header, aside, noscript, svg, form, iframe').remove();

        const title = ($('title').first().text() || $('h1').first().text() || request.url).trim();
        const description = (
            $('meta[name="description"]').attr('content') ||
            $('meta[property="og:description"]').attr('content') ||
            ''
        ).trim();

        // Main-content heuristic: prefer <article>, then <main>, else body
        const $main = $('article').first().length
            ? $('article').first()
            : $('main').first().length
                ? $('main').first()
                : $('body');

        let content = $main
            .text()
            .replace(/\r/g, '')
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        if (content.length > maxContentCharsPerPage) content = content.slice(0, maxContentCharsPerPage) + '…';

        pages.push({ url: request.url, title, description, content });
        await Dataset.pushData({ url: request.url, title, description, contentChars: content.length });

        await enqueueLinks({
            strategy: 'same-domain',
            transformRequestFunction: (req) => {
                if (/\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|css|js|mp4|mp3|woff2?|ttf)(\?|#|$)/i.test(req.url)) return false;
                return req;
            },
        });
    },
    failedRequestHandler({ request }) {
        log.warning(`Failed: ${request.url}`);
    },
});

// Prefer the sitemap for page discovery — it gives full coverage and works on
// client-rendered SPAs (where following links from static HTML finds nothing).
let startRequests = [websiteUrl];
try {
    const sm = await Sitemap.tryCommonNames(start.origin);
    if (sm?.urls?.length) {
        startRequests = sm.urls.slice(0, maxPages);
        log.info(`Sitemap found: ${sm.urls.length} URLs — seeding up to ${maxPages}.`);
    } else {
        log.info('No sitemap found — falling back to same-domain link crawl.');
    }
} catch {
    log.info('Sitemap lookup failed — falling back to same-domain link crawl.');
}

log.info(`Crawling ${websiteUrl} (max ${maxPages} pages)…`);
await crawler.run(startRequests);

if (pages.length === 0) {
    await Actor.setValue('OUTPUT', { error: 'No pages could be crawled. Check the URL / site accessibility.' });
    await Actor.exit({ exitCode: 1 });
}

// --- Build llms.txt (concise index) ---
const siteTitle = pages[0].title || host;
const siteDesc = pages[0].description || `Content indexed from ${host} for LLMs.`;

let llms = `# ${siteTitle}\n\n> ${siteDesc}\n\n## Pages\n`;
for (const p of pages) {
    llms += `- [${p.title}](${p.url})${p.description ? `: ${p.description}` : ''}\n`;
}
await Actor.setValue('llms.txt', llms, { contentType: 'text/plain; charset=utf-8' });

// --- Build llms-full.txt (full content) ---
if (includeFullText) {
    let full = `# ${siteTitle}\n\n> ${siteDesc}\n`;
    for (const p of pages) {
        full += `\n\n---\n\n# ${p.title}\nSource: ${p.url}\n\n${p.content}\n`;
    }
    await Actor.setValue('llms-full.txt', full, { contentType: 'text/plain; charset=utf-8' });
}

const files = includeFullText ? ['llms.txt', 'llms-full.txt'] : ['llms.txt'];
const { defaultKeyValueStoreId } = Actor.getEnv();
const downloadUrls = defaultKeyValueStoreId
    ? Object.fromEntries(files.map((file) => [
        file,
        `https://api.apify.com/v2/key-value-stores/${defaultKeyValueStoreId}/records/${encodeURIComponent(file)}`,
    ]))
    : {};
await Actor.setValue('OUTPUT', {
    site: host,
    pagesProcessed: pages.length,
    files,
    downloadUrls,
    note: 'Review the generated files before publishing them at your domain root.',
});

log.info(`Done. ${pages.length} pages → ${files.join(', ')} in the Key-value store.`);
await Actor.exit();
