# 📱 M3 部署卡：LIFF 化＋改時間通知＋訊息條列改版

> 2026-07-19 凌晨細菌夜班。這一包三件事：
> ① 點餐頁 LIFF 化（客人從 LINE 開＝自動認人，免傳取餐編號）
> ② 補「改時間通知客人」（門鈴第四鈴聲）
> ③ 訊息品項改條列式＋新單卡片粗體（Riley 實測裁示）
>
> 驗證：語法全過＋訊息格式實際生成核對過。LIFF 未填 ID 前＝完全不啟動（安全預設）。

---

## 步驟一：開 LIFF、拿 ID（Riley，10 分鐘）

1. [LINE Developers](https://developers.line.biz) → 老滷仙 Provider → **建議新增一個 LINE Login channel**（LIFF 要掛在 channel 下；如果 Messaging API channel 裡直接有 LIFF 分頁，用它也行）
2. 進 channel → **LIFF** 分頁 → **Add**：
   - LIFF app name：`老滷仙點餐`
   - Size：**Full**（全螢幕）
   - Endpoint URL：`https://riley-lin.github.io/laolu-order/index.html`
   - Scopes：勾 **profile**
   - 其他預設 → Add
3. 建好會得到一個 **LIFF ID**（長得像 `1234567890-abcdefgh`）→ **貼給細菌**，我填進程式後 push
   （或你自己改：`index.html` 搜 `const LIFF_ID = ''`，把 ID 填進引號）

## 步驟二：跑 SQL（1 分鐘，保險櫃版免貼碼 🎉）

SQL Editor → 新分頁貼 `setup-retime.sql` 整份 → Run → `Success. No rows returned`

## 步驟三：重部署 `line-push`（3 分鐘）

老方法：本機 `supabase/functions/line-push/index.ts` 全選複製 → Edge Functions → line-push → Code → 覆蓋 → Deploy
（驗證換版：Ctrl+F 搜 `buildRetimedMessage`）
`line-webhook` 這次**不用動**。

## 步驟四：UAT

- [ ] **訊息條列**：下測試單 → 老闆卡片品項一行一項＋**粗體**；接單後客人確認訊息也是條列
- [ ] **LIFF 入口**：LIFF URL＝`https://liff.line.me/你的LIFF_ID`——自己在 LINE 傳這個網址給自己 → 點開 → 點餐頁**開在 LINE 裡面**
- [ ] **自動認人**：LIFF 裡點餐走到結帳 → 姓名欄**已自動填你的 LINE 名字**
- [ ] **自動綁定**：LIFF 裡送出訂單 → **不用傳取餐編號**，老闆接單瞬間你的 LINE 直接收到取餐時間 🎉
- [ ] **改時間通知**：看單台對這張單按「⏰ 改時間」改成別的 → 你的 LINE 收到「取餐時間更新：新時間（原 XX:XX）」
- [ ] **一般瀏覽器不受影響**：無痕視窗開點餐頁 → 一切照舊（姓名自己填、傳編號綁定）

## 📇 LIFF 名片夾（2026-07-19 開通，兩個都在 LINE Login channel「老滷仙點餐」下）

| 用途 | LIFF ID | 連結（傳進 LINE 點開即用） |
|---|---|---|
| 🍢 **客人點餐**（index.html，自動綁定） | `2010753920-y35aYY9d` | `https://liff.line.me/2010753920-y35aYY9d` |
| 🧑‍🍳 **老闆店務**（boss.html：菜單/編輯/改時間/日報） | `2010753920-djANTSoR` | `https://liff.line.me/2010753920-djANTSoR` |

- 點餐連結＝之後 M1.5 圖文選單「我要點餐」按鈕要掛的網址
- 店務連結＝給老闆釘選在聊天室／存 Keep；首次要登入老闆帳號，之後 LINE 會記住
- 店務頁 Add friend option＝Off（自用，不推加好友）

## 之後接著做（M3 下半場）

- **M1.5 圖文選單**：LINE 官方帳號後台 → 圖文選單 →「🍢 我要點餐」按鈕 → 動作＝開 LIFF URL——客人體驗從此＝「點選單、菜單開在 LINE 裡、下單自動綁定」，全劇終
- **老闆店務頁**（可選）：再開一個 LIFF 指向 boss.html，老闆在 LINE 裡管菜單/改單/日報（或直接教他「加到主畫面」，效果一樣）
- 老闆五題問卷答案回來 → 打烊時段顯示＋暫停接單開關

## 設計筆記

- `LIFF_ID` 空字串＝整段 LIFF 邏輯不啟動，**先 push 也不影響現有客人**（安全預設）
- LIFF 認人失敗（網路、權限、任何鬼）＝靜默退回一般網頁模式——點餐永遠不能被 LIFF 卡住
- 姓名自動帶入後客人仍可改（帶入的是 LINE 暱稱，可能是「小明爸爸」這種，要讓人能改成真名）
- 客人純文字訊息無法粗體（LINE 限制）；粗體只在 Flex 卡片（老闆端）
