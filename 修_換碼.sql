-- ============================================================
-- 🐛 修「換新碼失敗：function gen_random_bytes(integer) does not exist」
--
-- 原因：gen_random_bytes 是 pgcrypto 擴充的函式，Supabase 把擴充裝在
--       extensions schema；而這支函式寫了 set search_path = public，
--       只找 public → 執行時找不到。
--       （建立時不會報錯，因為 SQL Editor 的搜尋路徑比較寬——
--         這種「建得起來、按下去才爆」的坑最容易漏測。）
--
-- 修法：改用 PostgreSQL 內建的 gen_random_uuid()，不依賴任何擴充。
--
-- 用法：Supabase → SQL Editor → 貼整份 → Run（10 秒）
-- ============================================================

create or replace function public.rotate_emergency_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new text;
begin
  -- 取 UUID 去掉減號的前 12 碼：夠亂、好唸、也不會太長
  v_new := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  insert into public.app_secrets (name, value)
  values ('emergency_code', v_new)
  on conflict (name) do update set value = excluded.value;
  return v_new;
end;
$$;

revoke execute on function public.rotate_emergency_code() from public, anon;
grant  execute on function public.rotate_emergency_code() to authenticated;

-- ✅ 當場驗一次：能回傳一組 12 碼的新碼就是修好了
select public.rotate_emergency_code() as 新碼;
select * from public.emergency_status();
