require("dotenv").config();
const fs = require("fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

const sessionString = fs.readFileSync("./session.txt", "utf8").trim();
const stringSession = new StringSession(sessionString);

const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
});

const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
const listenMode = config.listenMode || "all-groups";
const listenChats = new Set((config.listenChats || []).map(String));
const outputChatName = config.outputChatName;
const keywords = config.keywords || [];
const summaryMaxLength = Number(config.summaryMaxLength || 120);
const cooldownMs = Number(config.cooldownMs || 10 * 60 * 1000);
const cooldownMap = new Map();
const titleEventCooldownMs = Number(config.titleEventCooldownMs || 60 * 1000);
const titleEventCooldownMap = new Map();

function extractPeerId(message) {
  const peer = message.peerId;
  if (!peer) return null;
  if (peer.userId) return peer.userId.toString();
  if (peer.chatId) return peer.chatId.toString();
  if (peer.channelId) return peer.channelId.toString();
  return null;
}

function normalizeText(text = "") {
  return String(text).replace(/\s+/g, " ").trim();
}

function matchKeywords(text = "") {
  const matched = [];
  for (const kw of keywords) {
    if (text.includes(kw)) matched.push(kw);
  }
  return matched;
}

function shortText(text = "") {
  const cleaned = normalizeText(text);
  if (cleaned.length <= summaryMaxLength) return cleaned;
  return cleaned.slice(0, summaryMaxLength) + "...";
}

function cleanupCooldowns(now = Date.now()) {
  for (const [key, ts] of cooldownMap.entries()) {
    if (now - ts >= cooldownMs) cooldownMap.delete(key);
  }
  for (const [key, ts] of titleEventCooldownMap.entries()) {
    if (now - ts >= titleEventCooldownMs) titleEventCooldownMap.delete(key);
  }
}

function filterKeywordsByCooldown(peerId, matched) {
  const now = Date.now();
  cleanupCooldowns(now);
  const allowed = [];
  const skipped = [];

  for (const kw of matched) {
    const cooldownKey = `${peerId}::${kw}`;
    const lastTs = cooldownMap.get(cooldownKey);
    if (lastTs && now - lastTs < cooldownMs) {
      skipped.push(kw);
      continue;
    }
    cooldownMap.set(cooldownKey, now);
    allowed.push(kw);
  }

  return { allowed, skipped };
}

function allowTitleEvent(peerId, marker) {
  const now = Date.now();
  cleanupCooldowns(now);
  const key = `${peerId}::${marker}`;
  const lastTs = titleEventCooldownMap.get(key);
  if (lastTs && now - lastTs < titleEventCooldownMs) return false;
  titleEventCooldownMap.set(key, now);
  return true;
}

async function findDialogEntityByName(name) {
  const dialogs = await client.getDialogs({});
  for (const dialog of dialogs) {
    if ((dialog.name || "").trim() === name) return dialog.entity;
  }
  return null;
}

async function findDialogNameByPeerId(peerId) {
  const dialogs = await client.getDialogs({});
  for (const dialog of dialogs) {
    const entity = dialog.entity;
    const id =
      entity?.id?.toString?.() ||
      entity?.userId?.toString?.() ||
      entity?.chatId?.toString?.() ||
      entity?.channelId?.toString?.();
    if (id === peerId) return dialog.name || peerId;
  }
  return peerId;
}

async function getChatInfo(message, peerId) {
  try {
    const chat = await message.getChat();
    if (chat) {
      return {
        name: chat.title || chat.firstName || chat.username || peerId,
        isGroup: Boolean(chat.megagroup || chat.broadcast || chat.title),
      };
    }
  } catch (_) {}

  const peerType = message.peerId?.className || "";
  const dialogName = await findDialogNameByPeerId(peerId);
  const isGroup = peerType === "PeerChat" || peerType === "PeerChannel";
  return { name: dialogName, isGroup };
}

function shouldListen(peerId, chatInfo, outputChatNameValue) {
  if (!peerId) return false;
  if (!chatInfo?.isGroup) return false;
  if (chatInfo.name === outputChatNameValue) return false;
  if (listenMode === "all-groups") return true;
  return listenChats.has(peerId);
}

function extractTitleChange(message) {
  const action = message.action;
  if (!action) return null;
  const className = action.className || "";
  if (className === "MessageActionChatEditTitle") return action.title || null;
  return null;
}

function isTitleChangeText(text = "") {
  return text.includes("把群组名称已更改为") || text.includes("已更改为");
}

(async () => {
  await client.connect();

  const outputEntity = await findDialogEntityByName(outputChatName);
  if (!outputEntity) {
    console.error(`找不到输出目标：${outputChatName}`);
    process.exit(1);
  }

  console.log(`发送监听器已启动，输出目标：${outputChatName}，监听模式：${listenMode}，冷却：${Math.round(cooldownMs / 60000)}分钟`);

  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message) return;

      let sender = null;
      try {
        sender = await message.getSender();
      } catch (_) {}

      const peerId = extractPeerId(message);
      if (!peerId) return;

      const chatInfo = await getChatInfo(message, peerId);
      if (!shouldListen(peerId, chatInfo, outputChatName)) {
        console.log("未命中监听范围：", { peerId, chatName: chatInfo.name });
        return;
      }

      const operatorName =
        [sender?.firstName, sender?.lastName].filter(Boolean).join(" ") ||
        sender?.username ||
        "UNKNOWN";

      const isServiceMessage = message.className === "MessageService";
      const eventTitle = extractTitleChange(message);
      if (isServiceMessage && eventTitle) {
        if (!allowTitleEvent(peerId, `event::${eventTitle}`)) {
          console.log("群名变更命中冷却，跳过推送：", { chatName: chatInfo.name, eventTitle });
          return;
        }

        const output = [
          "【群名称变更提醒】",
          "",
          `来源群：${chatInfo.name}`,
          `操作人：${operatorName}`,
          `新群名：${eventTitle}`,
        ].join("\n");

        await client.sendMessage(outputEntity, { message: output });
        console.log(`已推送群名变更提醒 -> ${chatInfo.name} => ${eventTitle}`);
        return;
      }

      const text = normalizeText(message.message || "");
      if (!text) return;

      if (isTitleChangeText(text)) {
        if (!allowTitleEvent(peerId, `text::${text}`)) {
          console.log("群名变更文本命中冷却，跳过推送：", { chatName: chatInfo.name, text });
          return;
        }

        const output = [
          "【群名称变更提醒】",
          "",
          `来源群：${chatInfo.name}`,
          `操作人：${operatorName}`,
          "变更内容：",
          text,
        ].join("\n");

        await client.sendMessage(outputEntity, { message: output });
        console.log(`已推送群名变更文本提醒 -> ${chatInfo.name}`);
        return;
      }

      console.log("收到消息：", { peerId, chatName: chatInfo.name, text });
      const matched = matchKeywords(text);
      if (matched.length === 0) {
        console.log("未命中关键词：", text);
        return;
      }

      const { allowed, skipped } = filterKeywordsByCooldown(peerId, matched);
      if (allowed.length === 0) {
        console.log("命中冷却，跳过推送：", { chatName: chatInfo.name, skipped });
        return;
      }
      if (skipped.length > 0) {
        console.log("部分关键词命中冷却：", { chatName: chatInfo.name, skipped, allowed });
      }

      const output = [
        "【群消息监听提醒】",
        "",
        `来源群：${chatInfo.name}`,
        `发送人：${operatorName}`,
        `命中关键词：${allowed.join("、")}`,
        "",
        "消息内容：",
        shortText(text),
      ].join("\n");

      await client.sendMessage(outputEntity, { message: output });
      console.log(`已推送提醒 -> ${chatInfo.name} | ${allowed.join(",")}`);
    } catch (err) {
      console.error("发送监听报错：", err.message || err);
    }
  }, new NewMessage({ incoming: true, outgoing: true }));
})();
