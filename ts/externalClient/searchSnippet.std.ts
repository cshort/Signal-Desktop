// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import {
  SNIPPET_LEFT_PLACEHOLDER,
  SNIPPET_RIGHT_PLACEHOLDER,
  SNIPPET_TRUNCATION_PLACEHOLDER,
} from '../util/search.std.ts';
import type { TextRangeDTO } from './protocol.std.ts';

// Fork addition (decision F17).

const MARKER = new RegExp(
  `${SNIPPET_LEFT_PLACEHOLDER}|${SNIPPET_RIGHT_PLACEHOLDER}`,
  'g'
);

// Signal's snippet is a piece of the body with the matches marked. Finds
// that piece in the body, so the client can show it with the message's own
// mentions and formatting.
export function locateSnippet(
  body: string,
  snippet: string
): { snippet: TextRangeDTO; highlights: Array<TextRangeDTO> } | null {
  const marked = snippet
    .replace(new RegExp(`^${SNIPPET_TRUNCATION_PLACEHOLDER}`), '')
    .replace(new RegExp(`${SNIPPET_TRUNCATION_PLACEHOLDER}$`), '');
  let plain = '';
  let openedAt: number | null = null;
  const relative = new Array<TextRangeDTO>();
  let index = 0;
  for (const match of marked.matchAll(MARKER)) {
    plain += marked.slice(index, match.index);
    index = match.index + match[0].length;
    if (match[0] === SNIPPET_LEFT_PLACEHOLDER) {
      openedAt = plain.length;
    } else if (openedAt != null) {
      if (plain.length > openedAt) {
        relative.push({ start: openedAt, length: plain.length - openedAt });
      }
      openedAt = null;
    }
  }
  plain += marked.slice(index);
  const start = body.indexOf(plain);
  if (start === -1 || plain.length === 0) {
    return null;
  }
  return {
    snippet: { start, length: plain.length },
    highlights: relative.map(range => ({
      start: start + range.start,
      length: range.length,
    })),
  };
}
