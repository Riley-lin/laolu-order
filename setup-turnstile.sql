-- ============================================================
-- 🔐 老滷仙資安 · Turnstile 防洗版（2026-07-26）
-- 這份分兩段，跑的時機不同，請照順序：
--   【第一段】限流表 → 現在就能跑（無害，不影響現有下單）
--   【第二段】關掉「瀏覽器直接寫訂單」的後門 → 等「客人端新版＋place-order 都部署好且測過」才跑！
--     （順序錯會讓客人暫時送不出單——第二段一定放最後）
-- ============================================================


-- ────────────────────────────────────────────
-- 【第一段】IP 限流表：守門員(place-order)每次下單記一筆，用來數「這個 IP 近 N 分鐘幾張」
--   只有 edge function 用 service_role 寫；開 RLS 且不給政策＝anon/登入者都碰不到（純內部）
-- ────────────────────────────────────────────
create table if not exists public.order_throttle (
  ip text not null,
  at timestamptz not null default now()
);
create index if not exists idx_order_throttle_ip_at on public.order_throttle (ip, at);
alter table public.order_throttle enable row level security;
-- 不建任何 policy＝只有 service_role(place-order) 能存取

-- 定期清舊（可選，手動偶爾跑）：限流只看近幾分鐘，舊資料留著只是佔空間
-- delete from public.order_throttle where at < now() - interval '1 day';


-- ────────────────────────────────────────────
-- 【第二段】⚠️ 關後門：移除「anon 直接 insert 訂單」政策
--   ＝之後客人只能透過 place-order 守門員下單（它用 service_role，不受這條影響）。
--   ★ 執行前提：客人端新版（改成呼叫 place-order）＋place-order 函式都已部署且實測能下單成功！
--   ★ 若還沒部署好就跑這段，客人會暫時送不出單。確認 OK 再把下面這行的註解拿掉執行：
-- ────────────────────────────────────────────
-- drop policy if exists "客人可以送出訂單" on public.orders;

-- 複查：跑完第二段後，orders 應該只剩 select(authenticated)＋update(authenticated)，沒有 anon insert
-- select tablename, policyname, cmd, roles from pg_policies
--  where schemaname='public' and tablename='orders' order by cmd;
