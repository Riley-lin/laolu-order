-- ============================================================
-- 🍢 通行碼保險櫃（403 治本方案，2026-07-18）
-- 用法：把下面第 ② 段的【WEBHOOK_SECRET】換成真通行碼（只有這一處！）
--       → SQL Editor 貼整份 → Run → 把檔案還原成佔位符再存檔
--
-- 為什麼要這樣改：
--   以前門鈴函式裡通行碼要手貼三處，貼錯一個隱形字元就 403
--   （M1 那晚一次、今晚一次——同一種病犯兩次就該治本）。
--   現在通行碼存進 app_secrets 保險櫃表（RLS 上鎖、不給任何政策＝
--   前端誰都讀不到，只有資料庫裡的管理員函式拿得到），
--   門鈴自己去櫃子拿——以後重蓋門鈴永遠不用再碰通行碼。
--   存入時自動 trim 頭尾空白/換行，隱形字元直接絕種。
-- ============================================================

-- ① 保險櫃：一列＝一把鑰匙
create table if not exists public.app_secrets (
  name  text primary key,
  value text not null
);
-- 上鎖：開 RLS 但不給任何政策＝anon/authenticated 全被擋在外面
alter table public.app_secrets enable row level security;

-- ② 存通行碼（🔑 整份檔案只有這一處要換成真值）
--    trim 會自動削掉頭尾的空白與換行——就算複製時多拖到也沒事
insert into public.app_secrets (name, value)
values ('webhook_secret', trim(both e' \n\r\t' from '【WEBHOOK_SECRET】'))
on conflict (name) do update set value = excluded.value;

-- ③ 門鈴改版：通行碼改從保險櫃拿（三種鈴聲不變）
create or replace function public.notify_line()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
begin
  -- 開櫃拿通行碼（security definer＝管理員身分，RLS 擋不到自己人）
  select value into v_secret from public.app_secrets where name = 'webhook_secret';

  -- 新訂單進來 → 通知老闆
  if (tg_op = 'INSERT') then
    perform net.http_post(
      url := 'https://wwirnzsbqrqafyjrvgkn.supabase.co/functions/v1/line-push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', v_secret
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
        'x-webhook-secret', v_secret
      ),
      body := jsonb_build_object('kind', 'confirmed', 'record', to_jsonb(new))
    );
  end if;

  -- 老闆改了品項或金額（新單/製作中都算）→ 通知客人「訂單內容更新」
  if (tg_op = 'UPDATE'
      and new.status in ('new', 'confirmed')
      and (new.items is distinct from old.items or new.total is distinct from old.total)) then
    perform net.http_post(
      url := 'https://wwirnzsbqrqafyjrvgkn.supabase.co/functions/v1/line-push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', v_secret
      ),
      body := jsonb_build_object('kind', 'edited', 'record', to_jsonb(new), 'old_total', old.total)
    );
  end if;

  return new;
end;
$$;

-- ④ 自我體檢：跑完看結果——應該回一列 webhook_secret ＋它的字元數
--    （只看長度不看內容，安全；跟你記事本裡那串自己數的長度對一下）
select name, length(value) as 字元數 from public.app_secrets;
