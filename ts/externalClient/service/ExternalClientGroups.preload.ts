// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import {
  buildAddMembersChange,
  buildPromotePendingAdminApprovalMemberChange,
  buildUpdateAttributesChange,
  modifyGroupV2,
} from '../../groups.preload.ts';
import { createLogger } from '../../logging/log.std.ts';
import type { ConversationModel } from '../../models/conversations.preload.ts';
import { SignalService as Proto } from '../../protobuf/index.std.ts';
import { getCandidateContactsForNewGroup } from '../../state/selectors/conversations.dom.ts';
import * as Errors from '../../types/errors.std.ts';
import { DataWriter } from '../../sql/Client.preload.ts';
import { computeGroupNameHash } from '../../util/Conversation.preload.ts';
import {
  isMember,
  isMemberPending,
  isMemberRequestingToJoin,
} from '../../util/groupMembershipUtils.preload.ts';
import { isAciString } from '../../util/isAciString.std.ts';
import { isGroupV2 } from '../../util/whatTypeOfConversation.dom.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import type { GroupsUpdateParamsType } from '../protocol.std.ts';
import {
  ErrorCode,
  MAX_GROUP_DESCRIPTION_GRAPHEMES,
  MAX_GROUP_NAME_GRAPHEMES,
} from '../protocol.std.ts';
import { toAvatarBytes } from './ExternalClientProfile.preload.ts';
import { getListedConversation } from './serviceHelpers.preload.ts';

// Fork addition: Signal's group details page for external clients
// (decision F21). Each change is the group change Signal's own controls
// make (ducks/conversations and ConversationModel), called directly so a
// failure comes back to the app instead of opening Signal's error dialog.
// The same checks Signal's page makes before offering a control come
// first; Signal's group server enforces them again.

const log = createLogger('ExternalClientGroups');

const AccessRequired = Proto.AccessControl.AccessRequired;

function graphemeCount(value: string): number {
  return [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
      value
    ),
  ].length;
}

function getServiceId(
  conversationId: string
): ReturnType<ConversationModel['getServiceId']> {
  const member = window.ConversationController.get(conversationId);
  if (!member || member.id !== conversationId) {
    return undefined;
  }
  return member.getServiceId();
}

function getOurServiceId(): ReturnType<ConversationModel['getServiceId']> {
  return window.ConversationController.getOurConversation()?.getServiceId();
}

function toAccess(value: 'all' | 'admins'): number {
  return value === 'admins'
    ? AccessRequired.ADMINISTRATOR
    : AccessRequired.MEMBER;
}

const ok: ServiceResultType = { ok: true, value: {} };
const denied: ServiceResultType = {
  ok: false,
  code: ErrorCode.PermissionDenied,
};
const notFound: ServiceResultType = { ok: false, code: ErrorCode.NotFound };
const invalid: ServiceResultType = {
  ok: false,
  code: ErrorCode.InvalidArgument,
};

export async function updateGroup({
  conversationId,
  change,
}: GroupsUpdateParamsType): Promise<ServiceResultType> {
  const model = getListedConversation(conversationId);
  if (!model) {
    return notFound;
  }
  const conversation =
    window.reduxStore.getState().conversations.conversationLookup[
      conversationId
    ];
  if (!conversation || !isGroupV2(model.attributes)) {
    return notFound;
  }
  const areWeAdmin = Boolean(conversation.areWeAdmin);
  const { attributes } = model;

  try {
    switch (change.action) {
      case 'setInfo': {
        if (!conversation.canEditGroupInfo) {
          return denied;
        }
        const request: {
          avatar?: undefined | Uint8Array<ArrayBuffer>;
          description?: string;
          title?: string;
        } = {};
        if (change.name !== undefined) {
          const title = change.name.trim();
          const count = graphemeCount(title);
          if (count === 0 || count > MAX_GROUP_NAME_GRAPHEMES) {
            return invalid;
          }
          if (title !== attributes.name) {
            request.title = title;
          }
        }
        if (change.description !== undefined) {
          const description = change.description.trim();
          if (graphemeCount(description) > MAX_GROUP_DESCRIPTION_GRAPHEMES) {
            return invalid;
          }
          if (description !== (attributes.description ?? '')) {
            request.description = description;
          }
        }
        // Null removes the photo.
        if (change.avatar !== undefined) {
          let avatar: Uint8Array<ArrayBuffer> | undefined;
          if (change.avatar) {
            avatar = await toAvatarBytes(change.avatar);
            if (!avatar) {
              return invalid;
            }
          }
          request.avatar = avatar;
        }
        if (Object.keys(request).length === 0) {
          return ok;
        }
        const { id, publicParams, revision, secretParams } = attributes;
        await modifyGroupV2({
          name: 'updateGroupAttributes',
          conversation: model,
          usingCredentialsFrom: [],
          createGroupChange: async () =>
            buildUpdateAttributesChange(
              { id, publicParams, revision, secretParams },
              request
            ),
        });
        // As Signal's updateGroupAttributes.
        if (request.title) {
          model.set({
            groupVerifiedNameHash: computeGroupNameHash(request.title),
          });
          await DataWriter.updateConversation(model.attributes);
          model.captureChange('groupVerifiedNameHash');
        }
        return ok;
      }
      case 'addMembers': {
        if (!conversation.canAddNewMembers) {
          return denied;
        }
        const candidates = new Set(
          getCandidateContactsForNewGroup(window.reduxStore.getState()).map(
            contact => contact.id
          )
        );
        const memberIds = [...new Set(change.memberIds)];
        if (!memberIds.every(id => candidates.has(id))) {
          return notFound;
        }
        await modifyGroupV2({
          name: 'addMembersToGroup',
          conversation: model,
          usingCredentialsFrom: memberIds
            .map(id => window.ConversationController.get(id))
            .filter(member => member !== undefined),
          createGroupChange: async () =>
            buildAddMembersChange(model.attributes, memberIds),
        });
        return ok;
      }
      case 'removeMember': {
        const serviceId = getServiceId(change.memberId);
        if (!serviceId || !isMember(attributes, serviceId)) {
          return notFound;
        }
        if (
          !areWeAdmin ||
          change.memberId ===
            window.ConversationController.getOurConversationId()
        ) {
          return denied;
        }
        await model.removeFromGroupV2(change.memberId);
        return ok;
      }
      case 'setAdmin': {
        const serviceId = getServiceId(change.memberId);
        if (!serviceId || !isMember(attributes, serviceId)) {
          return notFound;
        }
        if (
          !areWeAdmin ||
          change.memberId ===
            window.ConversationController.getOurConversationId()
        ) {
          return denied;
        }
        const isAdmin = conversation.memberships?.find(
          membership => membership.aci === serviceId
        )?.isAdmin;
        if (Boolean(isAdmin) !== change.admin) {
          await model.toggleAdmin(change.memberId);
        }
        return ok;
      }
      case 'approveRequest': {
        const serviceId = getServiceId(change.memberId);
        if (
          !serviceId ||
          !isAciString(serviceId) ||
          !isMemberRequestingToJoin(attributes, serviceId)
        ) {
          return notFound;
        }
        if (!areWeAdmin) {
          return denied;
        }
        await modifyGroupV2({
          name: 'approvePendingMembershipFromGroupV2',
          conversation: model,
          usingCredentialsFrom: [],
          createGroupChange: async () =>
            isMemberRequestingToJoin(model.attributes, serviceId)
              ? buildPromotePendingAdminApprovalMemberChange({
                  group: model.attributes,
                  aci: serviceId,
                })
              : undefined,
        });
        return ok;
      }
      case 'denyRequest': {
        const serviceId = getServiceId(change.memberId);
        if (!serviceId || !isMemberRequestingToJoin(attributes, serviceId)) {
          return notFound;
        }
        if (!areWeAdmin) {
          return denied;
        }
        await model.removeFromGroupV2(change.memberId);
        return ok;
      }
      case 'revokeInvites': {
        const ourAci = getOurServiceId();
        for (const memberId of new Set(change.memberIds)) {
          const serviceId = getServiceId(memberId);
          if (!serviceId || !isMemberPending(attributes, serviceId)) {
            return notFound;
          }
          // As Signal: your own invites, or any invite as an admin.
          const invite = attributes.pendingMembersV2?.find(
            pending => pending.serviceId === serviceId
          );
          if (!areWeAdmin && invite?.addedByUserId !== ourAci) {
            return denied;
          }
        }
        for (const memberId of new Set(change.memberIds)) {
          // eslint-disable-next-line no-await-in-loop
          await model.removeFromGroupV2(memberId);
        }
        return ok;
      }
      case 'groupLink':
        if (!areWeAdmin) {
          return denied;
        }
        await model.toggleGroupLink(change.enabled);
        return ok;
      case 'resetGroupLink':
        if (!areWeAdmin) {
          return denied;
        }
        await model.refreshGroupLink();
        return ok;
      case 'groupLinkApproval':
        if (!areWeAdmin) {
          return denied;
        }
        if (
          attributes.accessControl?.addFromInviteLink ===
          AccessRequired.UNSATISFIABLE
        ) {
          return { ok: false, code: ErrorCode.PreconditionFailed };
        }
        await model.updateAccessControlAddFromInviteLink(change.required);
        return ok;
      case 'permissions': {
        if (!areWeAdmin) {
          return denied;
        }
        if (
          change.sendMessages !== undefined &&
          !model.canBeAnnouncementGroup() &&
          !conversation.announcementsOnly
        ) {
          return { ok: false, code: ErrorCode.PreconditionFailed };
        }
        if (change.addMembers !== undefined) {
          await model.updateAccessControlMembers(toAccess(change.addMembers));
        }
        if (change.editInfo !== undefined) {
          await model.updateAccessControlAttributes(toAccess(change.editInfo));
        }
        if (change.sendMessages !== undefined) {
          await model.updateAnnouncementsOnly(change.sendMessages === 'admins');
        }
        return ok;
      }
      case 'leave': {
        const others = (conversation.memberships ?? []).filter(
          membership => membership.aci !== getOurServiceId()
        );
        if (
          areWeAdmin &&
          others.length > 0 &&
          !others.some(membership => membership.isAdmin)
        ) {
          return { ok: false, code: ErrorCode.PreconditionFailed };
        }
        await model.leaveGroupV2();
        return ok;
      }
      default:
        throw new Error('unknown group change');
    }
  } catch (error) {
    log.warn(`updateGroup ${change.action} failed`, Errors.toLogFormat(error));
    return { ok: false, code: ErrorCode.InternalError };
  }
}
