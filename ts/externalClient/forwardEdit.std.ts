// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { SendFormattingType, SendMentionType } from './protocol.std.ts';
import { MENTION_PLACEHOLDER } from './protocol.std.ts';

export type EditedTextType = Readonly<{
  body: string;
  mentions: ReadonlyArray<SendMentionType>;
  formatting: ReadonlyArray<SendFormattingType>;
}>;

// Fork addition (decision F32): a forward's edited text for one chat.
// Mentions of the chat's members stay mentions; anyone else's becomes
// "@Name" text, and the styles move to match. Undefined when a mention is
// not at a placeholder.
export function rewriteForChat(
  edit: EditedTextType,
  isMember: (conversationId: string) => boolean,
  titleOf: (conversationId: string) => string
): EditedTextType | undefined {
  const byStart = new Map(edit.mentions.map(m => [m.start, m]));
  if (edit.mentions.some(m => edit.body[m.start] !== MENTION_PLACEHOLDER)) {
    return undefined;
  }
  const mentions: Array<SendMentionType> = [];
  // shift[i]: how far original position i moved.
  const shift = new Array<number>(edit.body.length + 1).fill(0);
  let body = '';
  let added = 0;
  for (let i = 0; i < edit.body.length; i += 1) {
    shift[i] = added;
    const mention = byStart.get(i);
    if (!mention) {
      body += edit.body[i];
    } else if (isMember(mention.conversationId)) {
      mentions.push({ ...mention, start: i + added });
      body += MENTION_PLACEHOLDER;
    } else {
      const text = `@${titleOf(mention.conversationId)}`;
      body += text;
      added += text.length - 1;
    }
  }
  shift[edit.body.length] = added;
  const formatting = edit.formatting.map(range => {
    const startAt = Math.min(range.start, edit.body.length);
    const endAt = Math.min(range.start + range.length, edit.body.length);
    const start = startAt + (shift[startAt] ?? added);
    return { ...range, start, length: endAt + (shift[endAt] ?? added) - start };
  });
  return { body, mentions, formatting };
}
