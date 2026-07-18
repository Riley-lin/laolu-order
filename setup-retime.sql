-- ============================================================
-- 🍢 M3 配套：改時間通知（門鈴第四鈴聲）
-- 用法：Supabase → SQL Editor → 貼整份 → Run（保險櫃版，不用貼任何通行碼 🎉）
--
-- 治的缺口：老闆改了取餐時間，客人卻不知道（後台改時間一直沒通知）。
-- 蓋的東西：門鈴函式整份重蓋＝原三鈴聲（新單/確認/內容更新）＋
--          第四鈴聲「取餐時間變了 → 通知綁定的客人新時間（附原時間）」。
-- 通行碼一律從 app_secrets 保險櫃拿——這就是治本的紅利，永遠不用再貼碼。
-- ============================================================

create or replace function public.notify_line()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
begin
  select value into v_secret from public.app_secrets where name = 'webhook_secret';

  -- ① 新訂單進來 → 通知老闆（按鈕卡片）
  if (tg_op = 'INSERT') then
    perform net.http_post(
      url := 'https://wwirnzsbqrqafyjrvgkn.supabase.co/functions/v1/line-push',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
      body := jsonb_build_object('kind', 'new_order', 'record', to_jsonb(new))
    );
  end if;

  -- ② 確認接單（狀態剛變 confirmed）→ 通知客人取餐時間
  if (tg_op = 'UPDATE' and new.status = 'confirmed' and old.status is distinct from 'confirmed') then
    perform net.http_post(
      url := 'https://wwirnzsbqrqafyjrvgkn.supabase.co/functions/v1/line-push',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
      body := jsonb_build_object('kind', 'confirmed', 'record', to_jsonb(new))
    );
  end if;

  -- ③ 品項或金額被改 → 通知客人「訂單內容更新」
  if (tg_op = 'UPDATE'
      and new.status in ('new', 'confirmed')
      and (new.items is distinct from old.items or new.total is distinct from old.total)) then
    perform net.http_post(
      url := 'https://wwirnzsbqrqafyjrvgkn.supabase.co/functions/v1/line-push',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
      body := jsonb_build_object('kind', 'edited', 'record', to_jsonb(new), 'old_total', old.total)
    );
  end if;

  -- ④ 🆕 取餐時間被改（單子維持製作中、時間不同了）→ 通知客人新時間
  --    注意條件寫「old 也是 confirmed」——首次接單那次由第②鈴負責，不會連響兩聲
  if (tg_op = 'UPDATE'
      and new.status = 'confirmed' and old.status = 'confirmed'
      and new.pickup_at is distinct from old.pickup_at) then
    perform net.http_post(
      url := 'https://wwirnzsbqrqafyjrvgkn.supabase.co/functions/v1/line-push',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
      body := jsonb_build_object('kind', 'retimed', 'record', to_jsonb(new), 'old_pickup_at', old.pickup_at)
    );
  end if;

  return new;
end;
$$;
