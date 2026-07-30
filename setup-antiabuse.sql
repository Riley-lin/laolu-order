-- ============================================================
-- 🛡️ 防洗版 ＋ 高額警示 ＋ 棄單黑名單（2026-07-30 施工）
--
-- 【這份 SQL 做四件事】
--   ① order_throttle 加欄位：記下「誰下的、多少錢」→ 限流才能認人不只認 IP
--   ② orders 加兩欄：no_show（棄單）、high_value（高額連續下單標記）
--   ③ 新表 blocklist：棄單客人的封鎖名單（30 天自動到期）
--   ④ 日報用的統計函式：把「營業額」和「棄單損失」分開算
--
-- 【為什麼要分開算營業額】Riley 定調：
--   不收訂金，但棄單絕不能算進營業額——那是【成本損失】，要單獨看得見。
--
-- 【用法】Supabase → SQL Editor → 貼整份 → Run（重跑安全，不會重複建）
-- ============================================================


-- ------------------------------------------------------------
-- ① order_throttle：從「只記 IP」升級成「記人＋記金額」
--
--    為什麼要記人：只看 IP 的話，換個網路（4G 切 WiFi）就繞過了；
--    而 LINE 身分不會變，認人才擋得住同一個人。
--    為什麼要記金額：高額連續下單警示要知道「這兩張是不是都超過 500」。
-- ------------------------------------------------------------
alter table public.order_throttle
  add column if not exists line_user_id text,
  add column if not exists total         int;

-- 查詢會用「這個人最近 N 分鐘下了幾張」→ 幫這個組合建索引，資料多了也不會變慢
create index if not exists order_throttle_user_at_idx
  on public.order_throttle (line_user_id, at desc);
create index if not exists order_throttle_ip_at_idx
  on public.order_throttle (ip, at desc);


-- ------------------------------------------------------------
-- ② orders 加兩個標記欄位
--
--    ⚠️ 刻意【不動原本的 status】——status 是訂單的生命週期
--    （new → confirmed → done / cancelled），棄單是「已完成之後才發現沒來領」，
--    它是附加在完成單上的一個註記，不是另一種狀態。
--    混在一起的話，日報要算「做了幾張」就會少算。
-- ------------------------------------------------------------
alter table public.orders
  add column if not exists no_show    boolean not null default false,  -- 棄單：做好了沒來領
  add column if not exists high_value boolean not null default false;  -- 高額連續下單（提醒用，不影響流程）


-- ------------------------------------------------------------
-- ③ 封鎖名單：棄單的客人暫停線上訂餐
--
--    設計成「記到期時間」而不是「記封鎖與否」——
--    這樣 30 天自動解封不需要任何排程，查的時候比一下現在時間就好。
--    （少一個會壞掉的零件，就少一個要維護的東西）
-- ------------------------------------------------------------
create table if not exists public.blocklist (
  line_user_id text primary key,
  until        timestamptz not null,           -- 封鎖到什麼時候
  reason       text,                           -- 為什麼被封（例：棄單 #018）
  order_no     text,                           -- 肇事的那張單
  created_at   timestamptz not null default now()
);

-- 上鎖：前端（anon）完全讀不到，只有伺服器端的 service_role 和登入的老闆看得到
alter table public.blocklist enable row level security;
drop policy if exists "boss reads blocklist" on public.blocklist;
create policy "boss reads blocklist" on public.blocklist
  for select to authenticated using (true);
drop policy if exists "boss writes blocklist" on public.blocklist;
create policy "boss writes blocklist" on public.blocklist
  for all to authenticated using (true) with check (true);


-- ------------------------------------------------------------
-- ④ 日報統計：營業額與棄單損失分開算
--
--    傳入日期（台北時間的那一天），回傳三個數字。
--    看單台的日報直接呼叫它，不用在前端重算一次（同一份邏輯只寫一個地方）。
-- ------------------------------------------------------------
create or replace function public.daily_summary(d date default null)
returns table (
  營業額     int,
  棄單損失   int,
  棄單張數   int,
  完成張數   int
)
language sql
security definer
set search_path = public
as $$
  with day as (
    select coalesce(d, (now() at time zone 'Asia/Taipei')::date) as ymd
  ),
  scope as (
    select o.* from public.orders o, day
    where o.status = 'done'
      and (o.created_at at time zone 'Asia/Taipei')::date = day.ymd
  )
  select
    coalesce(sum(total) filter (where not no_show), 0)::int,
    coalesce(sum(total) filter (where     no_show), 0)::int,
    count(*) filter (where no_show)::int,
    count(*) filter (where not no_show)::int
  from scope;
$$;


-- ------------------------------------------------------------
-- ⑤ 棄單通知客人（老闆在看單台選「自動通知」時才會發）
--
--    做成【獨立的觸發器】，不去動原本的 notify_line——
--    原本那支管的是訂單生命週期（新單／接單／改單），已經穩定在跑，
--    多塞一段進去，改壞了會連正常通知一起賠掉。
--    新功能就用新零件，壞了也只壞它自己。
--
--    老闆的選擇存在 no_show_notify：true＝要自動發、false／null＝不發。
-- ------------------------------------------------------------
alter table public.orders
  add column if not exists no_show_notify boolean not null default false;

create or replace function public.notify_no_show()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
begin
  -- 只在「剛剛被標記成棄單」而且「老闆選了要通知」時才發
  if (new.no_show and not coalesce(old.no_show, false) and new.no_show_notify) then
    select value into v_secret from public.app_secrets where name = 'webhook_secret';
    if v_secret is null then return new; end if;
    perform net.http_post(
      url := 'https://wwirnzsbqrqafyjrvgkn.supabase.co/functions/v1/line-push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', v_secret
      ),
      body := jsonb_build_object('kind', 'no_show', 'record', to_jsonb(new))
    );
  end if;
  return new;
end;
$$;

drop trigger if exists orders_no_show_notify on public.orders;
create trigger orders_no_show_notify
  after update on public.orders
  for each row execute function public.notify_no_show();


-- ------------------------------------------------------------
-- ⑥ 自我體檢
-- ------------------------------------------------------------
select 'order_throttle 欄位' as 項目,
       string_agg(column_name, ', ' order by ordinal_position) as 內容
  from information_schema.columns where table_name = 'order_throttle'
union all
select 'orders 新欄位',
       string_agg(column_name, ', ') from information_schema.columns
 where table_name = 'orders' and column_name in ('no_show', 'high_value')
union all
select 'blocklist 表',
       case when exists (select 1 from information_schema.tables
                          where table_name = 'blocklist') then '已建立' else '❌ 沒建到' end
union all
select '今日統計試算',
       (select 營業額 || ' / 棄單 ' || 棄單損失 from public.daily_summary());
