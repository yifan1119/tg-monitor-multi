// web/lib/error-translator.js
//
// 把 Google / Node / gram.js 常见英文错误翻译成人话.
// 所有对外报错都走这个, 不给用户看裸英文.

"use strict";

const RULES = [
  // Google Sheets
  { re: /Requested entity was not found/i,
    zh: "找不到这张 Sheet. 确认 ID 有没有复制完整, 以及 Google SA 有没有被加为'编辑者'." },
  { re: /The caller does not have permission|PERMISSION_DENIED/i,
    zh: "SA 没权限访问这张 Sheet. 请到 Sheet → 共享, 把 SA email 加为'编辑者'." },
  { re: /Unable to parse range|Invalid range/i,
    zh: "分页名称或范围错误, 检查分页名称有没有打错." },
  { re: /Unable to parse .*spreadsheetId/i,
    zh: "Spreadsheet ID 格式错误, 从 Sheet 网址 /d/<这段>/edit 复制" },
  { re: /unauthorized_client|invalid_grant/i,
    zh: "Google SA 凭证失效. 重新上传 google-service-account.json." },
  { re: /Quota exceeded|RESOURCE_EXHAUSTED/i,
    zh: "Google API 调用次数超限, 等一会再试 (Google 限制每分钟 60 次写入)." },
  { re: /rate.?limit/i,
    zh: "调用太频繁被限流了, 等 1 分钟再试." },
  // 网络
  { re: /ENOTFOUND|getaddrinfo|ENETUNREACH/i,
    zh: "网络连不上 Google. 检查 VPS 网络或 DNS." },
  { re: /ECONNREFUSED/i,
    zh: "连接被拒. 目标服务可能没启动." },
  { re: /ETIMEDOUT|timed? ?out/i,
    zh: "连接超时. 网络不稳或目标服务响应慢." },
  // TG
  { re: /PHONE_NUMBER_INVALID/i,
    zh: "手机号格式错, 必须含国码 (例: +8613800138000)." },
  { re: /PHONE_CODE_INVALID/i,
    zh: "验证码错误, 重新输入." },
  { re: /PHONE_CODE_EXPIRED/i,
    zh: "验证码过期, 回上一步重新发送." },
  { re: /SESSION_PASSWORD_NEEDED/i,
    zh: "此账号开了两步验证, 请输入 2FA 密码." },
  { re: /PASSWORD_HASH_INVALID/i,
    zh: "2FA 密码错误." },
  { re: /FLOOD_WAIT/i,
    zh: "TG 限流了, 等几分钟再试." },
  { re: /AUTH_KEY_UNREGISTERED|USER_DEACTIVATED/i,
    zh: "TG 账号已登出或被封. 重新登入." },
  { re: /CHAT_WRITE_FORBIDDEN/i,
    zh: "此账号不能在这个群发言 (禁言 / 非成员)." },
  // 文件
  { re: /ENOENT/i,
    zh: "文件不存在 (可能路径错或还没建)." },
  { re: /EACCES|permission denied/i,
    zh: "没有文件读写权限." },
];

function translate(err) {
  const msg = (err && err.message) || String(err || "");
  for (const r of RULES) {
    if (r.re.test(msg)) return r.zh;
  }
  return msg; // 没匹配就原样返回
}

module.exports = { translate };
