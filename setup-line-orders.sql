-- ============================================================
-- 「我的訂單」自動查詢（2026-07-26）：LINE 客人打開分頁 → 用他的 LINE ID 自動撈當天訂單
--
-- 為什麼：客人從 LINE 開點餐頁時，我們已知道他的 line_user_id（LIFF 認得出）。
--   點「我的訂單」就該自動秀出他今天的單＋進度，不用再打姓名電話。
-- 安全：回傳欄位「不含姓名/電話」＝就算有人亂帶別人的 line_user_id 也只看到訂單內容，
--   不會外洩身分個資；且 line_user_id 是一長串不可猜的字串。
-- 用法：Supabase SQL Editor 貼上執行一次。
-- ============================================================

create or replace function public.get_orders_by_line(p_line_user_id text)
returns table(
  order_no text,
  items jsonb,
  total integer,
  status text,
  wait_minutes integer,
  pickup_at timestamptz,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select o.order_no, o.items, o.total, o.status, o.wait_minutes, o.pickup_at, o.created_at
  from public.orders o
  where o.line_user_id = p_line_user_id
    -- 只查當天（台北時間）：取餐編號每天重排，隔天舊單沒有查詢意義
    and (o.created_at at time zone 'Asia/Taipei')::date = (now() at time zone 'Asia/Taipei')::date
  order by o.created_at desc
  limit 20;
$$;

revoke all on function public.get_orders_by_line(text) from public;
grant execute on function public.get_orders_by_line(text) to anon, authenticated;
