# 🔌 LINE 推播部署卡（M1・照順序點，約 20 分鐘）

> 三個零件已寫好：`supabase/functions/line-webhook/index.ts`（接待員）、
> `supabase/functions/line-push/index.ts`（推播員）、`setup-line.sql`（門鈴）。
> 這張卡是「把零件裝上雲端」的步驟。
>
> ⚠️ 全程會用到兩把 LINE 鑰匙（存在你的 `Documents\laolu-line-keys.txt`）。
> 鑰匙只貼進 Supabase 保險箱，**不進 GitHub、不進聊天、不進截圖**。

---

## 第 1 站｜Supabase 保險箱：存鑰匙

Supabase 儀表板 → 左邊選單 **Edge Functions** → **Secrets**（或 Settings → Edge Functions）→ 新增四筆：

| 名稱（一字不差） | 值 |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | 記事本裡那串長的（token） |
| `LINE_CHANNEL_SECRET` | 記事本裡那串短的（secret） |
| `BOSS_BIND_CODE` | 自己發明一句密語（例：滷蛋加辣）——老闆綁定時要對的暗號 |
| `WEBHOOK_SECRET` | 自己發明一串亂碼（例：亂打 20 個英數字）——資料庫叫推播員的通行碼 |

後面兩個是你**現在自己發明**的，發明完順手抄進 `laolu-line-keys.txt` 保存。

## 第 2 站｜部署兩個雲端函式

儀表板 **Edge Functions** → **Deploy a new function**（用網頁編輯器）：

1. 函式名稱填 `line-webhook` → 把 `supabase/functions/line-webhook/index.ts` 整份內容貼進去 → Deploy
2. 再建第二個，名稱 `line-push` → 貼 `supabase/functions/line-push/index.ts` → Deploy
3. ⚠️ **兩個函式都要把「Verify JWT」關掉**（函式的 Details/設定裡有開關）——
   因為叫它們的是 LINE 和資料庫，不是登入的使用者；我們用簽章＋通行碼自己驗身分

## 第 3 站｜裝門鈴（SQL）

1. 打開本機的 `setup-line.sql`，把裡面**兩處**【WEBHOOK_SECRET】換成第 1 站發明的那串亂碼
2. Supabase 儀表板 → **SQL Editor** → 貼上整份 → **Run**
3. ⚠️ 換過真值的檔案**不要 commit**（repo 是公開的）；跑完把檔案裡的真值改回【WEBHOOK_SECRET】佔位符

## 第 4 站｜告訴 LINE 我們的收件地址

[LINE Developers](https://developers.line.biz) → 老滷仙 Provider → Messaging API channel → **Messaging API 分頁**：

1. **Webhook URL** 填：`https://wwirnzsbqrqafyjrvgkn.supabase.co/functions/v1/line-webhook`
2. 按 **Verify**（驗證）→ 應該顯示 Success ✅
3. **Use webhook（使用 Webhook）** 開關打開

## 第 5 站｜關掉罐頭自動回覆（不然會跟接待員搶話）

[LINE 官方帳號後台](https://manager.line.biz) → 老滷仙帳號 → **回應設定**：

- **Webhook**：開 ✅
- **自動回應訊息**：關 ❌（不關的話客人每句話都會收到兩則回覆）

## 第 6 站｜實測（你＝第一個客人 🎉）

照順序，每步都該有反應：

| # | 動作 | 應該發生 |
|---|---|---|
| 1 | 用你的 LINE 掃 QR code 加好友 | 收到歡迎詞 🍢 |
| 2 | 傳「id」 | 回你一串用戶編號（＝接待員活著） |
| 3 | 傳「老闆綁定 你的密語」 | ✅ 老闆綁定成功（測試期你先兼任老闆） |
| 4 | 去點餐網下一張測試單 | 你的 LINE 收到「🔔 新訂單」（＝門鈴＋推播員都活著） |
| 5 | 傳訂單的取餐編號（例：004） | ✅ 綁定成功 |
| 6 | 開 boss.html 按「確認接單」→ 選時間 → 知道了 | 你的 LINE 收到取餐時間訊息（＝**全線貫通** 🏆） |

第 6 步的訊息長相，就是 M0.75 預覽視窗裡那份——當時的「假測試平台」，今天通真電。

## 🚑 卡住的話

- 第 4 站 Verify 失敗 → 回第 2 站檢查 `line-webhook` 的 Verify JWT 有沒有關
- 第 2 步傳 id 沒反應 → 檢查第 5 站的 Webhook 開關＋自動回應
- 第 4 步沒收到新訂單通知 → 檢查 setup-line.sql 的通行碼是否跟 Secrets 裡的 `WEBHOOK_SECRET` 一字不差
- 都對還是不通 → 儀表板 Edge Functions → 對應函式 → **Logs** 看錯誤訊息，截圖給細菌

---
測通後回報細菌：①更新 boss.html 預覽視窗的「⏳ 尚未串接」小字 ②把這批程式 commit + push ③老闆的正式綁定與門面設定（等溝通）
