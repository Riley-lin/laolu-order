-- ============================================================
-- 🔔 通知可靠性三道防線（2026-07-28 #015 事故後建置）
--
-- 【事故回顧】#015 訂單成立，但老闆完全沒收到通知。
--   查證結果：line-push 那一刻回 503、log 裡【完全沒有 booted 紀錄】
--   ＝ 通知程式根本沒被叫醒（Serverless 冷啟動失敗）。
--   而門鈴（pg_net）是「射後不理」，失敗不重試 → 通知永久遺失。
--
-- 【這份 SQL 做三件事】
--   ① push_log：把每一次推播的結果記下來（以後有問題查得到，不用拼湊）
--   ② 保底重推：超過 3 分鐘還沒被接單的訂單，自動再通知一次（最多 3 次）
--   ③ 保溫：每 5 分鐘戳一下 line-push，讓它不要睡著
--
-- 【用法】Supabase → SQL Editor → 貼整份 → Run
--   ⚠️ 通行碼【不用】手動填——沿用 setup-secret-vault.sql 建好的保險櫃
-- ============================================================

-- ------------------------------------------------------------
-- ① 需要的擴充套件（pg_cron＝排程、pg_net＝發 HTTP 請求）
--    若這行報錯，改到 Dashboard → Database → Extensions 搜尋 pg_cron 啟用
-- ------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ------------------------------------------------------------
-- ② orders 加「已重推次數」欄位（避免無限重推）
-- ------------------------------------------------------------
alter table public.orders
  add column if not exists push_retry_count int not null default 0;

-- ------------------------------------------------------------
-- ③ 推播紀錄表：每一次通知的結果都留底
--    這是 #015 那天最缺的東西——當時只能靠三個地方交叉比對才查出真相
-- ------------------------------------------------------------
create table if not exists public.push_log (
  id          bigserial primary key,
  order_no    text,                       -- 哪一張單
  kind        text,                       -- new_order / retry / confirmed / ping…
  target      text,                       -- 推給誰（LINE userId，只留前 8 碼保護隱私）
  ok          boolean,                    -- 成功了嗎
  status_code int,                        -- LINE API 回的狀態碼
  error       text,                       -- 失敗原因
  created_at  timestamptz not null default now()
);
create index if not exists push_log_created_idx on public.push_log (created_at desc);

-- 上鎖：前端（anon）完全讀不到；登入的老闆可以看（將來要做查詢頁時才不用改）
alter table public.push_log enable row level security;
drop policy if exists "boss reads push_log" on public.push_log;
create policy "boss reads push_log" on public.push_log
  for select to authenticated using (true);

-- ------------------------------------------------------------
-- ④ 保底重推：把「叫不到人」的通知補回來
--
--    條件（四個都要成立才重推）：
--      status = 'new'          → 還沒被接單（已接單代表老闆看到了）
--      建立超過 3 分鐘          → 給正常流程足夠時間
--      重推次數 < 3            → 最多補 3 次，不無限吵
--      建立在 2 小時內          → 不翻舊帳（打烊後的舊單不要半夜狂推）
-- ------------------------------------------------------------
create or replace function public.retry_unnotified_orders()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
  r record;
begin
  select value into v_secret from public.app_secrets where name = 'webhook_secret';
  if v_secret is null then
    raise notice 'retry_unnotified_orders: 保險櫃沒有 webhook_secret，跳過';
    return;
  end if;

  for r in
    select * from public.orders
    where status = 'new'
      and created_at < now() - interval '3 minutes'
      and created_at > now() - interval '2 hours'
      and push_retry_count < 3
  loop
    perform net.http_post(
      url := 'https://wwirnzsbqrqafyjrvgkn.supabase.co/functions/v1/line-push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', v_secret
      ),
      -- retry := true → line-push 會在卡片標上「補發」，老闆知道這是補的不是新的
      body := jsonb_build_object('kind', 'new_order', 'record', to_jsonb(r), 'retry', true)
    );
    update public.orders
       set push_retry_count = push_retry_count + 1
     where id = r.id;
  end loop;
end;
$$;

-- ------------------------------------------------------------
-- ⑤ 保溫：每 5 分鐘戳一下，讓 line-push 不要進入休眠
--    （#015 的成因就是 29 分鐘沒人叫 → 睡著 → 叫不醒）
--    業界稱為 warmup，是對付 Serverless 冷啟動的標準做法
-- ------------------------------------------------------------
create or replace function public.warm_line_push()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
begin
  select value into v_secret from public.app_secrets where name = 'webhook_secret';
  if v_secret is null then return; end if;
  perform net.http_post(
    url := 'https://wwirnzsbqrqafyjrvgkn.supabase.co/functions/v1/line-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', v_secret
    ),
    body := jsonb_build_object('kind', 'ping')   -- line-push 收到 ping 什麼都不做，只是「醒著」
  );
end;
$$;

-- ------------------------------------------------------------
-- ⑥ 掛上排程（重跑此檔會先移除舊的同名排程，不會重複掛）
-- ------------------------------------------------------------
select cron.unschedule('laolu-retry-push')  where exists (select 1 from cron.job where jobname = 'laolu-retry-push');
select cron.unschedule('laolu-warm-push')   where exists (select 1 from cron.job where jobname = 'laolu-warm-push');

-- 每分鐘檢查一次有沒有漏掉的通知
select cron.schedule('laolu-retry-push', '* * * * *',  $$select public.retry_unnotified_orders();$$);
-- 每 5 分鐘保溫一次
select cron.schedule('laolu-warm-push',  '*/5 * * * *', $$select public.warm_line_push();$$);

-- ------------------------------------------------------------
-- ⑦ 自我體檢
-- ------------------------------------------------------------
-- 應該看到兩個排程
select jobname, schedule, active from cron.job where jobname like 'laolu-%';

-- 應該看到 push_retry_count 欄位
select column_name, data_type
  from information_schema.columns
 where table_name = 'orders' and column_name = 'push_retry_count';

-- push_log 應該存在（剛建好是空的）
select count(*) as push_log筆數 from public.push_log;
