-- ============================================================
-- 客人查詢窗口 v2（2026-07-19）：姓名＋電話 → 撈「當天」自己的訂單
--
-- 為什麼要這個：
-- 舊版查詢只翻「這支手機存過的紀錄」，換瀏覽器或 LINE 內開網頁
-- 就查無訂單（Riley UAT 抓到 #006/#007 查不到）。
-- 訂單表有 RLS 保護、匿名訪客不能直接翻（保護所有客人的個資），
-- 所以開一個「窄窗口」：要同時講對姓名＋電話，才回你自己當天的單。
--
-- 用法：Supabase SQL Editor 貼上執行一次即可。
-- ============================================================

create or replace function public.get_customer_orders(p_name text, p_phone text)
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
  where o.customer_name = p_name
    and o.customer_phone = p_phone
    -- 只查當天（台北時間）：取餐編號每天重排，隔天的舊單沒有查詢意義
    and (o.created_at at time zone 'Asia/Taipei')::date = (now() at time zone 'Asia/Taipei')::date
  order by o.created_at desc
  limit 20;
$$;

revoke all on function public.get_customer_orders(text, text) from public;
grant execute on function public.get_customer_orders(text, text) to anon, authenticated;

-- 自我體檢：拿今天任一張單的姓名電話帶入試查，應回該客人今天的單
-- select * from public.get_customer_orders('阿呆不付錢', '0912123123');
