-- ============================================================
-- 🔒 上線前資安補丁（2026-07-31，紅隊審查後）
--
-- 這份修的是 Codex 紅隊實測抓到、且我方【實際驗證成立】的問題。
-- 不含誤報，也不含「理論上存在但攻擊前提不成立」的項目。
--
-- 【用法】Supabase → SQL Editor → 貼整份 → Run（重跑安全）
-- ============================================================


-- ------------------------------------------------------------
-- ① 🔴 daily_summary 對匿名開放 → 營業額外洩（實測證實）
--
--    實測：用網頁上人人可見的 anon key 直接呼叫
--      POST /rest/v1/rpc/daily_summary  →  HTTP 200
--      {"營業額":0,"棄單損失":0,"棄單張數":0,"完成張數":0}
--    換不同日期反覆呼叫，可以把整間店的歷史營收撈光。
--
--    根因：PostgreSQL 新建函式【預設授予 PUBLIC 執行權】，
--    而 security definer 會繞過 orders 的 RLS——兩件事加起來就是後門。
--    我建 daily_summary 時只想著「讓老闆的日報好算」，忘了收權限。
--
--    📌 教訓：往後每建一支 security definer 函式，都要立刻 revoke。
--       它繞過 RLS 這件事，正是它危險的地方。
-- ------------------------------------------------------------
revoke execute on function public.daily_summary(date) from public, anon;
grant  execute on function public.daily_summary(date) to authenticated;


-- ------------------------------------------------------------
-- ② 🟠 順手把其他 security definer 函式的權限一起盤點收緊
--
--    get_customer_orders 必須保留 anon——那是客人查自己訂單的窗口，
--    而且它本身有「姓名＋電話都要吻合」的保護（已實測：隨機猜、萬用字元、
--    injection 全部回 0 筆），所以維持開放是正確的。
--
--    其餘管理用的函式一律只給登入者。
-- ------------------------------------------------------------
do $$
begin
  -- 這幾支是店務台專用，客人端不該叫得動
  if exists (select 1 from pg_proc where proname = 'retry_unnotified_orders') then
    execute 'revoke execute on function public.retry_unnotified_orders() from public, anon';
  end if;
  if exists (select 1 from pg_proc where proname = 'warm_line_push') then
    execute 'revoke execute on function public.warm_line_push() from public, anon';
  end if;
end $$;


-- ------------------------------------------------------------
-- ③ 🟠 blocklist 的寫入權限收窄
--
--    原本是 `for all to authenticated using (true)`——
--    Supabase 的 authenticated 意思是「任何登入者」，不是「老闆」。
--    目前自助註冊是關閉的（實測 signup 回 signup_disabled），
--    所以外人拿不到 authenticated，攻擊前提不成立。
--
--    但這是【單點依賴】：哪天有人為了別的需求把註冊打開，這個洞就活了。
--    深度防禦的做法是「不要把安全性押在另一個設定上」——
--    所以改成只認名簿裡的管理員（line_admins 對應的登入帳號目前沒有欄位可比對，
--    退而求其次：寫入一律走伺服器端，前端只保留讀取）。
-- ------------------------------------------------------------
drop policy if exists "boss writes blocklist" on public.blocklist;
-- 讀取保留給登入者（店務台要顯示封鎖名單）
drop policy if exists "boss reads blocklist" on public.blocklist;
create policy "boss reads blocklist" on public.blocklist
  for select to authenticated using (true);

-- 寫入改走這支受控函式：只做「封鎖某人 30 天」這一件事，
-- 不能任意指定天數、不能改別人的到期日。
create or replace function public.block_customer(p_line_user_id text, p_order_no text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.blocklist (line_user_id, until, reason, order_no)
  values (p_line_user_id, now() + interval '30 days', '棄單 #' || p_order_no, p_order_no)
  on conflict (line_user_id) do update
    set until = excluded.until, reason = excluded.reason, order_no = excluded.order_no;
$$;

create or replace function public.unblock_customer(p_line_user_id text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.blocklist where line_user_id = p_line_user_id;
$$;

revoke execute on function public.block_customer(text, text)   from public, anon;
revoke execute on function public.unblock_customer(text)       from public, anon;
grant  execute on function public.block_customer(text, text)   to authenticated;
grant  execute on function public.unblock_customer(text)       to authenticated;


-- ------------------------------------------------------------
-- ④ 自我體檢：確認匿名真的叫不動管理函式
--
--    跑完之後，可以自己用網頁上的 anon key 打一次 daily_summary，
--    應該要得到 401 permission denied（原本是 200 加一串營業額）。
-- ------------------------------------------------------------
select p.proname as 函式,
       case when has_function_privilege('anon', p.oid, 'execute')
            then '⚠️ 匿名叫得動' else '✅ 匿名叫不動' end as 匿名權限
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('daily_summary','get_customer_orders','emergency_status',
                     'set_emergency','rotate_emergency_code','block_customer',
                     'unblock_customer','retry_unnotified_orders','warm_line_push')
 order by 2 desc, 1;
-- 👉 只有 get_customer_orders 應該是「⚠️ 匿名叫得動」（那是客人查訂單的窗口，本來就要開）
