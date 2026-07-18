-- ============================================================
-- 🍢 M0.9-C：訂單編輯器（資料庫端）
-- 用法：Supabase 儀表板 → SQL Editor → 貼上整份 → 按 Run
--
-- ⚠️ 跑之前先把三處【WEBHOOK_SECRET】換成真的通行碼
--    （跟 Edge Function Secrets 的 WEBHOOK_SECRET 同一串、不能帶換行）；
--    跑完把真值改回佔位符再存檔——這個 repo 是公開的，真值不進 GitHub。
--
-- 它蓋兩樣東西：
--   1. 門鈴（notify_line）加第三種鈴聲：
--      訂單「品項或金額被改」→ 叫推播員通知綁定 LINE 的客人「訂單內容更新」
--      （整份函式重蓋，原本的新單鈴＋確認鈴原樣保留）
--   2. orders 表開 Realtime 即時廣播：
--      看單台不用再等輪詢，新單／改單瞬間跳出來
-- ============================================================

-- ① 門鈴升級：三種鈴聲（新單／確認／內容更新）
create or replace function public.notify_line()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 新訂單進來 → 通知老闆
  if (tg_op = 'INSERT') then
    perform net.http_post(
      url := 'https://wwirnzsbqrqafyjrvgkn.supabase.co/functions/v1/line-push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', '【WEBHOOK_SECRET】'
      ),
      body := jsonb_build_object('kind', 'new_order', 'record', to_jsonb(new))
    );
  end if;

  -- 老闆確認接單（狀態剛變成 confirmed）→ 通知客人取餐時間
  if (tg_op = 'UPDATE' and new.status = 'confirmed' and old.status is distinct from 'confirmed') then
    perform net.http_post(
      url := 'https://wwirnzsbqrqafyjrvgkn.supabase.co/functions/v1/line-push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', '【WEBHOOK_SECRET】'
      ),
      body := jsonb_build_object('kind', 'confirmed', 'record', to_jsonb(new))
    );
  end if;

  -- 🆕 老闆改了品項或金額（新單/製作中都算）→ 通知客人「訂單內容更新」
  --    附上舊金額（old.total），訊息才能寫「合計 $95（原 $80）」
  --    注意：確認接單那次更新只動狀態/時間、不動品項，所以不會跟上面的鈴聲重複響
  if (tg_op = 'UPDATE'
      and new.status in ('new', 'confirmed')
      and (new.items is distinct from old.items or new.total is distinct from old.total)) then
    perform net.http_post(
      url := 'https://wwirnzsbqrqafyjrvgkn.supabase.co/functions/v1/line-push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', '【WEBHOOK_SECRET】'
      ),
      body := jsonb_build_object('kind', 'edited', 'record', to_jsonb(new), 'old_total', old.total)
    );
  end if;

  return new;
end;
$$;

-- （觸發器本體 trg_notify_line 已在 M1 裝好，函式重蓋即生效，不用重裝）

-- ② orders 表開 Realtime 即時廣播（重跑安全：已開過就跳過）
--    看單台登入後訂閱這個廣播，新單/改單「叮」一聲即時出現；
--    廣播一樣過 RLS 門禁——沒登入的人訂閱了也收不到任何訂單資料
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'orders'
  ) then
    alter publication supabase_realtime add table public.orders;
  end if;
end $$;
