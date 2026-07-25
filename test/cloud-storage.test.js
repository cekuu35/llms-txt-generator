import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CHANGE_HISTORY_STORE_NAME } from '../src/main.js';

test('change-history storage uses an Apify-compatible stable name', async () => {
    assert.equal(CHANGE_HISTORY_STORE_NAME, 'llms-txt-generator-change-history');
    assert.ok(CHANGE_HISTORY_STORE_NAME.length <= 63);
    assert.match(CHANGE_HISTORY_STORE_NAME, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);

    const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
    assert.match(source, /Actor\.openKeyValueStore\(CHANGE_HISTORY_STORE_NAME\)/);
    assert.doesNotMatch(source, /LLMS_TXT_CHANGE_HISTORY/);
    assert.ok(source.indexOf('Actor.openKeyValueStore') < source.indexOf('await crawler.run'));
});

