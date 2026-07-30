-- 🔍 診斷「換新碼失敗」（2026-07-31）
-- Supabase → SQL Editor → 貼整份 → Run

-- ① 三支函式在不在、權限對不對
select p.proname as 函式,
       pg_get_userbyid(p.proowner) as 擁有者,
       p.prosecdef as 是否_security_definer,
       has_function_privilege('authenticated', p.oid, 'execute') as 老闆叫得動,
       has_function_privilege('anon', p.oid, 'execute') as 匿名叫得動
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('emergency_status','set_emergency','rotate_emergency_code');
-- 👉 三列都要有；老闆叫得動＝true、匿名叫得動＝false

-- ② 保險櫃表的擁有者與 RLS 狀態（security definer 能不能寫，取決於這個）
select c.relname as 資料表,
       pg_get_userbyid(c.relowner) as 擁有者,
       c.relrowsecurity as 有開RLS,
       c.relforcerowsecurity as 連擁有者也擋
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('app_secrets','app_config');
-- 👉「連擁有者也擋」若是 true，security definer 函式就寫不進去 → 那就是失敗原因

-- ③ 直接在這裡試跑一次換碼（SQL Editor 是高權限，能跑＝函式本身沒問題）
select public.rotate_emergency_code() as 新碼;

-- ④ 換完看一下狀態
select * from public.emergency_status();
