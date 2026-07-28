-- ============================================================
-- 🧪 通知可靠性 · 驗收五項（2026-07-29）
--
-- 用法：Supabase → SQL Editor → 貼整份 → Run
--       每一段都會自己印出「✅ 通過 / ❌ 沒過」，不用自己判讀數字
--
-- ⚠️ 第 4、5 項需要「真的下一張測試單」，所以分兩次跑：
--    第一次跑：看第 1~3 項（結構與保溫）
--    下一張單之後再跑一次：看第 4~5 項（紀錄與重推）
-- ============================================================


-- ------------------------------------------------------------
-- ① 兩個排程有沒有掛上、是不是啟用中
-- ------------------------------------------------------------
select
  '① 排程' as 項目,
  jobname as 名稱,
  schedule as 頻率,
  active as 啟用中,
  case
    when jobname = 'laolu-retry-push' and schedule = '* * * * *'   and active then '✅ 通過'
    when jobname = 'laolu-warm-push'  and schedule = '*/5 * * * *' and active then '✅ 通過'
    else '❌ 設定不對'
  end as 結果
from cron.job
where jobname like 'laolu-%'
order by jobname;
-- 👉 應該看到「兩列」，兩列都 ✅。只看到一列或零列 ＝ SQL 沒跑完整


-- ------------------------------------------------------------
-- ② 資料表結構（push_log 表 ＋ orders 的重推次數欄位）
-- ------------------------------------------------------------
select
  '② 結構' as 項目,
  case when exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'push_log'
  ) then '✅ push_log 表已建立' else '❌ 找不到 push_log 表' end as 推播紀錄表,
  case when exists (
    select 1 from information_schema.columns
     where table_name = 'orders' and column_name = 'push_retry_count'
  ) then '✅ push_retry_count 欄位已加' else '❌ orders 沒有這個欄位' end as 重推次數欄位,
  case when exists (
    select 1 from pg_policies
     where tablename = 'push_log' and policyname = 'boss reads push_log'
  ) then '✅ 已上鎖（前端讀不到）' else '❌ RLS 政策沒建立' end as 權限;


-- ------------------------------------------------------------
-- ③ 保溫真的在跑嗎（這項最關鍵——#015 就是敗在它睡著）
--    ⚠️ 剛跑完 SQL 要「等 5 分鐘以上」再驗，不然當然是 0 筆
-- ------------------------------------------------------------
with 最近一小時 as (
  select status_code, created
    from net._http_response
   where created > now() - interval '1 hour'
)
select
  '③ 保溫' as 項目,
  count(*) as 最近一小時次數,
  count(*) filter (where status_code = 200) as 成功次數,
  count(*) filter (where status_code <> 200) as 失敗次數,
  case
    when count(*) = 0 then '⏳ 還沒開始跑，等 5 分鐘再驗一次'
    when count(*) filter (where status_code <> 200) = 0 then '✅ 通過（全部 200）'
    else '⚠️ 有失敗，往下看明細'
  end as 結果
from 最近一小時;

-- 明細（上面如果有失敗，看這裡是哪幾筆、回什麼碼）
select
  id,
  status_code as 狀態碼,
  to_char(created at time zone 'Asia/Taipei', 'HH24:MI:SS') as 台北時間,
  case when status_code = 200 then '✅' else '❌ ' || coalesce(error_msg, '') end as 結果
from net._http_response
where created > now() - interval '1 hour'
order by created desc
limit 15;
-- 👉 正常長相：每 5 分鐘一筆 200（例如 14:00 / 14:05 / 14:10…）
-- 👉 若時間間隔亂七八糟，代表排程沒照表跑


-- ------------------------------------------------------------
-- ④ 推播紀錄有沒有寫進去（要先下一張測試單）
-- ------------------------------------------------------------
select
  '④ 推播紀錄' as 項目,
  order_no as 訂單,
  kind as 類型,
  case when ok then '✅ 成功' else '❌ 失敗' end as 結果,
  status_code as LINE回應,
  coalesce(error, '') as 錯誤訊息,
  to_char(created_at at time zone 'Asia/Taipei', 'MM-DD HH24:MI:SS') as 台北時間
from public.push_log
order by created_at desc
limit 20;
-- 👉 下完測試單應該立刻出現：kind = new_order、ok = true、status_code = 200
-- 👉 完全空的 ＝ line-push 沒部署到新版（回去重貼 index.ts）


-- ------------------------------------------------------------
-- ⑤ 保底重推的狀態（下一張單「故意不要接」，等 3 分鐘）
-- ------------------------------------------------------------
select
  '⑤ 保底重推' as 項目,
  order_no as 訂單,
  status as 狀態,
  push_retry_count as 已補推次數,
  round(extract(epoch from (now() - created_at)) / 60) as 建立幾分鐘前,
  case
    when status <> 'new' then '—（已接單，不需補推）'
    when now() - created_at < interval '3 minutes' then '⏳ 還沒到 3 分鐘，再等等'
    when push_retry_count > 0 then '✅ 通過（有補推，老闆該收到🔁橘色卡片）'
    else '❌ 超過 3 分鐘卻沒補推 → 排程沒在跑'
  end as 結果
from public.orders
where created_at > now() - interval '2 hours'
order by created_at desc
limit 10;
-- 👉 這項要「故意不接單」才驗得出來
-- 👉 老闆手機上會收到一張橘色「🔁 補發通知 #XXX」，那就是成功
