-- ============================================================
-- 🚨 應急模式（LINE 掛掉也能下單）2026-07-30
--
-- 【為什麼要有】現在點餐入口鎖死在 LINE：客人要從官方帳號進來、
--   送出時還要以自己身分傳一則訊息。這在平常是優點（每張單都找得到人），
--   但 LINE 平台一掛（07-28 就發生過），整間店的線上訂餐直接歸零。
--
-- 【設計原則：不複製第二個網站】
--   兩份程式碼遲早會不同步——素肚單位、紙本錯價都是這個坑咬出來的。
--   所以用「同一個網站 ＋ 一個開關」。
--
-- 【三道限制讓它夠安全】
--   ① 平常開關是關的 → 就算網址外流也是死的
--   ② 通行碼可以一鍵換新 → 舊網址立刻失效
--   ③ 只在故障那幾小時開 → 暴露時間極短
--   ⚠️ 誠實說明：帶碼的網址被轉發，對方也能開（網址本身就是鑰匙）。
--      這不是完美的安全，是「故障時還能做生意」與「風險可控」之間的取捨。
--
-- 【用法】Supabase → SQL Editor → 貼整份 → Run（重跑安全）
-- ============================================================


-- ------------------------------------------------------------
-- ① 開關放 app_config（前端讀得到）；通行碼放 app_secrets（前端讀不到）
--
--    為什麼要分兩個地方：客人端必須知道「現在是不是應急模式」才能決定
--    要不要顯示查詢入口、要不要強制走 LINE ——所以開關必須公開。
--    但通行碼一旦公開就等於沒鎖，所以它只能待在前端讀不到的保險櫃裡，
--    由伺服器端（place-order）比對。
-- ------------------------------------------------------------
insert into public.app_config (name, value)
values ('emergency_on', '')          -- ''＝關閉、'1'＝啟用
on conflict (name) do nothing;

-- 第一組通行碼（之後老闆在店務台可以一鍵換）
-- ⚠️ 不用 gen_random_bytes（那是 pgcrypto 擴充，Supabase 裝在 extensions schema，
--    而下面的函式把 search_path 釘死在 public → 執行時會找不到它）。
--    gen_random_uuid() 是 PostgreSQL 內建的，不依賴任何擴充，最保險。
insert into public.app_secrets (name, value)
values ('emergency_code', substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
on conflict (name) do nothing;

-- 🔴 把 emergency_on 加進 RLS 讀取白名單（2026-07-30 補：漏了這段，客人端讀不到開關）
--
--    app_config 的保護是【白名單制】：只有列出來的名字，前端才讀得到。
--    這很好——它讓「不小心把敏感設定放進 app_config」不會直接外洩。
--    但代價是【每加一格新設定，都要記得回來加名字】，忘了就是靜默失效：
--    資料明明寫進去了，前端卻永遠讀到空的，而且不會報任何錯。
--
--    ⚠️ 通行碼 emergency_code 【不在】這裡——它在 app_secrets，前端永遠讀不到。
drop policy if exists "config_public_read" on public.app_config;
create policy "config_public_read" on public.app_config
  for select to anon, authenticated
  using (name in ('notice','closed_dates','closed_now','pause_now',
                  'open_hours','wait_minutes','emergency_on'));

drop policy if exists "config_boss_write" on public.app_config;
create policy "config_boss_write" on public.app_config
  for update to authenticated
  using (name in ('notice','closed_dates','closed_now','pause_now',
                  'open_hours','wait_minutes','emergency_on'))
  with check (name in ('notice','closed_dates','closed_now','pause_now',
                       'open_hours','wait_minutes','emergency_on'));


-- ------------------------------------------------------------
-- ② orders 加「應急單」標記
--    老闆要一眼分得出來：這張單沒有 LINE 身分，出問題只能靠電話找人。
-- ------------------------------------------------------------
alter table public.orders
  add column if not exists emergency boolean not null default false;


-- ------------------------------------------------------------
-- ③ 給店務台用的三支函式
--
--    通行碼在保險櫃裡，前端（連老闆登入的身分也一樣）直接讀不到——
--    所以開一扇「只有登入者能推的門」：security definer 函式。
--    這樣保險櫃本身永遠不對外開放，只有這幾個受控的動作能碰它。
-- ------------------------------------------------------------

-- 讀目前狀態（開關 ＋ 通行碼 ＋ 完整網址，店務台直接顯示）
create or replace function public.emergency_status()
returns table (是否啟用 boolean, 通行碼 text, 網址 text)
language sql
security definer
set search_path = public
as $$
  select
    coalesce((select value from public.app_config  where name = 'emergency_on'), '') = '1',
    coalesce((select value from public.app_secrets where name = 'emergency_code'), ''),
    'https://laolusian.pages.dev/?e='
      || coalesce((select value from public.app_secrets where name = 'emergency_code'), '');
$$;

-- 開／關
create or replace function public.set_emergency(on_off boolean)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.app_config (name, value)
  values ('emergency_on', case when on_off then '1' else '' end)
  on conflict (name) do update set value = excluded.value;
$$;

-- 換新通行碼（舊網址立刻失效）
create or replace function public.rotate_emergency_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new text;
begin
  -- 🐛 2026-07-31 修：原本用 gen_random_bytes()，那是 pgcrypto 擴充的函式，
  --    Supabase 把它裝在 extensions schema——但本函式 set search_path = public，
  --    所以「建立得起來、按下去才爆」（Riley 實測抓到：function does not exist）。
  --    改用內建的 gen_random_uuid()，不依賴任何擴充。
  v_new := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);   -- 12 個十六進位字元
  insert into public.app_secrets (name, value)
  values ('emergency_code', v_new)
  on conflict (name) do update set value = excluded.value;
  return v_new;
end;
$$;

-- 🔒 門禁：這三支只有【登入的老闆】能呼叫，客人端（anon）一律拒絕
revoke execute on function public.emergency_status()        from public, anon;
revoke execute on function public.set_emergency(boolean)    from public, anon;
revoke execute on function public.rotate_emergency_code()   from public, anon;
grant  execute on function public.emergency_status()        to authenticated;
grant  execute on function public.set_emergency(boolean)    to authenticated;
grant  execute on function public.rotate_emergency_code()   to authenticated;


-- ------------------------------------------------------------
-- ④ 自我體檢
-- ------------------------------------------------------------
select 'emergency_on 開關' as 項目,
       coalesce((select value from public.app_config where name = 'emergency_on'), '(沒建到)') as 內容
union all
-- 這一列最容易被忽略：白名單沒加，前端就永遠讀不到開關（靜默失效，不報錯）
select '前端讀得到開關嗎',
       case when exists (
         select 1 from pg_policies
          where tablename = 'app_config' and policyname = 'config_public_read'
            and qual like '%emergency_on%'
       ) then '✅ 白名單已包含' else '❌ 白名單沒加到 → 應急模式不會生效' end
union all
select '通行碼長度',
       coalesce((select length(value)::text from public.app_secrets where name = 'emergency_code'), '(沒建到)')
union all
select 'orders.emergency 欄位',
       case when exists (select 1 from information_schema.columns
                          where table_name = 'orders' and column_name = 'emergency')
            then '已建立' else '❌ 沒建到' end;
