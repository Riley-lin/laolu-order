-- ============================================================
-- 老滷仙 M0.75：訂單確認流程（狀態機升級）
-- 用法：Supabase 儀表板 → SQL Editor → 貼上整份 → 按 Run
--
-- 新的訂單生命週期：
--   new（新單）→ confirmed（已確認，開滷）→ done（完成）
--   任何階段都可 cancelled（取消）
-- 老闆按「確認接單」時：記下確認時間＋等候分鐘 → 算出取餐時間
-- ============================================================

-- 訂單表加三個欄位（already exists 的話不會重複加）
alter table public.orders
  add column if not exists confirmed_at timestamptz,  -- 老闆按確認的時刻
  add column if not exists wait_minutes integer,      -- 等候分鐘（30/45/60）
  add column if not exists pickup_at timestamptz;     -- 取餐時間＝確認時刻＋等候分鐘

-- 客人查單函式：只用「訂單編號」查，只回「狀態＋取餐時間」
-- 刻意不回姓名電話金額——就算別人亂猜編號，也只看得到不敏感的狀態
create or replace function public.get_order_status(p_order_no text)
returns table(status text, pickup_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select o.status, o.pickup_at
  from public.orders o
  where o.order_no = p_order_no
    and (o.created_at at time zone 'Asia/Taipei')::date = (now() at time zone 'Asia/Taipei')::date
  order by o.created_at desc
  limit 1;
$$;

revoke all on function public.get_order_status(text) from public;
grant execute on function public.get_order_status(text) to anon, authenticated;
