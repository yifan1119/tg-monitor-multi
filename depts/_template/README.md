# Department Template

這是新增部門時的範本。**不要在這目錄底下跑實際服務** — 每個新部門會從這裡複製出自己的目錄。

## 新增部門的兩種方式

### A. 用 Web 介面（推薦，v0.4 完成）
```
啟動 Web 後台 → http://<vps>:5003/depts → ➕新增部門
→ 填表單 → 自動生成目錄 + 跳轉 TG 登入 wizard
```

### B. 用 CLI（D2 完成）
```bash
bash scripts/new-dept.sh <dept_name> "<中轉群名>" <sheet_id> "<sheet_分頁名>"
cd depts/<dept_name>
node ../../scripts/login-dept.js   # 跑 TG 登入拿 session.txt
```

## 目錄結構（部門新增後）

```
depts/<dept_name>/
├── config.json        ← 從 config.json.example 複製並填實際值
├── .env               ← TG_API_ID / TG_API_HASH
├── session.txt        ← gram.js StringSession（登入後自動生成）
└── state/             ← 運行時狀態（自動生成）
    ├── event_history.jsonl
    └── pending_title_events.json
```

## 命名規則

- **dept_name**：小寫英文 + 連字號，長度 2-32，例：`demo1`, `dept-02`, `client-01`
- **不可用**：空白、中文、特殊符號、保留字（`_template` / `_shared` / `root`）
