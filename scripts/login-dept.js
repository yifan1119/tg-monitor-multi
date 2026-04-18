require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");
const fs = require("fs");

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

if (!apiId || !apiHash) {
console.error("缺少 TG_API_ID 或 TG_API_HASH");
process.exit(1);
}

const SESSION_FILE = "./session.txt";
const sessionString = fs.existsSync(SESSION_FILE)
? fs.readFileSync(SESSION_FILE, "utf8").trim()
: "";

const stringSession = new StringSession(sessionString);

(async () => {
console.log("开始登录 Telegram 账号...");

const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
  deviceModel: "shencha group",
  systemVersion: "Linux",
  appVersion: "1.0",
  langCode: "zh-CN",
  systemLangCode: "zh-CN",
});

await client.start({
phoneNumber: async () => await input.text("请输入手机号（带国家区号）: "),
password: async () => await input.password("如果有两步验证密码，请输入: "),
phoneCode: async () => await input.text("请输入 Telegram 发来的验证码: "),
onError: (err) => console.log("登录错误:", err.message || err),
});

const me = await client.getMe();
const session = client.session.save();
fs.writeFileSync(SESSION_FILE, session, "utf8");

console.log("登录成功");
console.log("账号信息:");
console.log({
id: me.id?.toString(),
username: me.username || "",
firstName: me.firstName || "",
lastName: me.lastName || "",
});
console.log("session 已保存到 session.txt");

await client.disconnect();
process.exit(0);
})();
