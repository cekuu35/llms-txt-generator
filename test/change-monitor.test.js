import assert from 'node:assert/strict';
import test from 'node:test';
import {
    baselineRecordKey,
    buildManifest,
    buildReadinessIssues,
    compareManifests,
    contentFingerprint,
    escapeMarkdown,
    isBlockedIpAddress,
    normalizeUrl,
    validatePublicHttpUrl,
} from '../src/change-monitor.js';

test('accepts public HTTP(S) URLs and normalizes fragments', () => {
    assert.equal(validatePublicHttpUrl('https://example.com/docs#top').toString(), 'https://example.com/docs');
    assert.equal(normalizeUrl('https://example.com/docs/?b=2&a=1#top'), 'https://example.com/docs?a=1&b=2');
});

test('rejects non-HTTP, credentialed, local, private, and reserved targets', () => {
    const rejected = [
        'file:///etc/passwd',
        'https://user:pass@example.com',
        'http://localhost:3000',
        'http://app.local',
        'http://127.0.0.1',
        'http://10.1.2.3',
        'http://172.16.2.3',
        'http://192.168.1.2',
        'http://169.254.169.254',
        'http://[::1]',
        'http://[fd00::1]',
        'http://[::ffff:127.0.0.1]',
        'http://[::ffff:10.0.0.1]',
        'http://[::ffff:169.254.169.254]',
    ];
    for (const value of rejected) assert.throws(() => validatePublicHttpUrl(value), undefined, value);
    assert.equal(isBlockedIpAddress('::ffff:7f00:1'), true);
    assert.equal(isBlockedIpAddress('2606:4700:4700::1111'), false);
});

test('content fingerprints are stable across whitespace but change with content', () => {
    const first = contentFingerprint({ title: 'A', description: 'B', content: 'Hello   world' });
    const same = contentFingerprint({ title: 'A', description: 'B', content: 'Hello world' });
    const changed = contentFingerprint({ title: 'A', description: 'B', content: 'Hello universe' });
    const metadataChanged = contentFingerprint({
        title: 'A',
        description: 'B',
        content: 'Hello world',
        canonicalUrl: 'https://example.com/preferred',
    });
    assert.equal(first, same);
    assert.notEqual(first, changed);
    assert.notEqual(first, metadataChanged);
});

test('manifest comparison reports added, changed, unchanged, and removal candidates', () => {
    const previous = {
        generatedAt: '2026-07-24T00:00:00.000Z',
        pages: [
            { url: 'https://example.com/', title: 'Home', contentHash: 'a' },
            { url: 'https://example.com/old', title: 'Old', contentHash: 'b' },
            { url: 'https://example.com/same', title: 'Same', contentHash: 'c' },
        ],
    };
    const current = {
        generatedAt: '2026-07-25T00:00:00.000Z',
        pages: [
            { url: 'https://example.com/', title: 'Home', contentHash: 'z' },
            { url: 'https://example.com/new', title: 'New', contentHash: 'n' },
            { url: 'https://example.com/same', title: 'Same', contentHash: 'c' },
        ],
    };
    const result = compareManifests(previous, current);
    assert.deepEqual(result.summary, {
        added: 1,
        changed: 1,
        unchanged: 1,
        removedCandidates: 1,
        severityCounts: { high: 0, medium: 0, low: 1 },
    });
    assert.equal(result.added[0].url, 'https://example.com/new');
    assert.equal(result.changed[0].url, 'https://example.com/');
    assert.deepEqual(result.changed[0].changeKinds, ['content', 'metadata']);
    assert.equal(result.changed[0].severity, 'low');
    assert.equal(result.removedCandidates[0].url, 'https://example.com/old');
});

test('manifest sorting, record keys, and Markdown escaping are deterministic', () => {
    const pages = [
        { url: 'https://example.com/b', title: 'B', description: '', content: 'two', wordCount: 1 },
        { url: 'https://example.com/a', title: 'A', description: '', content: 'one', wordCount: 1 },
    ];
    const manifest = buildManifest(pages, {
        generatedAt: '2026-07-25T00:00:00.000Z',
        site: 'example.com',
        startUrl: 'https://example.com/',
        maxPages: 10,
        discoveryMode: 'sitemap',
        maxContentCharsPerPage: 12000,
        respectRobotsTxt: true,
        fingerprintVersion: 1,
    });
    assert.deepEqual(manifest.pages.map((page) => page.url), ['https://example.com/a', 'https://example.com/b']);
    assert.equal(baselineRecordKey('https://example.com'), baselineRecordKey('https://example.com'));
    assert.match(baselineRecordKey('https://example.com'), /^SITE_[a-f0-9]{32}$/);
    assert.notEqual(
        baselineRecordKey('{"origin":"https://example.com","startUrl":"https://example.com/docs"}'),
        baselineRecordKey('{"origin":"https://example.com","startUrl":"https://example.com/blog"}'),
    );
    assert.equal(escapeMarkdown('A [link]\\name\nnext'), 'A \\[link\\]\\\\name next');
});

test('readiness issues are deterministic and point to affected pages', () => {
    const manifest = {
        discoveryMode: 'links',
        readiness: { existingLlmsTxt: { found: false }, sitemap: { found: false } },
        pages: [
            {
                url: 'https://example.com/',
                description: '',
                canonicalUrl: null,
                h1Count: 0,
                metaRobots: 'noindex, follow',
                wordCount: 20,
            },
        ],
    };
    const issues = buildReadinessIssues(manifest);
    assert.deepEqual(
        issues.map((issue) => issue.id),
        ['llms_txt_missing', 'sitemap_missing', 'meta_description_missing', 'canonical_missing', 'h1_count_unexpected', 'meta_noindex', 'thin_extracted_content'],
    );
    assert.equal(issues.find((issue) => issue.id === 'meta_noindex').affectedUrls[0], 'https://example.com/');
});

