// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import { rewriteForChat } from '../../externalClient/forwardEdit.std.ts';

const P = '￼';
const titles: Record<string, string> = { ann: 'Ann Lee', bob: 'Bob' };
const titleOf = (id: string) => titles[id] ?? 'Someone';

describe('externalClient/forwardEdit', () => {
  // "hi @Ann and @Bob!" with Bob bold through the "!".
  const edit = {
    body: `hi ${P} and ${P}!`,
    mentions: [
      { start: 3, conversationId: 'ann' },
      { start: 9, conversationId: 'bob' },
    ],
    formatting: [{ start: 9, length: 2, style: 'bold' as const }],
  };

  it('keeps mentions of members as they are', () => {
    const out = rewriteForChat(edit, () => true, titleOf);
    assert.deepEqual(out, edit);
  });

  it('writes out mentions of non-members and moves styles', () => {
    const out = rewriteForChat(edit, id => id === 'bob', titleOf);
    assert.strictEqual(out?.body, `hi @Ann Lee and ${P}!`);
    assert.deepEqual(out?.mentions, [{ start: 16, conversationId: 'bob' }]);
    assert.deepEqual(out?.formatting, [
      { start: 16, length: 2, style: 'bold' },
    ]);
  });

  it('grows a style that covers a written-out mention', () => {
    const out = rewriteForChat(
      {
        body: `${P}!`,
        mentions: [{ start: 0, conversationId: 'ann' }],
        formatting: [{ start: 0, length: 2, style: 'italic' }],
      },
      () => false,
      titleOf
    );
    assert.strictEqual(out?.body, '@Ann Lee!');
    assert.deepEqual(out?.formatting, [
      { start: 0, length: 9, style: 'italic' },
    ]);
  });

  it('refuses a mention that is not at a placeholder', () => {
    assert.isUndefined(
      rewriteForChat(
        {
          body: 'hello',
          mentions: [{ start: 1, conversationId: 'ann' }],
          formatting: [],
        },
        () => true,
        titleOf
      )
    );
  });
});
