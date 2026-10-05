/*
* Vencord, a Discord client mod
* Copyright (c) 2025 Vendicated and contributors*
* SPDX-License-Identifier: GPL-3.0-or-later
*/

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findStore } from "@webpack";
import { ChannelStore, React, RelationshipStore, TypingStore, VoiceStateStore } from "@webpack/common";

const logger = new Logger("[IDontLikeU]");

const CHANNEL_TYPE_DM = 1;

const settings = definePluginSettings({
    hideIgnoredUsers: {
        type: OptionType.BOOLEAN,
        description: "Hide ignored users too",
        default: false,
        onChange: () => refresh(),
    },
});

let running = false;
let version = 0;

function shouldHide(userId: string | undefined | null): boolean {
    if (!running || !userId) return false;
    if (RelationshipStore.isBlocked(userId)) return true;
    if (settings.store.hideIgnoredUsers && RelationshipStore.isIgnored?.(userId)) return true;
    return false;
}

function getDmRecipientId(channel: any): string | undefined {
    if (channel?.type !== CHANNEL_TYPE_DM) return;
    const recipient = channel.recipients?.[0] ?? channel.recipient_ids?.[0] ?? channel.rawRecipients?.[0];
    return typeof recipient === "string" ? recipient : recipient?.id;
}

const restorers: Array<() => void> = [];

function wrapMethod(store: any, name: string, make: (original: (...args: any[]) => any) => (...args: any[]) => any) {
    const original = store?.[name];
    if (typeof original !== "function") {
        logger.warn(`Could not find ${store?.getName?.() ?? "store"}.${name}, skipping`);
        return;
    }
    const hadOwn = Object.prototype.hasOwnProperty.call(store, name);
    store[name] = make(original.bind(store));
    restorers.push(() => {
        if (hadOwn) store[name] = original;
        else delete store[name];
    });
}

const listMemo = new WeakMap<object, { v: number; length: number; out: any; }>();

function filterList<T>(list: T[], getUserId: (item: T) => string | undefined | null): T[] {
    if (!running || !Array.isArray(list) || list.length === 0) return list;
    const cached = listMemo.get(list);
    if (cached?.v === version && cached.length === list.length) return cached.out;
    const out = list.some(item => shouldHide(getUserId(item)))
        ? list.filter(item => !shouldHide(getUserId(item)))
        : list;
    listMemo.set(list, { v: version, length: list.length, out });
    return out;
}

const recordMemo = new WeakMap<object, { sig: string; out: any; }>();

function filterUserRecord<T>(record: Record<string, T>): Record<string, T> {
    if (!running || record == null || typeof record !== "object") return record;
    const keys = Object.keys(record);
    if (!keys.some(shouldHide)) return record;
    const sig = `${version}:${keys.length}`;
    const cached = recordMemo.get(record);
    if (cached?.sig === sig) return cached.out;
    const out: Record<string, T> = {};
    for (const key of keys) if (!shouldHide(key)) out[key] = record[key];
    recordMemo.set(record, { sig, out });
    return out;
}

const memberListCache = new Map<string, { key: string; out: any; }>();

function filterMemberList(props: any) {
    if (!running || props == null) return props;
    const { rows, groups } = props;
    if (!Array.isArray(rows) || !Array.isArray(groups)) return props;

    const key = `${props.version}:${version}:${rows.length}`;
    const cached = memberListCache.get(props.listId);
    if (cached?.key === key) return cached.out ?? props;

    const isHiddenRow = (row: any) => row?.type === "MEMBER" && shouldHide(row.user?.id);
    if (!rows.some(isHiddenRow)) {
        memberListCache.set(props.listId, { key, out: null });
        return props;
    }

    const groupsByIndex = new Map<number, any>();
    for (const group of groups) groupsByIndex.set(group.index, group);

    const newRows: any[] = [];
    const newGroups: any[] = [];

    for (let i = 0; i < rows.length;) {
        const group = groupsByIndex.get(i);
        if (group == null) {
            if (!isHiddenRow(rows[i])) newRows.push(rows[i]);
            i++;
            continue;
        }
        const members: any[] = [];
        let removed = 0;
        const end = Math.min(i + group.count, rows.length - 1);
        for (let j = i + 1; j <= end; j++) {
            if (isHiddenRow(rows[j])) removed++;
            else members.push(rows[j]);
        }
        const count = Math.max(0, group.count - removed);
        if (count > 0 || removed === 0) {
            const index = newRows.length;
            const header = rows[i];
            newGroups.push({ ...group, count, index });
            newRows.push(header?.type === "GROUP" ? { ...header, count, index } : header);
            newRows.push(...members);
        }
        i += group.count + 1;
    }

    const out = { ...props, rows: newRows, groups: newGroups };
    memberListCache.set(props.listId, { key, out });
    return out;
}

const participantUserId = (p: any) => p?.user?.id ?? p?.userId;
const sortedVoiceUserId = (v: any) => v?.user?.id ?? v?.voiceState?.userId;
const dmChannelUserId = (channelId: string) => getDmRecipientId(ChannelStore.getChannel(channelId));

function shouldHideGroup(props: any): boolean {
    try {
        const items = props?.messages?.content;
        if (!running || !Array.isArray(items)) return false;
        let sawMessage = false;
        for (const item of items) {
            if (item?.type !== "MESSAGE" && item?.type !== "THREAD_STARTER_MESSAGE") continue;
            if (!shouldHide(item.content?.author?.id)) return false;
            sawMessage = true;
        }
        return sawMessage;
    } catch (e) {
        logger.error("shouldHideGroup failed", e);
        return false;
    }
}

let storesToRefresh: any[] = [];

function installStoreWrappers() {
    const SortedVoiceStateStore = findStore("SortedVoiceStateStore");
    const ChannelRTCStore = findStore("ChannelRTCStore");
    const PrivateChannelSortStore = findStore("PrivateChannelSortStore");
    const ChannelMemberStore = findStore("ChannelMemberStore");
    const UserProfileStore = findStore("UserProfileStore");

    wrapMethod(RelationshipStore, "isIgnoredForMessage", original => message => original(message) || shouldHide(message?.author?.id));

    wrapMethod(TypingStore, "getTypingUsers", original => channelId => filterUserRecord(original(channelId)));

    wrapMethod(RelationshipStore, "getFriendIDs", original => () => filterList(original(), (id: string) => id));
    wrapMethod(RelationshipStore, "getRelationships", original => () => {
        const relationships = original();
        if (!running || !settings.store.hideIgnoredUsers || relationships == null || typeof relationships !== "object") return relationships;
        const ids = Object.keys(relationships);
        const hidden = (id: string) => !RelationshipStore.isBlocked(id) && shouldHide(id);
        if (!ids.some(hidden)) return relationships;
        const sig = `${version}:${ids.length}`;
        const cached = recordMemo.get(relationships);
        if (cached?.sig === sig) return cached.out;
        const out: Record<string, any> = {};
        for (const id of ids) if (!hidden(id)) out[id] = relationships[id];
        recordMemo.set(relationships, { sig, out });
        return out;
    });

    wrapMethod(PrivateChannelSortStore, "getPrivateChannelIds", original => () => filterList(original(), dmChannelUserId));

    wrapMethod(ChannelMemberStore, "getProps", original => (guildId, channelId) => filterMemberList(original(guildId, channelId)));
    wrapMethod(ChannelMemberStore, "getRows", original => (guildId, channelId) => {
        if (!running) return original(guildId, channelId);
        return ChannelMemberStore.getProps(guildId, channelId).rows;
    });

    wrapMethod(VoiceStateStore, "getVoiceStatesForChannel", original => channelId => filterUserRecord(original(channelId)));
    wrapMethod(VoiceStateStore, "getVideoVoiceStatesForChannel", original => channelId => filterUserRecord(original(channelId)));
    wrapMethod(VoiceStateStore, "getVoiceStates", original => guildId => filterUserRecord(original(guildId)));
    wrapMethod(SortedVoiceStateStore, "getVoiceStatesForChannel", original => channel => filterList(original(channel), sortedVoiceUserId));
    wrapMethod(SortedVoiceStateStore, "getVoiceStatesForChannelAlt", original => (channelId, guildId) => filterList(original(channelId, guildId), sortedVoiceUserId));

    wrapMethod(UserProfileStore, "getMutualFriends", original => (userId: string) => filterList(original(userId), (u: any) => u?.id ?? u?.user?.id));

    for (const name of ["getParticipants", "getSpeakingParticipants", "getFilteredParticipants", "getVideoParticipants", "getStreamParticipants"]) {
        wrapMethod(ChannelRTCStore, name, original => channelId => filterList(original(channelId), participantUserId));
    }

    storesToRefresh = [
        RelationshipStore,
        TypingStore,
        PrivateChannelSortStore,
        ChannelMemberStore,
        VoiceStateStore,
        SortedVoiceStateStore,
        ChannelRTCStore,
        UserProfileStore,
    ];
}

function uninstallStoreWrappers() {
    while (restorers.length) {
        try {
            restorers.pop()!();
        } catch (e) {
            logger.error("Failed to restore store method", e);
        }
    }
    storesToRefresh = [];
}

function refresh() {
    version++;
    memberListCache.clear();
    for (const store of storesToRefresh) {
        try {
            store?.emitChange?.();
        } catch (e) {
            logger.error("Failed to refresh store", store?.getName?.(), e);
        }
    }
}

function onRelationshipsChange() {
    refresh();
}

export default definePlugin({
    name: "IDontLikeU",
    description: "Completely removes blocked/ignored users from every part of your Discord.",
    authors: [{ name: "_4e9", id: 1393818487096344586n }],
    tags: ["Accessibility", "Chat"],
    settings,

    patches: [
        {
            find: ".__invalid_blocked,",
            replacement: {
                match: /let{messages:\i,[^}]*?collapsedReason[^}]*}/,
                replace: "if($self.shouldHideGroup(arguments[0]))return null;$&"
            }
        },
        {
            find: ".USER_MENTION)",
            replacement: {
                match: /function (\i)\((\i)\)\{let\{className:(\i),userId:(\i),channelId:(\i),parsedUserId:(\i),content:(\i),inlinePreview:/,
                replace: "function $1($2){return $self.renderMention($2,$1_original)}function $1_original($2){let{className:$3,userId:$4,channelId:$5,parsedUserId:$6,content:$7,inlinePreview:"
            }
        }
    ],

    renderMention(props: any, Inner: any) {
        if (shouldHide(props?.userId ?? props?.parsedUserId)) return null;
        return React.createElement(Inner, props);
    },

    shouldHideGroup,

    start() {
        running = true;
        RelationshipStore.addChangeListener(onRelationshipsChange);
        installStoreWrappers();
        refresh();
    },

    stop() {
        uninstallStoreWrappers();
        RelationshipStore.removeChangeListener(onRelationshipsChange);
        running = false;
    },
});
