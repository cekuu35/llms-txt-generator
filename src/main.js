import { Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { Actor } from 'apify';
import { CheerioCrawler, GotScrapingHttpClient, RobotsTxtFile, gotScraping, log } from 'crawlee';
import {
    baselineRecordKey,
    buildManifest,
    buildReadinessIssues,
    bodyFingerprint,
    compareManifests,
    contentFingerprint,
    escapeMarkdown,
    normalizeUrl,
    assertPublicResolvedUrl,
    applyPublicRequestPolicy,
    metadataFingerprint,
    validatePublicHttpUrl,
} from './change-monitor.js';

export const PAYLOAD_LIMITS = Object.freeze({
    rawPageResponseBytes: 2 * 1024 * 1024,
    urlChars: 2048,
    titleChars: 300,
    descriptionChars: 1000,
    canonicalChars: 2048,
    metaRobotsChars: 256,
    totalDeliveredChars: 10_000_000,
    nonPageOutputReserveChars: 1_000_000,
});

export const DEFAULT_DATASET_BILLING_EVENT = 'apify-default-dataset-item';
export const CHANGE_HISTORY_STORE_NAME = 'llms-txt-generator-change-history';

export function truncateWithEllipsis(value, maxChars) {
    const text = String(value ?? '');
    if (text.length <= maxChars) return text;
    if (maxChars <= 1) return text.slice(0, Math.max(0, maxChars));
    return `${text.slice(0, maxChars - 1)}…`;
}

export function boundedCanonicalUrl(value, baseUrl) {
    if (!value) return null;
    try {
        const canonicalUrl = new URL(value, baseUrl).toString();
        return canonicalUrl.length <= PAYLOAD_LIMITS.canonicalChars ? canonicalUrl : null;
    } catch {
        return null;
    }
}

// Conservative upper bound for all per-page appearances across the dataset,
// llms files, manifest, readiness issues, and change report. Multipliers include
// worst-case JSON/Markdown escaping; fixed overhead covers keys and hashes.
export function estimateDeliveredPageChars(page) {
    return (
        String(page.content ?? '').length +
        52 * String(page.url ?? '').length +
        24 * String(page.title ?? '').length +
        20 * String(page.description ?? '').length +
        12 * String(page.canonicalUrl ?? '').length +
        12 * String(page.metaRobots ?? '').length +
        4096
    );
}

export function createBodyLimitedHttpClient(
    maxBytes = PAYLOAD_LIMITS.rawPageResponseBytes,
    baseClient = new GotScrapingHttpClient(),
) {
    const assertBufferedBodySize = (body) => {
        const serializedBody =
            typeof body === 'string' || body == null
                ? String(body ?? '')
                : JSON.stringify(body);
        const byteLength = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(serializedBody, 'utf8');
        if (byteLength > maxBytes) throw new Error(`Page response exceeds the ${maxBytes}-byte safety limit.`);
    };

    return {
        async sendRequest(request) {
            const response = await baseClient.sendRequest(request);
            assertBufferedBodySize(response.body);
            return response;
        },
        async stream(request, onRedirect) {
            const response = await baseClient.stream(request, onRedirect);
            let receivedBytes = 0;
            const limiter = new Transform({
                transform(chunk, encoding, callback) {
                    const byteLength = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
                    receivedBytes += byteLength;
                    if (receivedBytes > maxBytes) {
                        callback(new Error(`Page response exceeds the ${maxBytes}-byte safety limit.`));
                        return;
                    }
                    callback(null, chunk);
                },
            });
            response.stream.once('error', (error) => limiter.destroy(error));
            limiter.once('error', () => response.stream.destroy());
            response.stream.pipe(limiter);
            return { ...response, stream: limiter };
        },
    };
}

export async function runActor() {
await Actor.init();

const input = (await Actor.getInput()) ?? {};
const maxPages = Math.max(1, Math.min(1000, Number.parseInt(input.maxPages ?? 50, 10) || 50));
const maxContentCharsPerPage = Math.max(
    1000,
    Math.min(50000, Number.parseInt(input.maxContentCharsPerPage ?? 12000, 10) || 12000),
);
const maxDeliveredPayloadChars = PAYLOAD_LIMITS.totalDeliveredChars;
const maxPagePayloadChars = maxDeliveredPayloadChars - PAYLOAD_LIMITS.nonPageOutputReserveChars;
const includeFullText = input.includeFullText !== false;
const trackChanges = input.trackChanges !== false;
const respectRobotsTxt = input.respectRobotsTxt !== false;
const crawlerUserAgent = 'AI-Readiness-Change-Monitor/0.2';

let start;
try {
    start = await assertPublicResolvedUrl(input.websiteUrl);
    if (start.toString().length > PAYLOAD_LIMITS.urlChars) {
        throw new Error(`websiteUrl must not exceed ${PAYLOAD_LIMITS.urlChars} characters.`);
    }
} catch (error) {
    await Actor.setValue('OUTPUT', { error: error.message });
    await Actor.exit({ exitCode: 1 });
}

const host = start.host;
const siteHost = start.hostname.toLowerCase();
const generatedAt = new Date().toISOString();
const historyStore = trackChanges
    ? await Actor.openKeyValueStore(CHANGE_HISTORY_STORE_NAME)
    : null;

function isSameSite(value) {
    try {
        const candidate = validatePublicHttpUrl(value);
        const candidateHost = candidate.hostname.toLowerCase();
        return candidateHost === siteHost;
    } catch {
        return false;
    }
}

async function requestSiteResource(pathname) {
    const target = await assertPublicResolvedUrl(new URL(pathname, start.origin));
    if (!isSameSite(target)) throw new Error('Resource target is outside the selected site.');

    const request = await gotScraping(applyPublicRequestPolicy({
        url: target,
        method: 'GET',
        isStream: true,
        throwHttpErrors: false,
        maxRedirects: 3,
        timeout: { request: 10000 },
        headers: { 'user-agent': crawlerUserAgent },
        hooks: {
            beforeRedirect: [
                async (updatedOptions) => {
                    const redirectTarget = await assertPublicResolvedUrl(updatedOptions.url);
                    if (!isSameSite(redirectTarget)) {
                        throw new Error(`Redirect outside the selected site is not allowed: ${redirectTarget}`);
                    }
                    applyPublicRequestPolicy(updatedOptions);
                },
            ],
        },
    }));

    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalBytes = 0;
        let responseMetadata;
        request.once('response', (response) => {
            responseMetadata = response;
        });
        request.on('data', (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > 512 * 1024) {
                request.destroy(new Error('Resource exceeds the 512 KiB safety limit.'));
                return;
            }
            chunks.push(chunk);
        });
        request.once('error', reject);
        request.once('end', () => {
            if (!responseMetadata || !isSameSite(responseMetadata.url)) {
                reject(new Error('Resource response resolved outside the selected site.'));
                return;
            }
            resolve({
                statusCode: responseMetadata.statusCode,
                headers: responseMetadata.headers,
                url: responseMetadata.url,
                body: Buffer.concat(chunks).toString('utf8'),
            });
        });
    });
}

async function probeResource(pathname, { includeBody = false } = {}) {
    try {
        const response = await requestSiteResource(pathname);
        return {
            found: response.statusCode >= 200 && response.statusCode < 300,
            statusCode: response.statusCode,
            finalUrl: response.url,
            contentType: response.headers['content-type'] ?? null,
            ...(includeBody ? { body: response.body } : {}),
        };
    } catch (error) {
        return {
            found: false,
            statusCode: null,
            reason: error.message?.includes('512 KiB')
                ? 'resource-too-large'
                : error.name === 'TimeoutError'
                    ? 'timeout'
                    : 'fetch-failed',
        };
    }
}

const pagesByUrl = new Map();
const claimedUrls = new Set();
let failedRequests = 0;
let chargeLimitReached = false;
let budgetBoundaryReached = false;
let contentLimitReached = false;
let deliveredContentChars = 0;
let estimatedDeliveredPayloadChars = 0;
let billingClosed = false;
let billingCommitChain = Promise.resolve();
const discoveryMode = 'links';

const [robotsResource, llmsProbe, sitemapProbe] = await Promise.all([
    probeResource('/robots.txt', { includeBody: true }),
    probeResource('/llms.txt'),
    probeResource('/sitemap.xml'),
]);
const { body: robotsBody = '', ...robotsProbe } = robotsResource;
const robotsMissing = [404, 410].includes(robotsResource.statusCode);
const robotsReliable = !respectRobotsTxt || robotsResource.found || robotsMissing;
if (!robotsReliable) {
    await Actor.setValue('OUTPUT', {
        error: `robots.txt could not be read safely (${robotsResource.reason ?? robotsResource.statusCode ?? 'unknown error'}). Try again later or explicitly disable robots enforcement.`,
    });
    await Actor.exit({ exitCode: 1 });
}
const robotsFile = RobotsTxtFile.from(new URL('/robots.txt', start.origin).toString(), robotsResource.found ? robotsBody : '');

function isAllowedByRobots(value) {
    return !respectRobotsTxt || robotsFile.isAllowed(String(value), crawlerUserAgent);
}

if (!isAllowedByRobots(start)) {
    await Actor.setValue('OUTPUT', { error: 'The start URL is disallowed by robots.txt.' });
    await Actor.exit({ exitCode: 1 });
}

let crawler;
async function commitPaidPage(normalizedUrl, page, datasetItem) {
    const commit = billingCommitChain.then(async () => {
        if (billingClosed) return false;
        const estimatedPageChars = estimateDeliveredPageChars(page);
        if (estimatedDeliveredPayloadChars + estimatedPageChars > maxPagePayloadChars) {
            contentLimitReached = true;
            billingClosed = true;
            log.info('The safe total delivered-payload limit was reached before charging the current page; stopping gracefully.');
            await crawler.autoscaledPool?.abort();
            return false;
        }

        const chargingManager = Actor.getChargingManager();
        if (chargingManager.calculateMaxEventChargeCountWithinLimit(DEFAULT_DATASET_BILLING_EVENT) <= 0) {
            budgetBoundaryReached = true;
            chargeLimitReached = true;
            billingClosed = true;
            log.info('The run spending limit was reached before charging the current page; stopping gracefully.');
            await crawler.autoscaledPool?.abort();
            return false;
        }

        // The live Actor is priced through Apify's synthetic default-dataset-item event.
        // Passing a second argument here would create a separate custom event and would
        // not match the existing $5 / 1,000-result monetization configuration.
        await Actor.pushData(datasetItem);
        pagesByUrl.set(normalizedUrl, page);
        deliveredContentChars += page.content.length;
        estimatedDeliveredPayloadChars += estimatedPageChars;

        if (chargingManager.calculateMaxEventChargeCountWithinLimit(DEFAULT_DATASET_BILLING_EVENT) <= 0) {
            budgetBoundaryReached = true;
            billingClosed = true;
            log.info('The run spending boundary was reached after the paid page was delivered; stopping gracefully.');
            await crawler.autoscaledPool?.abort();
        }

        return true;
    });
    billingCommitChain = commit.catch(() => undefined);
    return commit;
}

crawler = new CheerioCrawler({
    httpClient: createBodyLimitedHttpClient(),
    maxRequestsPerCrawl: maxPages,
    maxConcurrency: Math.min(3, maxPages),
    sameDomainDelaySecs: 0.2,
    requestHandlerTimeoutSecs: 45,
    respectRobotsTxtFile: false,
    preNavigationHooks: [
        async ({ request }, gotOptions) => {
            const target = await assertPublicResolvedUrl(request.url);
            if (!isSameSite(target)) throw new Error(`Navigation outside the selected site is not allowed: ${target}`);
            if (!isAllowedByRobots(target)) throw new Error(`robots.txt disallows navigation to ${target}`);
            applyPublicRequestPolicy(gotOptions);
            gotOptions.headers = { ...gotOptions.headers, 'user-agent': crawlerUserAgent };
            gotOptions.hooks ??= {};
            gotOptions.hooks.beforeRedirect = [
                ...(gotOptions.hooks.beforeRedirect ?? []),
                async (updatedOptions) => {
                    const redirectTarget = await assertPublicResolvedUrl(updatedOptions.url);
                    if (!isSameSite(redirectTarget)) {
                        throw new Error(`Redirect outside the selected site is not allowed: ${redirectTarget}`);
                    }
                    if (!isAllowedByRobots(redirectTarget)) {
                        throw new Error(`robots.txt disallows redirect to ${redirectTarget}`);
                    }
                    applyPublicRequestPolicy(updatedOptions);
                },
            ];
        },
    ],
    async requestHandler({ request, $, enqueueLinks }) {
        const loadedUrl = request.loadedUrl ?? request.url;
        if (!isSameSite(loadedUrl)) {
            log.warning(`Skipped redirect outside the selected site: ${request.url}`);
            return;
        }
        if (!isAllowedByRobots(loadedUrl)) {
            log.info(`Skipped by robots.txt: ${loadedUrl}`);
            return;
        }

        const normalizedUrl = normalizeUrl(loadedUrl);
        if (normalizedUrl.length > PAYLOAD_LIMITS.urlChars) {
            request.noRetry = true;
            log.warning(`Skipped URL longer than ${PAYLOAD_LIMITS.urlChars} characters: ${request.url}`);
            return;
        }
        if (claimedUrls.has(normalizedUrl)) return;
        claimedUrls.add(normalizedUrl);

        try {

        const title = truncateWithEllipsis(
            ($('title').first().text() || $('h1').first().text() || normalizedUrl).trim(),
            PAYLOAD_LIMITS.titleChars,
        );
        const description = truncateWithEllipsis(
            (
                $('meta[name="description"]').attr('content') ||
                $('meta[property="og:description"]').attr('content') ||
                ''
            ).trim(),
            PAYLOAD_LIMITS.descriptionChars,
        );
        const canonical = $('link[rel="canonical"]').attr('href');
        const canonicalUrl = boundedCanonicalUrl(canonical, loadedUrl);
        const metaRobots = truncateWithEllipsis(
            ($('meta[name="robots"]').attr('content') || '').trim(),
            PAYLOAD_LIMITS.metaRobotsChars,
        );
        const h1Count = $('h1').length;

        $('script, style, nav, footer, header, aside, noscript, svg, form, iframe').remove();
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
        content = truncateWithEllipsis(content, maxContentCharsPerPage);

        const page = {
            url: normalizedUrl,
            title,
            description,
            content,
            wordCount: content ? content.split(/\s+/u).filter(Boolean).length : 0,
            canonicalUrl,
            metaRobots,
            h1Count,
        };
        page.bodyHash = bodyFingerprint(page);
        page.metadataHash = metadataFingerprint(page);
        page.contentHash = contentFingerprint(page);

        const datasetItem = {
            url: page.url,
            title: page.title,
            description: page.description,
            contentChars: page.content.length,
            wordCount: page.wordCount,
            contentHash: page.contentHash,
            bodyHash: page.bodyHash,
            metadataHash: page.metadataHash,
            canonicalUrl: page.canonicalUrl,
            metaRobots: page.metaRobots,
            h1Count: page.h1Count,
        };

        await enqueueLinks({
            strategy: 'same-domain',
            transformRequestFunction: (nextRequest) => {
                if (!isSameSite(nextRequest.url)) return false;
                if (!isAllowedByRobots(nextRequest.url)) return false;
                if (nextRequest.url.length > PAYLOAD_LIMITS.urlChars) return false;
                if (/\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|css|js|mjs|mp4|mp3|woff2?|ttf)(\?|#|$)/i.test(nextRequest.url)) {
                    return false;
                }
                nextRequest.url = normalizeUrl(nextRequest.url);
                return nextRequest;
            },
        });

        const committed = await commitPaidPage(normalizedUrl, page, datasetItem);
        if (!committed) claimedUrls.delete(normalizedUrl);
        } catch (error) {
            if (!pagesByUrl.has(normalizedUrl)) claimedUrls.delete(normalizedUrl);
            throw error;
        }
    },
    failedRequestHandler({ request }) {
        failedRequests += 1;
        log.warning(`Failed after retries: ${request.url}`);
    },
});

const startRequests = [start.toString()];
log.info('Using bounded same-site link discovery; sitemap availability is reported but external sitemap trees are not fetched.');

log.info(`Crawling ${start} (maximum ${maxPages} visible page results)…`);
await crawler.run(startRequests);

const pages = [...pagesByUrl.values()].sort((a, b) => {
    const aIsStart = normalizeUrl(a.url) === normalizeUrl(start);
    const bIsStart = normalizeUrl(b.url) === normalizeUrl(start);
    if (aIsStart !== bIsStart) return aIsStart ? -1 : 1;
    return a.url.localeCompare(b.url);
});

if (pages.length === 0) {
    await Actor.setValue('OUTPUT', {
        error: chargeLimitReached
            ? 'The spending limit was reached before a page result could be delivered.'
            : 'No public pages could be processed. Check the URL, robots.txt policy, and site accessibility.',
        chargeLimitReached,
        failedRequests,
    });
    await Actor.exit({ exitCode: 1 });
}

const rootPage = pages.find((page) => normalizeUrl(page.url) === normalizeUrl(start)) ?? pages[0];
const siteTitle = rootPage.title || host;
const siteDescription = rootPage.description || `Public content index for ${host}.`;

let llmsText = `# ${escapeMarkdown(siteTitle)}\n\n> ${escapeMarkdown(siteDescription)}\n\n## Pages\n`;
for (const page of pages) {
    llmsText += `- [${escapeMarkdown(page.title)}](${page.url})${page.description ? `: ${escapeMarkdown(page.description)}` : ''}\n`;
}
await Actor.setValue('llms.txt', llmsText, { contentType: 'text/plain; charset=utf-8' });

if (includeFullText) {
    let fullText = `# ${escapeMarkdown(siteTitle)}\n\n> ${escapeMarkdown(siteDescription)}\n`;
    for (const page of pages) {
        fullText += `\n\n---\n\n# ${escapeMarkdown(page.title)}\nSource: ${page.url}\n\n${page.content}\n`;
    }
    await Actor.setValue('llms-full.txt', fullText, { contentType: 'text/plain; charset=utf-8' });
}

const manifest = buildManifest(pages, {
    generatedAt,
    site: host,
    startUrl: normalizeUrl(start),
    maxPages,
    discoveryMode,
    maxContentCharsPerPage,
    respectRobotsTxt,
    fingerprintVersion: 2,
});
manifest.readiness = {
    robotsTxt: robotsProbe,
    existingLlmsTxt: llmsProbe,
    sitemap: sitemapProbe,
    crawlerRespectedRobotsTxt: respectRobotsTxt,
};
manifest.crawl = {
    failedRequests,
    chargeLimitReached,
    budgetBoundaryReached,
    contentLimitReached,
    deliveredContentChars,
    estimatedDeliveredPayloadChars,
    deliveredPayloadLimitChars: maxDeliveredPayloadChars,
};
manifest.issues = buildReadinessIssues(manifest);
manifest.issueCount = manifest.issues.length;

let changes = {
    schemaVersion: 1,
    trackingEnabled: false,
    firstRun: null,
    previousGeneratedAt: null,
    currentGeneratedAt: manifest.generatedAt,
    summary: {
        added: 0,
        changed: 0,
        unchanged: 0,
        removedCandidates: 0,
        severityCounts: { high: 0, medium: 0, low: 0 },
    },
    added: [],
    changed: [],
    unchanged: [],
    removedCandidates: [],
    hasChanges: null,
    hasHighSeverityChanges: null,
    note: 'Change tracking was disabled for this run.',
};
let historyRecordKey;
let baselineEligible = false;
if (trackChanges) {
    const trackingIdentity = JSON.stringify({
        origin: start.origin,
        startUrl: normalizeUrl(start),
        maxPages,
        discoveryMode,
        maxContentCharsPerPage,
        respectRobotsTxt,
        fingerprintVersion: manifest.fingerprintVersion,
    });
    historyRecordKey = baselineRecordKey(trackingIdentity);
    const previousManifest = await historyStore.getValue(historyRecordKey);
    changes = compareManifests(previousManifest, manifest);
    changes.coverageComparable = Boolean(
        previousManifest &&
        previousManifest.maxPages === manifest.maxPages &&
        previousManifest.discoveryMode === manifest.discoveryMode &&
        previousManifest.startUrl === manifest.startUrl &&
        previousManifest.maxContentCharsPerPage === manifest.maxContentCharsPerPage &&
        previousManifest.respectRobotsTxt === manifest.respectRobotsTxt &&
        previousManifest.fingerprintVersion === manifest.fingerprintVersion &&
        !budgetBoundaryReached &&
        !contentLimitReached &&
        failedRequests === 0,
    );
    changes.hasChanges = Boolean(
        !changes.firstRun &&
        (changes.summary.added > 0 ||
            changes.summary.changed > 0 ||
            (changes.coverageComparable && changes.summary.removedCandidates > 0)),
    );
    changes.hasHighSeverityChanges = Boolean(!changes.firstRun && changes.summary.severityCounts.high > 0);
    if (!changes.coverageComparable && !changes.firstRun) {
        changes.note += ' Crawl settings or coverage changed, so removed candidates are not directly comparable.';
    }
    baselineEligible =
        (!previousManifest || changes.coverageComparable) &&
        !budgetBoundaryReached &&
        !contentLimitReached &&
        failedRequests === 0;
}

await Actor.setValue('manifest.json', JSON.stringify(manifest, null, 2), { contentType: 'application/json; charset=utf-8' });
await Actor.setValue('changes.json', JSON.stringify(changes, null, 2), { contentType: 'application/json; charset=utf-8' });

const files = ['llms.txt', ...(includeFullText ? ['llms-full.txt'] : []), 'manifest.json', 'changes.json'];
const runOutput = {
    site: host,
    pagesProcessed: pages.length,
    files,
    changes: changes.summary,
    hasChanges: changes.hasChanges,
    hasHighSeverityChanges: changes.hasHighSeverityChanges,
    readinessIssueCount: manifest.issueCount,
    firstTrackedRun: changes.firstRun,
    baselineUpdateEligible: baselineEligible,
    failedRequests,
    chargeLimitReached,
    budgetBoundaryReached,
    contentLimitReached,
    deliveredContentChars,
    estimatedDeliveredPayloadChars,
    deliveredPayloadLimitChars: maxDeliveredPayloadChars,
    note: 'Download files from the Output or Storage tab. Schedule the same input to detect added and changed pages over time.',
};
await Actor.setValue('OUTPUT', runOutput);

if (baselineEligible) {
    await historyStore.setValue(historyRecordKey, manifest);
    log.info('Change baseline committed after all user-visible outputs were saved.');
}

log.info(`Done. ${pages.length} paid page result(s); ${changes.summary.changed} changed and ${changes.summary.added} added.`);
await Actor.exit();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await runActor();
}

