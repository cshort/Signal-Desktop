// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// Scheduled messages (decision F29). Signal Desktop has none, and Signal's
// protocol has no server-side scheduling (Android keeps them on the phone
// too), so the helper keeps them in its config folder and sends each one
// through Signal when its time comes. A message whose time passed while
// the helper or Signal was down goes out as soon as both are back, as on
// Android. Files wait in the folder until then.

import { randomUUID } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

export const MAX_SCHEDULED = 500;
export const MAX_SCHEDULED_FILE_BYTES = 100 * 1024 * 1024;
// Errors after which trying again cannot help: the message stays, marked
// failed, for the user to edit, send now or delete.
const PERMANENT = new Set([
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'PRECONDITION_FAILED',
  'PERMISSION_DENIED',
]);

const ID = /^[0-9a-f-]{36}$/;

export class ScheduledMessages {
  #dir;
  #file;
  #items = [];
  #timer = null;
  #sending = false;
  #send;
  #onChange;
  #log;

  // send(item) sends one message and returns its message; onChange() runs
  // after every change, for the page.
  constructor(dir, { send, onChange = () => {}, log = () => {} }) {
    this.#dir = dir;
    this.#file = dir ? join(dir, 'scheduled.json') : null;
    this.#send = send;
    this.#onChange = onChange;
    this.#log = log;
    if (this.#file && existsSync(this.#file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.#file, 'utf8'));
        if (Array.isArray(parsed)) {
          this.#items = parsed.filter(isItem);
        }
      } catch {
        this.#items = [];
      }
    }
  }

  list(conversationId) {
    return this.#items
      .filter(i => !conversationId || i.conversationId === conversationId)
      .sort((a, b) => a.sendAt - b.sendAt);
  }

  // Counts per chat, for the chat list.
  counts() {
    const counts = {};
    for (const i of this.#items) {
      counts[i.conversationId] = (counts[i.conversationId] ?? 0) + 1;
    }
    return counts;
  }

  add(fields) {
    if (this.#items.length >= MAX_SCHEDULED) {
      throw Object.assign(new Error('too many scheduled messages'), {
        code: 'INVALID_ARGUMENT',
      });
    }
    const item = clean({ ...fields, id: randomUUID(), failed: null });
    if (!item) {
      throw Object.assign(new Error('invalid scheduled message'), {
        code: 'INVALID_ARGUMENT',
      });
    }
    for (const f of item.files) {
      if (!existsSync(this.#filePath(f.fileId))) {
        throw Object.assign(new Error('file not found'), {
          code: 'INVALID_ARGUMENT',
        });
      }
    }
    this.#items.push(item);
    this.#changed();
    return item;
  }

  // New time (and, if given, new text); clears a failure.
  update(id, { sendAt, body }) {
    const item = this.#items.find(i => i.id === id);
    if (!item) {
      return null;
    }
    const next = clean({
      ...item,
      ...(sendAt !== undefined ? { sendAt } : {}),
      ...(body !== undefined
        ? { body, mentions: [], formatting: [], linkPreviewUrl: null }
        : {}),
      failed: null,
    });
    if (!next) {
      throw Object.assign(new Error('invalid scheduled message'), {
        code: 'INVALID_ARGUMENT',
      });
    }
    Object.assign(item, next);
    this.#changed();
    return item;
  }

  remove(id) {
    const item = this.#items.find(i => i.id === id);
    if (!item) {
      return false;
    }
    this.#items = this.#items.filter(i => i !== item);
    this.#deleteFiles(item);
    this.#changed();
    return true;
  }

  sendNow(id) {
    const item = this.#items.find(i => i.id === id);
    if (!item) {
      return false;
    }
    item.sendAt = Date.now();
    item.failed = null;
    this.#changed();
    return true;
  }

  // A file for a scheduled message, kept until it's sent or deleted.
  async saveFile(stream, { size, contentType, fileName }) {
    if (
      !this.#dir ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > MAX_SCHEDULED_FILE_BYTES ||
      !contentType
    ) {
      throw Object.assign(new Error('invalid file'), {
        code: 'INVALID_ARGUMENT',
      });
    }
    mkdirSync(join(this.#dir, 'scheduled-files'), {
      recursive: true,
      mode: 0o700,
    });
    const fileId = randomUUID();
    const path = this.#filePath(fileId);
    let written = 0;
    await pipeline(
      stream,
      async function* count(source) {
        for await (const chunk of source) {
          written += chunk.length;
          if (written > size) {
            throw Object.assign(new Error('file larger than stated'), {
              code: 'INVALID_ARGUMENT',
            });
          }
          yield chunk;
        }
      },
      createWriteStream(path, { mode: 0o600 })
    );
    if (written !== size) {
      rmSync(path, { force: true });
      throw Object.assign(new Error('file size mismatch'), {
        code: 'INVALID_ARGUMENT',
      });
    }
    return { fileId, size, contentType, fileName: fileName ?? null };
  }

  filePath(fileId) {
    return ID.test(fileId) ? this.#filePath(fileId) : null;
  }

  // Starts sending; call again whenever Signal is ready.
  start() {
    this.#schedule();
  }

  stop() {
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  // Sends everything due, one at a time.
  async run(ready = () => true) {
    if (this.#sending) {
      return;
    }
    this.#sending = true;
    try {
      for (;;) {
        const due = this.#items.find(i => !i.failed && i.sendAt <= Date.now());
        if (!due || !ready()) {
          break;
        }
        try {
          // oxlint-disable-next-line no-await-in-loop
          await this.#send(due);
          this.#items = this.#items.filter(i => i !== due);
          this.#deleteFiles(due);
          this.#log('sent a scheduled message');
        } catch (error) {
          if (!PERMANENT.has(error.code)) {
            // Signal is away: try again on the next tick.
            this.#log(`scheduled send waits: ${error.code ?? error.message}`);
            break;
          }
          due.failed = error.reason ?? error.code;
          this.#log(`scheduled send failed: ${due.failed}`);
        }
        this.#changed();
      }
    } finally {
      this.#sending = false;
    }
  }

  #schedule() {
    clearTimeout(this.#timer);
    const next = this.#items
      .filter(i => !i.failed)
      .reduce((min, i) => Math.min(min, i.sendAt), Infinity);
    // At most a minute between checks, so a sleeping host or a clock change
    // can't strand a message; at least a second.
    const wait = Math.max(1000, Math.min(60_000, next - Date.now()));
    this.#timer = setTimeout(async () => {
      await this.run(this.ready);
      this.#schedule();
    }, wait);
    this.#timer.unref?.();
  }

  // Set by the owner: whether Signal can send right now.
  ready = () => true;

  #filePath(fileId) {
    return join(this.#dir, 'scheduled-files', fileId);
  }

  #deleteFiles(item) {
    for (const f of item.files) {
      if (this.#dir && ID.test(f.fileId)) {
        rmSync(this.#filePath(f.fileId), { force: true });
      }
    }
  }

  #changed() {
    if (this.#file) {
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      const temp = `${this.#file}.tmp`;
      writeFileSync(temp, JSON.stringify(this.#items), { mode: 0o600 });
      renameSync(temp, this.#file);
    }
    if (this.#timer) {
      this.#schedule();
    }
    this.#onChange();
  }
}

function isItem(i) {
  return clean(i) !== null;
}

// The fields a scheduled message keeps, checked; null if unusable.
function clean(i) {
  if (
    i == null ||
    typeof i !== 'object' ||
    typeof i.id !== 'string' ||
    !ID.test(i.id) ||
    typeof i.conversationId !== 'string' ||
    i.conversationId.length === 0 ||
    i.conversationId.length > 200 ||
    !Number.isSafeInteger(i.sendAt) ||
    typeof i.body !== 'string' ||
    i.body.length > 64 * 1024
  ) {
    return null;
  }
  const files = Array.isArray(i.files) ? i.files : [];
  if (
    files.length > 32 ||
    !files.every(
      f =>
        f &&
        typeof f.fileId === 'string' &&
        ID.test(f.fileId) &&
        Number.isSafeInteger(f.size) &&
        typeof f.contentType === 'string' &&
        (f.fileName === null || typeof f.fileName === 'string')
    ) ||
    (i.body.trim() === '' && files.length === 0)
  ) {
    return null;
  }
  return {
    id: i.id,
    conversationId: i.conversationId,
    sendAt: i.sendAt,
    body: i.body,
    mentions: Array.isArray(i.mentions) ? i.mentions : [],
    formatting: Array.isArray(i.formatting) ? i.formatting : [],
    quoteMessageId:
      typeof i.quoteMessageId === 'string' ? i.quoteMessageId : null,
    linkPreviewUrl:
      typeof i.linkPreviewUrl === 'string' ? i.linkPreviewUrl : null,
    files: files.map(f => ({
      fileId: f.fileId,
      size: f.size,
      contentType: f.contentType,
      fileName: f.fileName,
    })),
    failed: typeof i.failed === 'string' ? i.failed : null,
  };
}
