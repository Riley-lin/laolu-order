-- ============================================================
-- 🍢 店務設定檔 v2＝打烊系統（2026-07-19，取代同檔早前版本）
-- 用法：SQL Editor 貼整份 → Run（免通行碼；重跑安全）
--
-- 三格設定＝整個打烊系統的真相來源：
--   notice        公告文字（點餐頁公告條＋「休假日」關鍵字回覆）
--   closed_dates  未來公休日（逗號分隔，例：2026-07-21,2026-07-28）
--   closed_now    臨時打烊（值＝今天日期才生效，隔天自動失效，不怕忘記關）
--
-- 誰能動：客人（匿名）只能「讀」這三格；登入的老闆能「改」這三格；
-- 其他格（如 webhook_secret 保險櫃）維持全鎖，前端碰不到。
-- ============================================================

create table if not exists public.app_config (
  name  text primary key,
  value text not null
);
alter table public.app_config enable row level security;

-- 客人可讀的三格（公告/公休日/臨時打烊——點餐頁要即時反應）
drop policy if exists "config_public_read" on public.app_config;
create policy "config_public_read" on public.app_config
  for select to anon, authenticated
  using (name in ('notice', 'closed_dates', 'closed_now'));

-- 登入的老闆可改同三格（店務頁的營業設定區）；沒開 insert/delete＝改不了別格、加不了新格
drop policy if exists "config_boss_write" on public.app_config;
create policy "config_boss_write" on public.app_config
  for update to authenticated
  using (name in ('notice', 'closed_dates', 'closed_now'))
  with check (name in ('notice', 'closed_dates', 'closed_now'));

-- 三格開戶（已存在就不動它）
insert into public.app_config (name, value) values
  ('notice', ''), ('closed_dates', ''), ('closed_now', '')
on conflict (name) do nothing;

-- 自我體檢：應看到三格（value 都空白＝正常，內容之後在店務頁填）
select name, value from public.app_config
where name in ('notice','closed_dates','closed_now') order by name;
