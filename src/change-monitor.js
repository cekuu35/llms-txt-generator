import { createHash } from 'node:crypto';
import { lookup as dnsLookupCallback } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const PRIVATE_IPV4_RANGES = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
];

const BLOCKED_IPS = new BlockList();
for (const [base, prefix] of PRIVATE_IPV4_RANGES) BLOCKED_IPS.addSubnet(base, prefix, 'ipv4');
BLOCKED_IPS.addSubnet('::', 128, 'ipv6');
BLOCKED_IPS.addSubnet('::1', 128, 'ipv6');
BLOCKED_IPS.addSubnet('fc00::', 7, 'ipv6');
BLOCKED_IPS.addSubnet('fe80::', 10, 'ipv6');
BLOCKED_IPS.addSubnet('ff00::', 8, 'ipv6');
BLOCKED_IPS.addSubnet('2001:db8::', 32, 'ipv6');

export function isBlockedIpAddress(value) {
    const ipVersion = isIP(value);
    if (!ipVersion) return false;
    return BLOCKED_IPS.check(value, ipVersion === 6 ? 'ipv6' : 'ipv4');
}

export function validatePublicHttpUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('websiteUrl must be a valid absolute URL.');
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('websiteUrl must use http or https.');
    }
    if (url.username || url.password) {
        throw new Error('websiteUrl must not contain embedded credentials.');
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
        throw new Error('Local network targets are not allowed.');
    }

    if (isBlockedIpAddress(hostname)) {
        throw new Error('Private, loopback, link-local, multicast, and reserved IP targets are not allowed.');
    }

    url.hash = '';
    return url;
}

export async function assertPublicResolvedUrl(value) {
    const url = validatePublicHttpUrl(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostname)) return url;

    const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
    if (!addresses.length) throw new Error(`DNS returned no addresses for ${hostname}.`);
    const blocked = addresses.find(({ address }) => isBlockedIpAddress(address));
    if (blocked) throw new Error(`DNS for ${hostname} resolved to a non-public address.`);
    return url;
}

export function publicDnsLookup(hostname, options, callback) {
    let done = callback;
    let normalizedOptions;
    if (typeof options === 'function') {
        done = options;
        normalizedOptions = {};
    } else {
        normalizedOptions = typeof options === 'number' ? { family: options } : { ...(options ?? {}) };
    }
    dnsLookupCallback(hostname, { ...normalizedOptions, all: true, verbatim: true }, (error, addresses) => {
        if (error) {
            done(error);
            return;
        }
        const records = Array.isArray(addresses) ? addresses : [addresses];
        if (!records.length || records.some(({ address }) => isBlockedIpAddress(address))) {
            done(new Error(`DNS for ${hostname} resolved to a non-public address.`));
            return;
        }
        if (normalizedOptions.all) done(null, records);
        else done(null, records[0].address, records[0].family);
    });
}

export function applyPublicRequestPolicy(options) {
    options.dnsLookup = publicDnsLookup;
    options.http2 = false;
    // got-scraping's header generator performs a separate HTTPS ALPN probe.
    // Disabling it ensures every network connection uses the guarded lookup.
    options.useHeaderGenerator = false;
    if (options.context && typeof options.context === 'object') {
        options.context.useHeaderGenerator = false;
    }
    return options;
}

export function normalizeUrl(value) {
    const url = new URL(value);
    url.hash = '';
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
}

export function contentFingerprint(page) {
    return createHash('sha256')
        .update(`${bodyFingerprint(page)}\n${metadataFingerprint(page)}`, 'utf8')
        .digest('hex');
}

export function bodyFingerprint(page) {
    const normalized = String(page.content ?? '').replace(/\s+/g, ' ').trim();
    return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function metadataFingerprint(page) {
    const normalized = [page.title, page.description, page.canonicalUrl, page.metaRobots, page.h1Count]
        .map((part) => String(part ?? '').replace(/\s+/g, ' ').trim())
        .join('\n');
    return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function buildManifest(pages, context = {}) {
    const manifestPages = [...pages]
        .map((page) => ({
            url: normalizeUrl(page.url),
            title: page.title,
            description: page.description,
            contentChars: page.content.length,
            wordCount: page.wordCount,
            contentHash: page.contentHash || contentFingerprint(page),
            bodyHash: page.bodyHash || bodyFingerprint(page),
            metadataHash: page.metadataHash || metadataFingerprint(page),
            canonicalUrl: page.canonicalUrl,
            metaRobots: page.metaRobots,
            h1Count: page.h1Count,
        }))
        .sort((a, b) => a.url.localeCompare(b.url));

    return {
        schemaVersion: 1,
        generatedAt: context.generatedAt ?? new Date().toISOString(),
        site: context.site,
        startUrl: context.startUrl,
        maxPages: context.maxPages,
        discoveryMode: context.discoveryMode,
        maxContentCharsPerPage: context.maxContentCharsPerPage,
        respectRobotsTxt: context.respectRobotsTxt,
        fingerprintVersion: context.fingerprintVersion ?? 2,
        pagesProcessed: manifestPages.length,
        pages: manifestPages,
    };
}

export function compareManifests(previous, current) {
    const previousPages = new Map((previous?.pages ?? []).map((page) => [normalizeUrl(page.url), page]));
    const currentPages = new Map((current?.pages ?? []).map((page) => [normalizeUrl(page.url), page]));

    const added = [];
    const changed = [];
    const unchanged = [];
    const removedCandidates = [];

    for (const [url, page] of currentPages) {
        const oldPage = previousPages.get(url);
        if (!oldPage) {
            added.push({ url, title: page.title });
        } else if (oldPage.contentHash !== page.contentHash) {
            const changeKinds = [];
            if (!oldPage.bodyHash || oldPage.bodyHash !== page.bodyHash) changeKinds.push('content');
            if (!oldPage.metadataHash || oldPage.metadataHash !== page.metadataHash) changeKinds.push('metadata');
            if (oldPage.title !== page.title) changeKinds.push('title');
            if (oldPage.description !== page.description) changeKinds.push('description');
            if (oldPage.canonicalUrl !== page.canonicalUrl) changeKinds.push('canonical');
            if (oldPage.metaRobots !== page.metaRobots) changeKinds.push('metaRobots');
            if (oldPage.h1Count !== page.h1Count) changeKinds.push('h1Count');

            const becameNoindex =
                oldPage.metaRobots !== page.metaRobots &&
                /(?:^|[,\s])noindex(?:$|[,\s])/i.test(page.metaRobots ?? '');
            const severity = becameNoindex
                ? 'high'
                : changeKinds.some((kind) => ['title', 'canonical', 'metaRobots'].includes(kind))
                    ? 'medium'
                    : 'low';
            changed.push({
                url,
                title: page.title,
                previousHash: oldPage.contentHash,
                currentHash: page.contentHash,
                changeKinds: [...new Set(changeKinds)],
                severity,
            });
        } else {
            unchanged.push({ url, title: page.title });
        }
    }

    for (const [url, page] of previousPages) {
        if (!currentPages.has(url)) removedCandidates.push({ url, title: page.title });
    }

    const firstRun = !previous;
    const severityCounts = {
        high: changed.filter((page) => page.severity === 'high').length,
        medium: changed.filter((page) => page.severity === 'medium').length,
        low: changed.filter((page) => page.severity === 'low').length,
    };

    return {
        schemaVersion: 1,
        trackingEnabled: true,
        firstRun,
        previousGeneratedAt: previous?.generatedAt ?? null,
        currentGeneratedAt: current.generatedAt,
        summary: {
            added: added.length,
            changed: changed.length,
            unchanged: unchanged.length,
            removedCandidates: removedCandidates.length,
            severityCounts,
        },
        added,
        changed,
        unchanged,
        removedCandidates,
        hasChanges: firstRun ? false : added.length > 0 || changed.length > 0,
        hasHighSeverityChanges: firstRun ? false : severityCounts.high > 0,
        note: 'removedCandidates are URLs present in the previous comparable crawl but absent now. Confirm before treating them as deleted.',
    };
}

export function buildReadinessIssues(manifest) {
    const issues = [];
    const pages = manifest.pages ?? [];
    const add = (id, severity, message, action, affectedUrls = []) => {
        issues.push({ id, severity, message, action, affectedCount: affectedUrls.length, affectedUrls: affectedUrls.slice(0, 20) });
    };

    if (!manifest.readiness?.existingLlmsTxt?.found) {
        add(
            'llms_txt_missing',
            'high',
            'No public /llms.txt file was found before this run.',
            'Review the generated llms.txt, then publish the approved file at the site root.',
        );
    }
    if (!manifest.readiness?.sitemap?.found && manifest.discoveryMode !== 'sitemap') {
        add(
            'sitemap_missing',
            'medium',
            'No usable sitemap was found, so coverage depends on discoverable links.',
            'Publish a current sitemap.xml or provide a site structure where important pages are linked.',
        );
    }

    const missingDescriptions = pages.filter((page) => !page.description).map((page) => page.url);
    if (missingDescriptions.length) {
        add('meta_description_missing', 'medium', 'Some processed pages have no meta description.', 'Add a concise, page-specific meta description.', missingDescriptions);
    }
    const missingCanonicals = pages.filter((page) => !page.canonicalUrl).map((page) => page.url);
    if (missingCanonicals.length) {
        add('canonical_missing', 'medium', 'Some processed pages have no canonical URL.', 'Add a correct self-referencing or preferred canonical URL.', missingCanonicals);
    }
    const h1Issues = pages.filter((page) => page.h1Count !== 1).map((page) => page.url);
    if (h1Issues.length) {
        add('h1_count_unexpected', 'medium', 'Some processed pages do not have exactly one H1 heading.', 'Review heading structure and keep one clear primary H1 where appropriate.', h1Issues);
    }
    const noindexPages = pages.filter((page) => /(?:^|[,\s])noindex(?:$|[,\s])/i.test(page.metaRobots ?? '')).map((page) => page.url);
    if (noindexPages.length) {
        add('meta_noindex', 'high', 'Some processed pages declare noindex.', 'Confirm that noindex is intentional for each affected page.', noindexPages);
    }
    const thinPages = pages.filter((page) => page.wordCount < 100).map((page) => page.url);
    if (thinPages.length) {
        add('thin_extracted_content', 'low', 'Some pages exposed fewer than 100 words to the HTTP-first extractor.', 'Confirm the page is intentionally short or check whether key content requires JavaScript rendering.', thinPages);
    }

    return issues;
}

export function baselineRecordKey(origin) {
    return `SITE_${createHash('sha256').update(origin).digest('hex').slice(0, 32)}`;
}

export function escapeMarkdown(value) {
    return String(value ?? '').replace(/([\\[\]])/g, '\\$1').replace(/\r?\n/g, ' ').trim();
}

