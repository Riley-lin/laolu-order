-- ============================================================
-- 🍢 店務設定檔（M1.5 配套）：休假日等「會變動的店務資訊」的家
-- 用法：SQL Editor 貼整份 → Run（免通行碼）
--
-- 為什麼開這張表：休假日、公告這類資訊常變動，寫死在程式裡每改一次
-- 就要重部署——放進設定表，之後 Table Editor 改一格字就生效。
-- 圖文選單「休假日」按鈕 → 客人送出「休假日」→ 接待員來這裡拿答案回覆。
-- ============================================================

create table if not exists public.app_config (
  name  text primary key,
  value text not null
);
-- 上鎖：跟保險櫃同款——開 RLS 不給政策，只有雲端函式（管理員身分）讀得到
alter table public.app_config enable row level security;

-- 休假日公告（先放預設文，老闆確定後來 Table Editor 改這格就好）
insert into public.app_config (name, value)
values ('holiday_notice', '🍢 老滷仙營業資訊\n\n本店休假日以現場公告為準，\n或來電洽詢 0939-955-888 😊')
on conflict (name) do update set value = excluded.value;

-- 自我體檢
select name, left(value, 20) as 內容開頭 from public.app_config;
