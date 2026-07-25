import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import test from 'node:test';
import {
    PAYLOAD_LIMITS,
    boundedCanonicalUrl,
    createBodyLimitedHttpClient,
    estimateDeliveredPageChars,
    truncateWithEllipsis,
} from '../src/main.js';

test('metadata truncation is deterministic and never exceeds its character cap', () => {
    assert.equal(truncateWithEllipsis('short', 5), 'short');
    assert.equal(truncateWithEllipsis('abcdef', 5), 'abcd…');
    assert.equal(truncateWithEllipsis('abcdef', 1), 'a');

    const title = truncateWithEllipsis('x'.repeat(500), PAYLOAD_LIMITS.titleChars);
    const description = truncateWithEllipsis('y'.repeat(2000), PAYLOAD_LIMITS.descriptionChars);
    const metaRobots = truncateWithEllipsis('z'.repeat(500), PAYLOAD_LIMITS.metaRobotsChars);
    assert.equal(title.length, PAYLOAD_LIMITS.titleChars);
    assert.equal(description.length, PAYLOAD_LIMITS.descriptionChars);
    assert.equal(metaRobots.length, PAYLOAD_LIMITS.metaRobotsChars);
});

test('canonical URLs are resolved only when valid and within the deterministic cap', () => {
    assert.equal(boundedCanonicalUrl('/docs', 'https://example.com/start'), 'https://example.com/docs');
    assert.equal(boundedCanonicalUrl('http://[', 'https://example.com/start'), null);
    assert.equal(
        boundedCanonicalUrl(`https://example.com/${'x'.repeat(PAYLOAD_LIMITS.canonicalChars)}`, 'https://example.com/'),
        null,
    );
});

test('delivered payload estimate includes content and every bounded metadata field', () => {
    const page = {
        url: 'https://example.com/a',
        title: 'Title',
        description: 'Description',
        content: 'Body',
        canonicalUrl: 'https://example.com/a',
        metaRobots: 'index, follow',
    };
    const first = estimateDeliveredPageChars(page);
    assert.equal(first, estimateDeliveredPageChars({ ...page }));
    assert.equal(estimateDeliveredPageChars({ ...page, content: `${page.content}x` }), first + 1);
    assert.equal(estimateDeliveredPageChars({ ...page, url: `${page.url}x` }), first + 52);
    assert.equal(estimateDeliveredPageChars({ ...page, title: `${page.title}x` }), first + 24);
    assert.equal(estimateDeliveredPageChars({ ...page, description: `${page.description}x` }), first + 20);
    assert.equal(estimateDeliveredPageChars({ ...page, canonicalUrl: `${page.canonicalUrl}x` }), first + 12);
    assert.equal(estimateDeliveredPageChars({ ...page, metaRobots: `${page.metaRobots}x` }), first + 12);
});

test('raw response limiter accepts the byte boundary and rejects the first byte over it', async () => {
    const makeBaseClient = (body) => ({
        async sendRequest() {
            return { body };
        },
        async stream() {
            return {
                stream: Readable.from([Buffer.from(body)]),
                statusCode: 200,
                headers: { 'content-type': 'text/html' },
                url: 'https://example.com/',
            };
        },
    });

    const exactClient = createBodyLimitedHttpClient(4, makeBaseClient('éé'));
    const exactResponse = await exactClient.stream({ url: 'https://example.com/' });
    assert.equal(await text(exactResponse.stream), 'éé');
    assert.equal((await exactClient.sendRequest({ url: 'https://example.com/' })).body, 'éé');

    const oversizedClient = createBodyLimitedHttpClient(4, makeBaseClient('ééa'));
    const oversizedResponse = await oversizedClient.stream({ url: 'https://example.com/' });
    await assert.rejects(text(oversizedResponse.stream), /4-byte safety limit/);
    await assert.rejects(oversizedClient.sendRequest({ url: 'https://example.com/' }), /4-byte safety limit/);
});

