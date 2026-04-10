import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockDetailHref,
  cursorFromSearchParams,
  parseBlockHeightParam,
} from './app/lib/block-routes';

test('cursorFromSearchParams accepts only direct string cursor values', () => {
  assert.equal(cursorFromSearchParams({ cursor: '42' }), '42');
  assert.equal(cursorFromSearchParams({ cursor: ['42'] }), undefined);
  assert.equal(cursorFromSearchParams({ cursor: undefined }), undefined);
  assert.equal(cursorFromSearchParams({}), undefined);
});

test('list to detail href preserves exact block height route parameter', () => {
  const heights = [0, 1, 19, 512];

  for (const height of heights) {
    const href = blockDetailHref(height);
    const routeParam = href.split('/').at(-1);

    assert.equal(routeParam, String(height));
    assert.equal(parseBlockHeightParam(routeParam ?? ''), height);
  }
});

test('parseBlockHeightParam rejects invalid route params', () => {
  assert.equal(parseBlockHeightParam('-1'), null);
  assert.equal(parseBlockHeightParam('1.5'), null);
  assert.equal(parseBlockHeightParam('abc'), null);
});
