-- ============================================================
-- 🔐 老滷仙資安強化包（2026-07-26）
-- 用法：Supabase → SQL Editor → 貼整份 → Run
-- ⚠️ 這份會動到「下單」的把關邏輯，請「最後批次」跑，且跑完立刻用測試單驗一次
--    （下一張真單能正常成立＝沒擋錯；devtools 改 total=0 送出＝被擋下）
-- 內容三塊：① 暫停接單設定格 ② 價格竄改防護 ③ RLS 複查
-- ============================================================

-- ────────────────────────────────────────────
-- ① 暫停接單：新增 app_config 的 pause_now 格（值＝當天日期才算數，隔天自動失效，跟 closed_now 同機制）
--    並把它加進 RLS 白名單（不然老闆存不進、客人讀不到）
-- ────────────────────────────────────────────
insert into public.app_config (name, value) values ('pause_now', '')
  on conflict (name) do nothing;

-- ⚠️⚠️ 這個白名單【有兩份 SQL 都在定義】（本檔 ＋ setup-emergency.sql）
--    兩邊都是先 drop 再 create → 【後跑的那份會蓋掉前一份】。
--    2026-07-31 審查抓到：本檔原本漏了 emergency_on，
--    只要有人為了別的原因重跑這份，應急模式就會【靜默失效】——
--    資料還在、不報錯、開關就是讀不到（跟 07-30 晚上踩的同一個坑，換個觸發方式）。
--
--    👉 規則：改任何一邊，兩邊都要改。新增設定格時，兩份名單都要加名字。
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

-- ────────────────────────────────────────────
-- ② 價格竄改防護（最重要）＝伺服器完整重算、覆寫前端金額
--    問題：下單是客人瀏覽器「直接寫入」，金額由前端帶——懂技術的人可用 devtools
--          把 total 改成任意值送出（$0、半價都可能）。前端傳來的 price/discount/total 一律不可信。
--    防法：下單前（BEFORE INSERT）伺服器**只用資料庫真實菜單**重算權威金額（含分區湊件優惠，
--          邏輯同前端 cartCalc：每湊滿 N 件用優惠價、餘數單價），直接**覆寫 NEW.total**。
--          並拒絕：未知品項、非正整數數量、空訂單、品項爆量。
--    ＊覆寫式（不是拒絕式）＝正常單不會被誤擋，竄改的金額一律被伺服器的真值取代。
--    ⚠️ 跑完務必用一張真單驗證：金額要跟前端顯示一致（代表 SQL 湊件邏輯與 cartCalc 對得上）。
-- ────────────────────────────────────────────
create or replace function public.guard_order_price()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  authoritative numeric := 0;
  line_cnt int := 0;
  unknown_cnt int := 0;
  badqty_cnt int := 0;
begin
  -- 攤平所有品項（外層多張訂單→內層品項），一律用菜單真實資料對照（left join 對不到＝未知品項）
  with lines as (
    select (line->>'name') as nm,
           nullif(line->>'qty','')::int as qty,
           mi.category_id as cat, mi.price as unit, mi.bundle_qty as bq, mi.bundle_price as bp
    from jsonb_array_elements(NEW.items) pack,
         jsonb_array_elements(pack->'items') line
    left join public.menu_items mi on mi.name = (line->>'name')
  )
  select count(*),
         count(*) filter (where cat is null),
         count(*) filter (where qty is null or qty <= 0)
    into line_cnt, unknown_cnt, badqty_cnt
  from lines;

  if line_cnt = 0 then raise exception '空訂單，拒絕'; end if;
  if line_cnt > 200 then raise exception '訂單品項過多（疑似濫用），拒絕'; end if;
  if unknown_cnt > 0 then raise exception '訂單含未知品項（疑似竄改），拒絕'; end if;
  if badqty_cnt > 0 then raise exception '訂單數量異常（非正整數），拒絕'; end if;

  -- 依分區湊件優惠重算權威金額
  with lines as (
    select (line->>'qty')::int as qty,
           mi.category_id as cat, mi.price as unit, mi.bundle_qty as bq, mi.bundle_price as bp
    from jsonb_array_elements(NEW.items) pack,
         jsonb_array_elements(pack->'items') line
    join public.menu_items mi on mi.name = (line->>'name')
  ), percat as (
    select cat, unit, bq, bp, sum(qty) as q from lines group by cat, unit, bq, bp
  )
  select coalesce(sum(
    case when bq is not null and bq > 0
         then floor(q / bq) * bp + (q % bq) * unit
         else q * unit end), 0)
    into authoritative
  from percat;

  if authoritative <= 0 then raise exception '訂單金額異常，拒絕'; end if;

  -- 以伺服器算出的權威金額為準，覆寫前端送來的 total（前端價格一律不信任）
  NEW.total := authoritative;
  return NEW;
end;
$$;

drop trigger if exists trg_guard_order_price on public.orders;
create trigger trg_guard_order_price
  before insert on public.orders
  for each row execute function public.guard_order_price();

-- ────────────────────────────────────────────
-- ③ RLS 複查（確認現況正確，這段是唯讀檢查，不改東西）
--    orders 應該是：anon 只能 insert、authenticated 才能 select/update、沒有 delete
-- ────────────────────────────────────────────
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename in ('orders','app_config','menu_items','app_secrets')
order by tablename, cmd;

-- 自我體檢：app_secrets（LINE token 保險櫃）務必「anon 讀不到」——
-- 下面這句用 anon 身分應該回 0 列或報權限錯，若查得到內容代表保險櫃沒鎖，要馬上處理
-- （在 SQL Editor 是以管理員跑，看不出 anon 效果；請另到前端用 anon key 試打 app_secrets 確認擋住）
