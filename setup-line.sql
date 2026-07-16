-- ============================================================
-- 老滷仙 M1：LINE 推播串接（資料庫端）
-- 用法：Supabase 儀表板 → SQL Editor → 貼上整份 → 按 Run
--
-- ⚠️⚠️ 跑之前先把下面兩個【佔位符】換成真的值：
--   【WEBHOOK_SECRET】→ 你自己發明的一串通行碼（跟 Edge Function 的 Secrets 填同一串）
--   佔位符只存在這個檔案裡；換好值之後「不要」把真值 commit 回 GitHub
--   （這個 repo 是公開的，真值上去＝鑰匙掛在門口）
--
-- 它蓋三樣東西：
--   1. orders 表加一個欄位：這張訂單綁了誰的 LINE
--   2. line_admins 表：登記過的管理員（老闆），新訂單會通知他們
--   3. 兩個門鈴（觸發器）：
--      ・新訂單插入 → 按鈴叫推播員通知老闆
--      ・訂單變成 confirmed → 按鈴叫推播員通知客人
-- ============================================================

-- ① 訂單綁定欄位：記住這張單是哪個 LINE 用戶的
alter table public.orders
  add column if not exists line_user_id text;

-- ② 管理員名簿（誰是老闆）。開 RLS 但不給任何政策＝
--    只有雲端函式（最高權限）能讀寫，網頁前端完全碰不到
create table if not exists public.line_admins (
  line_user_id text primary key,
  created_at timestamptz default now()
);
alter table public.line_admins enable row level security;

-- ③ 啟用 pg_net：讓資料庫能對外打電話（呼叫雲端函式）
create extension if not exists pg_net;

-- ④ 門鈴本體：訂單有動靜就呼叫推播員
--    security definer＝以管理員身分執行，一般使用者觸發它也沒有額外權限
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

  -- 老闆確認接單（狀態剛變成 confirmed）→ 通知客人
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

  return new;
end;
$$;

-- ⑤ 把門鈴裝到 orders 表上（重跑安全：先拆再裝）
drop trigger if exists trg_notify_line on public.orders;
create trigger trg_notify_line
  after insert or update on public.orders
  for each row execute function public.notify_line();
