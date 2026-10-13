// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { getSharedGroupNames } from '../../util/sharedGroupNames.dom.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import type {
  ConversationDetailsDTO,
  ConversationsGetDetailsParamsType,
  ConversationsGetDetailsResultType,
  DetailsMemberDTO,
} from '../protocol.std.ts';
import { ErrorCode } from '../protocol.std.ts';
import {
  getDtoContext,
  getListedConversation,
} from './serviceHelpers.preload.ts';

// Fork addition: Signal's chat details and "About" pages for external
// clients (decision F16). Fields are copied one by one from the same view
// model those pages read, and only where they show them.

function text(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function getDetails({
  conversationId,
}: ConversationsGetDetailsParamsType): ServiceResultType {
  const model = getListedConversation(conversationId);
  if (!model) {
    return { ok: false, code: ErrorCode.NotFound };
  }
  const state = window.reduxStore.getState();
  const conversation = state.conversations.conversationLookup[conversationId];
  if (!conversation) {
    return { ok: false, code: ErrorCode.NotFound };
  }
  const isGroup = conversation.type === 'group';
  const ourConversationId =
    window.ConversationController.getOurConversationId();

  const members: Array<DetailsMemberDTO> = [];
  if (isGroup) {
    const context = getDtoContext();
    for (const membership of conversation.memberships ?? []) {
      const member = window.ConversationController.get(membership.aci);
      if (!member) {
        continue;
      }
      members.push({
        conversationId: member.id,
        author: context.getAuthor(member.id, conversationId, membership.aci),
        admin: membership.isAdmin,
        me: member.id === ourConversationId,
      });
    }
    // As Signal's member list: you first, then by name.
    members.sort(
      (a, b) =>
        Number(b.me) - Number(a.me) ||
        (a.author?.title ?? '').localeCompare(b.author?.title ?? '')
    );
  }

  const nickname = [
    conversation.nicknameGivenName,
    conversation.nicknameFamilyName,
  ]
    .filter(Boolean)
    .join(' ');
  const details: ConversationDetailsDTO = {
    conversationId,
    type: isGroup ? 'group' : 'direct',
    title: conversation.title,
    profileName: isGroup ? null : text(conversation.profileName),
    nickname: isGroup ? null : text(nickname),
    note: isGroup ? null : text(conversation.note),
    about: isGroup ? null : text(conversation.about),
    phoneNumber:
      isGroup || conversation.isMe ? null : text(conversation.phoneNumber),
    username: isGroup ? null : text(conversation.username),
    verified:
      !isGroup && !conversation.isMe && Boolean(conversation.isVerified),
    systemContact:
      !isGroup &&
      Boolean(
        conversation.systemGivenName ||
        conversation.systemFamilyName ||
        conversation.systemNickname
      ),
    sharedGroups:
      isGroup || conversation.isMe
        ? []
        : [...getSharedGroupNames(state, conversationId)],
    description: isGroup ? text(conversation.groupDescription) : null,
    members,
    pendingCount: conversation.pendingMemberships?.length ?? 0,
    requestingCount: conversation.pendingApprovalMemberships?.length ?? 0,
    groupLink:
      isGroup && conversation.areWeAdmin ? text(conversation.groupLink) : null,
    areWeAdmin: Boolean(conversation.areWeAdmin),
    canEditGroupInfo: Boolean(conversation.canEditGroupInfo),
    canAddMembers: Boolean(conversation.canAddNewMembers),
  };
  const value: ConversationsGetDetailsResultType = { details };
  return { ok: true, value };
}
