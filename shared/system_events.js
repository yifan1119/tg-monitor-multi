require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Raw } = require("telegram/events");

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

if (!apiId || !apiHash) {
  console.error("缺少 TG_API_ID 或 TG_API_HASH");
  process.exit(1);
}

if (!fs.existsSync("./session.txt")) {
  console.error("缺少 session.txt，请先运行 login.js 登录这个系统事件监听账号");
  process.exit(1);
}

const sessionString = fs.readFileSync("./session.txt", "utf8").trim();
const stringSession = new StringSession(sessionString);

const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
});

const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
const listenMode = config.listenMode || "all-groups";
const listenChats = new Set((config.listenChats || []).map(String));
const outputChatName = config.outputChatName;
const eventTypes = new Set(config.eventTypes || []);
const titleEventCooldownMs = Number(config.titleEventCooldownMs || 60000);
const retryIntervalMs = Number(config.retryIntervalMs || 60000);
const retryLookbackMs = Number(config.retryLookbackMs || 10 * 60 * 1000);
const maxRetryCount = Number(config.maxRetryCount || 10);
const backfillLimit = Number(config.backfillLimit || 50);
const backfillWindowMs = Number(config.backfillWindowMs || 10 * 60 * 1000);
const titleMergeWindowMs = Number(config.titleMergeWindowMs || 60 * 1000);
const historyLookbackMs = Number(config.historyLookbackMs || 7 * 24 * 60 * 60 * 1000);
const queueFile = path.resolve("./pending_title_events.json");
const historyFile = path.resolve("./event_history.jsonl");

const titleEventCooldownMap = new Map();
const chatNameCache = new Map();
let outputEntityRef = null;
let dialogsCache = [];

function cleanupCooldowns(now = Date.now()) {
  for (const [key, ts] of titleEventCooldownMap.entries()) {
    if (now - ts >= titleEventCooldownMs) titleEventCooldownMap.delete(key);
  }
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

function normalizeText(text = "") {
  return String(text).replace(/\r/g, "").trim();
}

function buildEventKey(instance, peerId, oldTitle, newTitle) {
  return [
    normalizeText(instance),
    String(peerId || ""),
    "group-title-changed",
    normalizeText(oldTitle),
    normalizeText(newTitle),
  ].join("||");
}

function readJsonArray(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function writeJsonArray(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadQueue() {
  return readJsonArray(queueFile);
}

function saveQueue(queue) {
  writeJsonArray(queueFile, queue);
}

function readHistoryLines() {
  try {
    if (!fs.existsSync(historyFile)) return [];
    const raw = fs.readFileSync(historyFile, "utf8").trim();
    if (!raw) return [];
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (_) {
    return [];
  }
}

function appendHistory(event) {
  const line = JSON.stringify(event, null, 0) + "\n";
  fs.appendFileSync(historyFile, line);
}

function pruneHistory() {
  const now = Date.now();
  const items = readHistoryLines().filter((item) => {
    const createdAtMs = Date.parse(item.createdAt || item.eventTime || 0) || 0;
    return now - createdAtMs <= historyLookbackMs;
  });

  if (!items.length) {
    fs.writeFileSync(historyFile, "");
    return;
  }

  fs.writeFileSync(historyFile, items.map((item) => JSON.stringify(item)).join("\n") + "\n");
}

function historyHasEvent(eventKey) {
  const items = readHistoryLines();
  return items.some((item) => item.eventKey === eventKey);
}

function removeQueueEvent(eventKey) {
  const queue = loadQueue().filter((item) => item.eventKey !== eventKey);
  saveQueue(queue);
}

function removeHistoryEvent(eventKey) {
  const items = readHistoryLines().filter((item) => item.eventKey !== eventKey);
  if (!items.length) {
    fs.writeFileSync(historyFile, "");
    return;
  }
  fs.writeFileSync(historyFile, items.map((item) => JSON.stringify(item)).join("\n") + "\n");
}

function mergeRecentTitleEvents(event) {
  const nowMs = Date.parse(event.eventTime || 0) || Date.now();
  const items = readHistoryLines();
  let removed = false;

  for (const item of items) {
    if (item.instance !== event.instance) continue;
    if (item.eventType !== "group-title-changed") continue;
    if (String(item.peerId) !== String(event.peerId)) continue;

    const itemMs = Date.parse(item.eventTime || 0) || 0;
    if (Math.abs(nowMs - itemMs) > titleMergeWindowMs) continue;

    if (normalizeText(item.newTitle) === normalizeText(event.oldTitle)) {
      removeQueueEvent(item.eventKey);
      removeHistoryEvent(item.eventKey);
      removed = true;
    }
  }

  return removed;
}

function upsertQueueEvent(event) {
  const queue = loadQueue();
  const idx = queue.findIndex((item) => item.eventKey === event.eventKey);
  if (idx >= 0) {
    queue[idx] = {
      ...queue[idx],
      ...event,
      updatedAt: new Date().toISOString(),
    };
  } else {
    queue.push({
      ...event,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  saveQueue(queue);
}

function markQueueEventSent(eventKey) {
  const queue = loadQueue();
  const idx = queue.findIndex((item) => item.eventKey === eventKey);
  if (idx >= 0) {
    queue[idx].status = "sent";
    queue[idx].sentAt = new Date().toISOString();
    queue[idx].updatedAt = new Date().toISOString();
    queue[idx].lastError = "";
    saveQueue(queue);
  }
}

function markQueueEventFailed(eventKey, err) {
  const queue = loadQueue();
  const idx = queue.findIndex((item) => item.eventKey === eventKey);
  if (idx >= 0) {
    const currentRetries = Number(queue[idx].retryCount || 0) + 1;
    queue[idx].status = "failed";
    queue[idx].retryCount = currentRetries;
    queue[idx].lastError = err?.message || String(err || "unknown error");
    queue[idx].lastTriedAt = new Date().toISOString();
    queue[idx].updatedAt = new Date().toISOString();
    saveQueue(queue);
  }
}

function getRetryableEvents() {
  const queue = loadQueue();
  const now = Date.now();
  return queue.filter((item) => {
    const createdAtMs = Date.parse(item.createdAt || 0) || 0;
    const withinWindow = now - createdAtMs <= retryLookbackMs;
    const retryCount = Number(item.retryCount || 0);
    const retryableStatus = item.status === "pending" || item.status === "failed";
    return withinWindow && retryableStatus && retryCount < maxRetryCount;
  });
}

async function findDialogEntityByName(name) {
  const dialogs = await client.getDialogs({});
  for (const dialog of dialogs) {
    if ((dialog.name || "").trim() === name) return dialog.entity;
  }
  return null;
}

async function refreshDialogsCache() {
  dialogsCache = await client.getDialogs({});
  return dialogsCache;
}

async function warmupChatNameCache() {
  const dialogs = await refreshDialogsCache();
  for (const dialog of dialogs) {
    const entity = dialog.entity;
    const id =
      entity?.id?.toString?.() ||
      entity?.userId?.toString?.() ||
      entity?.chatId?.toString?.() ||
      entity?.channelId?.toString?.();
    if (id) chatNameCache.set(id, dialog.name || id);
  }
}

function getCachedChatName(peerId) {
  return chatNameCache.get(String(peerId)) || String(peerId);
}

function setCachedChatName(peerId, name) {
  if (!peerId || !name) return;
  chatNameCache.set(String(peerId), String(name));
}

async function shouldListen(peerId, currentKnownName, outputChatNameValue) {
  if (!peerId) return false;
  if (currentKnownName === outputChatNameValue) return false;
  if (listenMode === "all-groups") return true;
  return listenChats.has(String(peerId));
}

function unknownUserLabel(peer) {
  const userId = peer?.userId?.toString?.() || peer?.userId || "未知ID";
  return `未知用户（ID: ${userId}）`;
}

async function getUserNameByPeer(peer) {
  try {
    if (!peer?.userId) return unknownUserLabel(peer);
    const entity = await client.getEntity(peer);
    return [entity?.firstName, entity?.lastName].filter(Boolean).join(" ") || entity?.username || unknownUserLabel(peer);
  } catch (_) {
    return unknownUserLabel(peer);
  }
}

async function getPinnedMessageSummary(peerId, replyTo) {
  try {
    if (!replyTo?.replyToMsgId) return "无法读取置顶消息内容";
    const peer = Number.isNaN(Number(peerId)) ? peerId : Number(peerId);
    const messages = await client.getMessages(peer, { ids: [replyTo.replyToMsgId] });
    const msg = Array.isArray(messages) ? messages[0] : messages;
    if (!msg) return `消息ID：${replyTo.replyToMsgId}`;
    const text = (msg.message || "").trim();
    if (!text) return `消息ID：${replyTo.replyToMsgId}`;
    return text.length > 100 ? text.slice(0, 100) + "..." : text;
  } catch (_) {
    return "无法读取置顶消息内容";
  }
}

function getPeerIdFromMessage(message) {
  return message.peerId?.chatId?.toString?.() || message.peerId?.channelId?.toString?.() || null;
}

function buildTitleEventRecord({ instance, peerId, oldTitle, newTitle, operatorName, source, messageId = "", eventTime = "" }) {
  return {
    eventKey: buildEventKey(instance, peerId, oldTitle, newTitle),
    instance,
    eventType: "group-title-changed",
    peerId: String(peerId),
    oldTitle,
    newTitle,
    operatorName,
    source,
    messageId: String(messageId || ""),
    eventTime: eventTime || new Date().toISOString(),
    status: "pending",
    retryCount: 0,
    lastError: "",
  };
}

function ensureHistory(event, mode = "new") {
  if (historyHasEvent(event.eventKey)) {
    return false;
  }

  appendHistory({
    ...event,
    historyMode: mode,
    createdAt: new Date().toISOString(),
  });
  return true;
}

async function sendQueuedTitleEvent(event) {
  const output = [
    "【群名称变更提醒】",
    "",
    `原群名：${event.oldTitle}`,
    `操作人：${event.operatorName}`,
    `新群名：${event.newTitle}`,
  ].join("\n");

  await client.sendMessage(outputEntityRef, { message: output });
  setCachedChatName(event.peerId, event.newTitle);
  markQueueEventSent(event.eventKey);
  console.log(`已推送群名变更提醒 -> ${event.oldTitle} => ${event.newTitle}`);
}

async function enqueueAndSendTitleEvent({ instance, peerId, oldTitle, newTitle, operatorName, source, messageId = "", eventTime = "" }) {
  const event = buildTitleEventRecord({
    instance,
    peerId,
    oldTitle,
    newTitle,
    operatorName,
    source,
    messageId,
    eventTime,
  });

  mergeRecentTitleEvents(event);

  const inserted = ensureHistory(event, source === "backfill" ? "recovered" : "realtime");
  if (!inserted) {
    return false;
  }

  upsertQueueEvent(event);

  try {
    await sendQueuedTitleEvent(event);
  } catch (err) {
    markQueueEventFailed(event.eventKey, err);
    console.error(`群名变更推送失败，已入补推队列 -> ${oldTitle} => ${newTitle} | ${err.message || err}`);
  }

  return true;
}

async function retryPendingTitleEvents() {
  const events = getRetryableEvents();
  for (const event of events) {
    try {
      await sendQueuedTitleEvent(event);
      console.log(`补推成功 -> ${event.oldTitle} => ${event.newTitle}`);
    } catch (err) {
      markQueueEventFailed(event.eventKey, err);
      console.error(`补推失败 -> ${event.oldTitle} => ${event.newTitle} | ${err.message || err}`);
    }
  }
}

async function processTitleChangeMessage({ instance, message, source = "realtime", bypassCooldown = false }) {
  if (!message || message.className !== "MessageService") return;

  const peerId = getPeerIdFromMessage(message);
  if (!peerId) return;

  const currentName = getCachedChatName(peerId);
  if (!(await shouldListen(peerId, currentName, outputChatName))) {
    return;
  }

  const actionClass = message.action?.className || "";
  if (!(eventTypes.has("group-title-changed") && actionClass === "MessageActionChatEditTitle")) {
    return;
  }

  const oldTitle = currentName;
  const newTitle = message.action.title || "UNKNOWN";
  const eventKey = buildEventKey(instance, peerId, oldTitle, newTitle);

  if (normalizeText(oldTitle) === normalizeText(newTitle)) {
    return;
  }

  if (!bypassCooldown && !allowTitleEvent(peerId, newTitle)) {
    return;
  }

  if (historyHasEvent(eventKey)) {
    return;
  }

  const operatorName = await getUserNameByPeer(message.fromId);
  const event = buildTitleEventRecord({
    instance,
    peerId,
    oldTitle,
    newTitle,
    operatorName,
    source,
    messageId: message.id?.toString?.() || "",
    eventTime: message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString(),
  });

  if (source === "backfill") {
    const merged = mergeRecentTitleEvents(event);
    const inserted = ensureHistory(event, "recovered");
    if (inserted) {
      upsertQueueEvent({ ...event, status: "recovered", recoveredAt: new Date().toISOString() });
      markQueueEventSent(event.eventKey);
      console.log(`已补采群名事件(仅统计) -> ${oldTitle} => ${newTitle} | 来源=${source}${merged ? " | 已合并旧中间态" : ""}`);
    }
    return;
  }

  const inserted = await enqueueAndSendTitleEvent({
    instance,
    peerId,
    oldTitle,
    newTitle,
    operatorName,
    source,
    messageId: message.id?.toString?.() || "",
    eventTime: message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString(),
  });

  if (inserted) {
    console.log(`已落地群名事件 -> ${oldTitle} => ${newTitle} | 来源=${source}`);
  }
}

async function backfillRecentTitleEvents(instance) {
  try {
    const dialogs = dialogsCache.length ? dialogsCache : await refreshDialogsCache();
    for (const dialog of dialogs) {
      const dialogName = (dialog.name || "").trim();
      if (!(await shouldListen(dialog.entity?.id?.toString?.() || dialog.entity?.chatId?.toString?.() || dialog.entity?.channelId?.toString?.(), dialogName, outputChatName))) {
        continue;
      }

      const messages = await client.getMessages(dialog.entity, { limit: backfillLimit });
      const list = Array.isArray(messages) ? messages : [messages];
      const now = Date.now();
      for (const message of list.reverse()) {
        const messageMs = message?.date ? message.date * 1000 : 0;
        if (messageMs && now - messageMs > backfillWindowMs) {
          continue;
        }
        await processTitleChangeMessage({
          instance,
          message,
          source: "backfill",
          bypassCooldown: true,
        });
      }
    }
  } catch (err) {
    console.error("群名变更补采报错：", err.message || err);
  }
}

(async () => {
  const instance = path.basename(process.cwd());

  await client.connect();
  await warmupChatNameCache();
  pruneHistory();

  outputEntityRef = await findDialogEntityByName(outputChatName);
  if (!outputEntityRef) {
    console.error(`找不到输出目标：${outputChatName}`);
    process.exit(1);
  }

  console.log(`系统事件监听器（统计补采版）已启动，输出目标：${outputChatName}，监听模式：${listenMode}`);

  client.addEventHandler(async (event) => {
    try {
      const update = event;
      if (!update || update.className !== "UpdateNewMessage") return;

      const message = update.message;
      await processTitleChangeMessage({ instance, message, source: "realtime" });

      if (!message || message.className !== "MessageService") return;

      const peerId = getPeerIdFromMessage(message);
      if (!peerId) return;
      const currentName = getCachedChatName(peerId);
      if (!(await shouldListen(peerId, currentName, outputChatName))) return;

      const actionClass = message.action?.className || "";

      if (eventTypes.has("member-joined") && (actionClass === "MessageActionChatAddUser" || actionClass === "MessageActionChatJoinedByLink")) {
        const operatorName = await getUserNameByPeer(message.fromId);
        let joinedNames = [];

        if (actionClass === "MessageActionChatAddUser") {
          const users = message.action.users || [];
          for (const user of users) {
            joinedNames.push(await getUserNameByPeer({ userId: user }));
          }
        } else if (actionClass === "MessageActionChatJoinedByLink") {
          joinedNames = [operatorName];
        }

        const output = [
          "【成员进群提醒】",
          "",
          `来源群：${currentName}`,
          `加入成员：${joinedNames.join("、") || "未知用户（ID: 未知）"}`,
          `触发方式：${actionClass === "MessageActionChatJoinedByLink" ? "通过邀请链接加入" : "被拉入群"}`,
        ].join("\n");

        await client.sendMessage(outputEntityRef, { message: output });
        console.log(`已推送成员进群提醒 -> ${currentName} | ${joinedNames.join(",")}`);
        return;
      }

      if (eventTypes.has("member-left") && actionClass === "MessageActionChatDeleteUser") {
        const operatorName = await getUserNameByPeer(message.fromId);
        const leftName = await getUserNameByPeer({ userId: message.action.userId });
        const isSelfLeft = message.fromId?.userId?.toString?.() === message.action.userId?.toString?.();

        const output = [
          "【成员退群提醒】",
          "",
          `来源群：${currentName}`,
          `离开成员：${leftName}`,
          `触发方式：${isSelfLeft ? "主动退群" : "被移出群"}`,
          `操作人：${isSelfLeft ? leftName : operatorName}`,
        ].join("\n");

        await client.sendMessage(outputEntityRef, { message: output });
        console.log(`已推送成员退群提醒 -> ${currentName} | ${leftName}`);
        return;
      }

      if (eventTypes.has("group-photo-changed") && (actionClass === "MessageActionChatEditPhoto" || actionClass === "MessageActionChatDeletePhoto")) {
        const operatorName = await getUserNameByPeer(message.fromId);
        const actionText = actionClass === "MessageActionChatDeletePhoto" ? "删除了群头像" : "更换了群头像";

        const output = [
          "【群头像变更提醒】",
          "",
          `来源群：${currentName}`,
          `操作人：${operatorName}`,
          `变更内容：${actionText}`,
        ].join("\n");

        await client.sendMessage(outputEntityRef, { message: output });
        console.log(`已推送群头像变更提醒 -> ${currentName} | ${actionText}`);
        return;
      }

      if (eventTypes.has("message-pinned") && actionClass === "MessageActionPinMessage") {
        const operatorName = await getUserNameByPeer(message.fromId);
        const pinnedSummary = await getPinnedMessageSummary(peerId, message.replyTo);

        const output = [
          "【置顶消息提醒】",
          "",
          `来源群：${currentName}`,
          `操作人：${operatorName}`,
          "置顶内容：",
          pinnedSummary,
        ].join("\n");

        await client.sendMessage(outputEntityRef, { message: output });
        console.log(`已推送置顶消息提醒 -> ${currentName}`);
        return;
      }
    } catch (err) {
      console.error("系统事件监听报错：", err.message || err);
    }
  }, new Raw({}));

  await retryPendingTitleEvents();
  await backfillRecentTitleEvents(instance);
  setInterval(retryPendingTitleEvents, retryIntervalMs);
  setInterval(() => backfillRecentTitleEvents(instance), retryIntervalMs);
  setInterval(pruneHistory, 6 * 60 * 60 * 1000);
})();
