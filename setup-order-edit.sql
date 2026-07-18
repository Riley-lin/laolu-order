-- ============================================================
-- 🍢 M0.9-C：訂單編輯器（資料庫端）
-- 用法：Supabase 儀表板 → SQL Editor → 貼上整份 → 按 Run
--
-- ⚠️ 歷史檔注意（2026-07-18 部署實錄）：
--    本檔的 ① 門鈴函式是「三處手貼通行碼」版，部署當晚因貼碼再度 403，
--    已被 setup-secret-vault.sql 的「保險櫃版」取代（通行碼存 app_secrets 表，
--    門鈴自己開櫃拿，永不再貼碼）。② Realtime 段仍有效。
--    之後重蓋門鈴一律用 setup-secret-vault.sql，不要再跑本檔的 ①。
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
