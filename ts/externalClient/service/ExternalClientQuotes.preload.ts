// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { DataReader } from '../../sql/Client.preload.ts';
import { itemStorage } from '../../textsecure/Storage.preload.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import type {
  MessagesLocateQuoteParamsType,
  MessagesLocateQuoteResultType,
} from '../protocol.std.ts';
import { ErrorCode } from '../protocol.std.ts';
import {
  getListedConversation,
  loadMessage,
} from './serviceHelpers.preload.ts';

// Fork addition: finds the message a reply quotes (decision F23). Signal
// matches a quote by its sent time and author within the same chat. A
// "Reply privately" quotes a group message in a direct chat, so the page
// can jump there too: the group must be one the client can see, which
// means the user and the quoted person are both in it.
export async function locateQuote({
  messageId,
}: MessagesLocateQuoteParamsType): Promise<ServiceResultType> {
  const notFound: ServiceResultType = { ok: false, code: ErrorCode.NotFound };
  const message = await loadMessage(messageId);
  if (!message || !getListedConversation(message.conversationId)) {
    return notFound;
  }
  const { quote } = message;
  if (!quote?.id || !quote.authorAci) {
    return notFound;
  }
  const ourAci = itemStorage.user.getAci();
  const candidates = (await DataReader.getMessagesBySentAt(quote.id)).filter(
    candidate =>
      (candidate.type === 'incoming'
        ? candidate.sourceServiceId === quote.authorAci
        : candidate.type === 'outgoing' && quote.authorAci === ourAci) &&
      getListedConversation(candidate.conversationId) !== undefined
  );
  const here = candidates.find(
    candidate => candidate.conversationId === message.conversationId
  );
  const inGroup = candidates.find(
    candidate =>
      getListedConversation(candidate.conversationId)?.get('type') === 'group'
  );
  const found = here ?? inGroup;
  if (!found) {
    return notFound;
  }
  const value: MessagesLocateQuoteResultType = {
    conversationId: found.conversationId,
    messageId: found.id,
  };
  return { ok: true, value };
}
