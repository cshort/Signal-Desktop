// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConversationModel } from '../../models/conversations.preload.ts';
import { BodyRange } from '../../types/BodyRange.std.ts';
import type {
  DraftBodyRange,
  DraftBodyRangeMention,
} from '../../types/BodyRange.std.ts';
import type { AciString } from '../../types/ServiceId.std.ts';
import { isAciString } from '../../util/isAciString.std.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import type {
  ConversationsGetMembersParamsType,
  ConversationsGetMembersResultType,
  GroupMemberDTO,
  SendFormattingType,
  SendMentionType,
} from '../protocol.std.ts';
import { ErrorCode, MENTION_PLACEHOLDER } from '../protocol.std.ts';
import {
  getDtoContext,
  getListedConversation,
} from './serviceHelpers.preload.ts';

// Fork-only: @mentions and text styles, as Signal's composer sends them.

type MemberType = Readonly<{
  conversationId: string;
  aci: AciString;
  title: string;
}>;

// The members Signal's mention list offers (MemberRepository): the group's
// members with an ACI, sorted by name, without us.
function getMentionableMembers(model: ConversationModel): Array<MemberType> {
  const members: Array<MemberType> = [];
  for (const member of model.format().sortedGroupMembers ?? []) {
    if (!member.isMe && isAciString(member.serviceId)) {
      members.push({
        conversationId: member.id,
        aci: member.serviceId,
        title: member.title,
      });
    }
  }
  return members;
}

export function getMembers({
  conversationId,
}: ConversationsGetMembersParamsType): ServiceResultType {
  const model = getListedConversation(conversationId);
  if (!model) {
    return { ok: false, code: ErrorCode.NotFound };
  }
  const context = getDtoContext();
  const members: Array<GroupMemberDTO> = [];
  for (const member of getMentionableMembers(model)) {
    const author = context.getAuthor(
      member.conversationId,
      conversationId,
      member.aci
    );
    if (author) {
      members.push({ conversationId: member.conversationId, author });
    }
  }
  const value: ConversationsGetMembersResultType = { members };
  return { ok: true, value };
}

// Turns the client's mentions into Signal's body ranges. Undefined when one
// is not at a placeholder or names someone who isn't a member: the send is
// refused rather than sent with a broken mention.
export function toMentionRanges(
  model: ConversationModel,
  body: string,
  mentions: ReadonlyArray<SendMentionType> | undefined
): Array<DraftBodyRangeMention> | undefined {
  if (!mentions || mentions.length === 0) {
    return [];
  }
  const members = new Map(
    getMentionableMembers(model).map(member => [member.conversationId, member])
  );
  const seen = new Set<number>();
  const ranges: Array<DraftBodyRangeMention> = [];
  for (const { start, conversationId } of mentions) {
    const member = members.get(conversationId);
    if (!member || body[start] !== MENTION_PLACEHOLDER || seen.has(start)) {
      return undefined;
    }
    seen.add(start);
    ranges.push({
      start,
      length: 1,
      mentionAci: member.aci,
      replacementText: member.title,
    });
  }
  return ranges;
}

const STYLES: Record<SendFormattingType['style'], BodyRange.Style> = {
  bold: BodyRange.Style.BOLD,
  italic: BodyRange.Style.ITALIC,
  strikethrough: BodyRange.Style.STRIKETHROUGH,
  monospace: BodyRange.Style.MONOSPACE,
  spoiler: BodyRange.Style.SPOILER,
};

// Mentions and styles as Signal's body ranges, or undefined when one does
// not fit the body (the send is then refused).
export function toBodyRanges(
  model: ConversationModel,
  body: string,
  mentions: ReadonlyArray<SendMentionType> | undefined,
  formatting: ReadonlyArray<SendFormattingType> | undefined
): Array<DraftBodyRange> | undefined {
  const mentionRanges = toMentionRanges(model, body, mentions);
  if (!mentionRanges) {
    return undefined;
  }
  const ranges: Array<DraftBodyRange> = [...mentionRanges];
  for (const { start, length, style } of formatting ?? []) {
    if (start + length > body.length) {
      return undefined;
    }
    ranges.push({ start, length, style: STYLES[style] });
  }
  return ranges;
}
