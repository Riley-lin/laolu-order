-- ============================================================
-- 🔐 老滷仙資安強化包 · 第二批：改單/送單權限收斂（2026-07-26）
-- 用法：Supabase → SQL Editor → 貼整份 → Run（跑完用一張測試單驗證：金額對、狀態=new）
-- ⚠️ 這份會動到「下單」把關，請單獨跑、跑完立刻測一張真單
--
-- 為什麼要做：
--   客人下單是瀏覽器「直接寫入」orders 表（anon 身分）。目前 RLS 的 insert 是
--   with check (true) ＝ 客人可以在送單時「自由帶任何欄位」。懂技術的人能用 devtools：
--     ① 把 status 直接設成 'confirmed' / 'done' ＝ 跳過老闆確認、污染看單台與日報
--     ② 亂設 pickup_at ＝ 假裝已排好取餐時間
--   （total 竄改已被第一批 guard_order_price 擋下並覆寫；這批補的是「狀態欄位」的洞。）
--
-- 怎麼補：
--   在既有的 BEFORE INSERT 把關函式裡，額外「強制」新單的 status='new'、pickup_at=null。
--   ＊這兩個值本來就是正常新單該有的（客人端根本沒帶），所以正常單零影響；
--     只有想動手腳的假單會被「掰正」成乾淨的新單，交回老闆正常流程確認。
--
-- 動線狀態一覽（給對照）：new（新單）→ confirmed（老闆接單）→ done（完成）／cancelled（取消）
--   ——後三種只能由「登入的老闆」用 UPDATE 改，客人 anon 永遠碰不到（RLS: update 限 authenticated）
-- ============================================================

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

  -- 依分區湊件優惠重算權威金額（邏輯同前端 cartCalc：每湊滿 N 件用優惠價、餘數單價）
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

  -- 🆕 權限收斂：新單一律掰正成乾淨狀態，客人送單無法自訂這兩個欄位
  NEW.status := 'new';     -- 客人不能自己送一張「已確認/已完成」的假單
  NEW.pickup_at := null;   -- 取餐時間只能由老闆接單時決定，送單時一律清空

  return NEW;
end;
$$;

-- 觸發器維持不變（重跑安全：先拆再裝，只在 INSERT 時把關）
drop trigger if exists trg_guard_order_price on public.orders;
create trigger trg_guard_order_price
  before insert on public.orders
  for each row execute function public.guard_order_price();

-- ── 複查：orders 應為 anon 只能 insert、authenticated 才能 select/update、無 delete ──
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename = 'orders'
order by cmd;
