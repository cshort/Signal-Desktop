// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { Emoji } from '../../axo/emoji.std.ts';
import { createLogger } from '../../logging/log.std.ts';
import { writeProfile } from '../../services/writeProfile.preload.ts';
import {
  DEFAULT_AUTO_DOWNLOAD_ATTACHMENT,
  itemStorage,
} from '../../textsecure/Storage.preload.ts';
import { setPhoneNumberDiscoverability } from '../../textsecure/WebAPI.preload.ts';
import { PhoneNumberSharingMode } from '../../types/PhoneNumberSharingMode.std.ts';
import type { StorageAccessType } from '../../types/StorageKeys.std.ts';
import { STORAGE_KEY_DEFAULTS } from '../../types/StorageKeys.std.ts';
import * as Errors from '../../types/errors.std.ts';
import { DurationInSeconds } from '../../util/durations/duration-in-seconds.std.ts';
import { getConversation } from '../../util/getConversation.preload.ts';
import { PhoneNumberDiscoverability } from '../../util/phoneNumberDiscoverability.std.ts';
import * as universalExpireTimer from '../../util/universalExpireTimer.preload.ts';
import type { ServiceResultType } from '../hostTypes.std.ts';
import type {
  SettingsDTO,
  SettingsGetResultType,
  SettingsSetParamsType,
} from '../protocol.std.ts';
import { ErrorCode, SKIN_TONES } from '../protocol.std.ts';

// Fork addition: Signal's Settings for external clients (decision F11). Each
// change is what Signal's own Settings page does for it
// (state/smart/Preferences.preload.tsx): the same item, and for account-wide
// ones the same storage-service sync.

const log = createLogger('ExternalClientPreferences');

function item<K extends keyof StorageAccessType>(
  key: K,
  fallback: StorageAccessType[K]
): StorageAccessType[K] {
  return itemStorage.get(key) ?? fallback;
}

function put<K extends keyof StorageAccessType>(
  key: K,
  value: StorageAccessType[K],
  { sync }: { sync: boolean }
): void {
  window.reduxActions.items.putItem(key, value);
  if (sync) {
    window.ConversationController.getOurConversationOrThrow().captureChange(
      key
    );
  }
}

function readSettings(): SettingsDTO {
  const tone: string = itemStorage.get('emojiSkinToneDefault') ?? '';
  return {
    emojiSkinTone: SKIN_TONES.find(known => known === tone) ?? '',
    linkPreviews: item('linkPreviews', false),
    sentMediaQuality:
      item('sent-media-quality', 'standard') === 'high' ? 'high' : 'standard',
    keepMutedChatsArchived: item('keepMutedChatsArchived', false),
    readReceipts: item('read-receipt-setting', false),
    typingIndicators: item('typingIndicators', false),
    sealedSenderIndicators: item('sealedSenderIndicators', false),
    disappearingMessagesSeconds: universalExpireTimer.get(),
    phoneNumberSharing:
      item('phoneNumberSharingMode', PhoneNumberSharingMode.Nobody) ===
      PhoneNumberSharingMode.Everybody
        ? 'everybody'
        : 'nobody',
    phoneNumberDiscoverable:
      item(
        'phoneNumberDiscoverability',
        PhoneNumberDiscoverability.NotDiscoverable
      ) === PhoneNumberDiscoverability.Discoverable,
    notificationContent: item(
      'notification-setting',
      STORAGE_KEY_DEFAULTS['notification-setting']
    ),
    notificationSound: item(
      'audio-notification',
      STORAGE_KEY_DEFAULTS['audio-notification']
    ),
    reactionNotifications: item(
      'reaction-notification',
      STORAGE_KEY_DEFAULTS['reaction-notification']
    ),
    autoDownload: {
      ...DEFAULT_AUTO_DOWNLOAD_ATTACHMENT,
      ...item('auto-download-attachment', DEFAULT_AUTO_DOWNLOAD_ATTACHMENT),
    },
  };
}

export function getSettings(): ServiceResultType {
  const value: SettingsGetResultType = { settings: readSettings() };
  return { ok: true, value };
}

async function setDiscoverable(discoverable: boolean): Promise<void> {
  put(
    'phoneNumberDiscoverability',
    discoverable
      ? PhoneNumberDiscoverability.Discoverable
      : PhoneNumberDiscoverability.NotDiscoverable,
    { sync: false }
  );
  await setPhoneNumberDiscoverability(discoverable);
  window.ConversationController.getOurConversationOrThrow().captureChange(
    'phoneNumberDiscoverability'
  );
}

async function applySetting(params: SettingsSetParamsType): Promise<void> {
  switch (params.key) {
    case 'emojiSkinTone':
      window.reduxActions.items.setEmojiSkinToneDefault(
        params.value as Emoji.SkinTone
      );
      return;
    case 'linkPreviews':
      put('linkPreviews', params.value, { sync: true });
      return;
    case 'sentMediaQuality':
      put('sent-media-quality', params.value, { sync: false });
      return;
    case 'keepMutedChatsArchived':
      put('keepMutedChatsArchived', params.value, { sync: true });
      return;
    case 'readReceipts':
      put('read-receipt-setting', params.value, { sync: true });
      return;
    case 'typingIndicators':
      put('typingIndicators', params.value, { sync: true });
      return;
    case 'sealedSenderIndicators':
      put('sealedSenderIndicators', params.value, { sync: true });
      return;
    case 'disappearingMessagesSeconds':
      await universalExpireTimer.set(
        DurationInSeconds.fromSeconds(params.value)
      );
      window.ConversationController.getOurConversationOrThrow().captureChange(
        'universalExpireTimer'
      );
      return;
    case 'phoneNumberSharing': {
      const everybody = params.value === 'everybody';
      put(
        'phoneNumberSharingMode',
        everybody
          ? PhoneNumberSharingMode.Everybody
          : PhoneNumberSharingMode.Nobody,
        { sync: false }
      );
      const account = window.ConversationController.getOurConversationOrThrow();
      // As Signal: sharing the number with everybody makes it findable.
      if (everybody) {
        await setDiscoverable(true);
      }
      account.captureChange('phoneNumberSharingMode');
      await writeProfile(getConversation(account), { keepAvatar: true });
      return;
    }
    case 'phoneNumberDiscoverable':
      // Signal only offers "nobody can find me" when nobody can see it.
      if (
        !params.value &&
        item('phoneNumberSharingMode', PhoneNumberSharingMode.Nobody) ===
          PhoneNumberSharingMode.Everybody
      ) {
        throw new InvalidSetting();
      }
      await setDiscoverable(params.value);
      return;
    case 'notificationContent':
      put('notification-setting', params.value, { sync: false });
      return;
    case 'notificationSound':
      put('audio-notification', params.value, { sync: false });
      return;
    case 'reactionNotifications':
      put('reaction-notification', params.value, { sync: true });
      return;
    case 'autoDownload':
      put('auto-download-attachment', params.value, { sync: false });
      return;
    default:
      throw new InvalidSetting();
  }
}

class InvalidSetting extends Error {}

export async function setSetting(
  params: SettingsSetParamsType
): Promise<ServiceResultType> {
  try {
    await applySetting(params);
  } catch (error) {
    if (error instanceof InvalidSetting) {
      return { ok: false, code: ErrorCode.InvalidArgument };
    }
    log.warn(`setSetting ${params.key} failed`, Errors.toLogFormat(error));
    return { ok: false, code: ErrorCode.InternalError };
  }
  log.info(`setSetting: ${params.key}`);
  const value: SettingsGetResultType = { settings: readSettings() };
  return { ok: true, value };
}
