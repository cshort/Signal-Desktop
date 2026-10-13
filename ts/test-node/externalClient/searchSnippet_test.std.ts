// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import { locateSnippet } from '../../externalClient/searchSnippet.std.ts';

describe('externalClient/searchSnippet', () => {
  it('places a full-text snippet and its matches in the body', () => {
    const body = 'We should meet for lunch on Friday, lunch is on me';
    assert.deepEqual(
      locateSnippet(
        body,
        '<<truncation>>meet for <<left>>lunch<<right>> on Friday, <<left>>lunch<<right>> is<<truncation>>'
      ),
      {
        snippet: { start: 10, length: 34 },
        highlights: [
          { start: 19, length: 5 },
          { start: 36, length: 5 },
        ],
      }
    );
  });

  it('keeps mention placeholders in body positions', () => {
    const body = 'hey ￼ look';
    assert.deepEqual(locateSnippet(body, 'hey <<left>>￼<<right>> look'), {
      snippet: { start: 0, length: 10 },
      highlights: [{ start: 4, length: 1 }],
    });
  });

  it('returns null when the snippet is not in the body', () => {
    assert.isNull(locateSnippet('something else', '<<left>>lunch<<right>>'));
  });
});
