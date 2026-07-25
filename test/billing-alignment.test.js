import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DEFAULT_DATASET_BILLING_EVENT } from '../src/main.js';

test('dataset delivery stays aligned with the live synthetic billing event', async () => {
    assert.equal(DEFAULT_DATASET_BILLING_EVENT, 'apify-default-dataset-item');

    const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
    assert.match(source, /await Actor\.pushData\(datasetItem\);/);
    assert.doesNotMatch(source, /Actor\.pushData\(datasetItem,\s*['"]/);
    assert.match(
        source,
        /calculateMaxEventChargeCountWithinLimit\(DEFAULT_DATASET_BILLING_EVENT\)/,
    );
});

