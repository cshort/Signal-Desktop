// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// "Reply privately" links (decision F23). Signal only links a quote to a
// message in the same chat, so the helper remembers which direct-chat reply
// answered which group message, for the page to link both ways. Only
// replies sent from this page are known. Kept in the config folder.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const MAX_ENTRIES = 5000;

export class PrivateReplies {
  #file;
  #entries = [];

  constructor(file) {
    this.#file = file;
    if (file && existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(parsed)) {
          this.#entries = parsed.filter(isEntry);
        }
      } catch {
        this.#entries = [];
      }
    }
  }

  add(entry) {
    if (!isEntry(entry)) {
      return;
    }
    this.#entries = [
      ...this.#entries.filter(e => e.replyMessageId !== entry.replyMessageId),
      entry,
    ].slice(-MAX_ENTRIES);
    if (this.#file) {
      const temp = `${this.#file}.tmp`;
      writeFileSync(temp, JSON.stringify(this.#entries), { mode: 0o600 });
      renameSync(temp, this.#file);
    }
  }

  // Entries where this chat is the group or the direct chat.
  forConversation(conversationId) {
    return this.#entries.filter(
      e =>
        e.groupConversationId === conversationId ||
        e.dmConversationId === conversationId
    );
  }
}

function isEntry(e) {
  return (
    e != null &&
    typeof e === 'object' &&
    [
      'groupConversationId',
      'groupMessageId',
      'dmConversationId',
      'replyMessageId',
    ].every(
      key =>
        typeof e[key] === 'string' && e[key].length > 0 && e[key].length <= 128
    )
  );
}
