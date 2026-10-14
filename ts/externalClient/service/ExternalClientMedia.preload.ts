// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { DataReader } from '../../sql/Client.preload.ts';
import type { MediaItemMessageType } from '../../types/MediaItem.std.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import { toMessageDTO } from '../messageDto.std.ts';
import type {
  MediaItemDTO,
  MediaListParamsType,
  MediaListResultType,
  MessageDTO,
} from '../protocol.std.ts';
import { ErrorCode, MediaKind } from '../protocol.std.ts';
import {
  getDtoContext,
  getListedConversation,
  preferCached,
} from './serviceHelpers.preload.ts';

// Fork addition (decision F31): Signal's "All media" view for external
// clients, with the same queries as its media gallery
// (ducks/mediaGallery): newest first, paged back by message.

const DEFAULT_LIMIT = 50;

type RawItemType = Readonly<{
  message: MediaItemMessageType;
  // For links, the URL; the index is found in the message's previews.
  index: number | null;
  url?: string;
}>;

async function query(
  kind: MediaListParamsType['kind'],
  options: Readonly<{
    conversationId: string;
    limit: number;
    receivedAt?: number;
    sentAt?: number;
  }>
): Promise<ReadonlyArray<RawItemType>> {
  const order = 'older' as const;
  switch (kind) {
    case MediaKind.Media:
    case MediaKind.Audio:
      return (
        await DataReader.getSortedMedia({ ...options, order, type: kind })
      ).map(item => ({ message: item.message, index: item.index }));
    case MediaKind.Files:
      // Signal mixes shared contacts into its documents; they're left out.
      return (await DataReader.getSortedDocuments({ ...options, order })).map(
        item =>
          item.type === 'mediaItem'
            ? { message: item.message, index: item.index }
            : { message: item.message, index: null }
      );
    case MediaKind.Links:
      return (
        await DataReader.getSortedNonAttachmentMedia({
          ...options,
          order,
          type: 'links',
        })
      ).map(item =>
        item.type === 'link'
          ? { message: item.message, index: null, url: item.preview.url }
          : { message: item.message, index: null }
      );
    default:
      throw new Error(`unknown media kind: ${kind satisfies never}`);
  }
}

export async function listMedia({
  conversationId,
  kind,
  limit = DEFAULT_LIMIT,
  cursor,
}: MediaListParamsType): Promise<ServiceResultType> {
  if (!getListedConversation(conversationId)) {
    return { ok: false, code: ErrorCode.NotFound };
  }
  const [receivedAt, sentAt] = cursor?.split('.').map(Number) ?? [];
  let raw = await query(kind, { conversationId, limit, receivedAt, sentAt });

  // The next page starts after a whole message (it is keyed by the
  // message's times), so a message cut off by the limit waits for it.
  let nextCursor: string | null = null;
  if (raw.length === limit) {
    const last = raw.at(-1)?.message.id;
    const trimmed = raw.filter(item => item.message.id !== last);
    raw = trimmed.length > 0 ? trimmed : raw;
    const { message } = raw.at(-1) ?? {};
    nextCursor = message ? `${message.receivedAt}.${message.sentAt}` : null;
  }

  const ids = [...new Set(raw.map(item => item.message.id))];
  const context = getDtoContext();
  const messages = new Map<string, MessageDTO>();
  for (const attributes of await DataReader.getMessagesById(ids)) {
    const dto = toMessageDTO(preferCached(attributes), context);
    if (dto) {
      messages.set(dto.id, dto);
    }
  }

  const items = new Array<MediaItemDTO>();
  for (const item of raw) {
    const message = messages.get(item.message.id);
    const index =
      item.url !== undefined
        ? (message?.previews.findIndex(p => p.url === item.url) ?? -1)
        : (item.index ?? -1);
    // Deleted and view-once messages show nothing, as in Signal.
    const count =
      kind === MediaKind.Links
        ? (message?.previews.length ?? 0)
        : (message?.attachments.length ?? 0);
    if (message && index >= 0 && index < count) {
      items.push({ messageId: message.id, index });
    }
  }

  const value: MediaListResultType = {
    items,
    messages: [...messages.values()].filter(m =>
      items.some(item => item.messageId === m.id)
    ),
    nextCursor,
  };
  return { ok: true, value };
}
