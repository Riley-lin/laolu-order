-- ============================================================
-- 老滷仙 M0.5：取餐編號改由資料庫統一發號（修撞號 bug）
-- 用法：Supabase 儀表板 → SQL Editor → 貼上整份 → 按 Run
--
-- 為什麼要這個：原本號碼是「每支手機自己數」（存在客人瀏覽器），
-- 兩支手機互相不知道，實測撞出兩張 #001。
-- 修法＝店裡只設一個「發號櫃檯」（這張表＋這個函式），
-- 不管幾支手機同時按，資料庫一次只發一號，保證不重複。
-- ============================================================

-- 發號櫃檯的帳本：每天一列，記「今天發到幾號」
create table if not exists public.order_counters (
  date_key date primary key,  -- 哪一天（台北時間）
  seq integer not null default 0  -- 當天已發到幾號
);

-- 帳本也上鎖（RLS），而且「不開任何門」——
-- 誰都不能直接讀寫，只能透過下面的發號函式服務
alter table public.order_counters enable row level security;

-- 發號函式：叫一次發一號（今天第一號從 001 開始，每天歸零重數）
-- security definer＝函式用「管理員身分」執行，所以能動被鎖住的帳本，
-- 但客人只能拿到號碼，碰不到帳本本體
create or replace function public.next_order_no()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Asia/Taipei')::date;  -- 用台北時間換日
  new_seq integer;
begin
  -- 原子操作：今天沒帳就開帳發 1 號，有帳就 +1——
  -- 兩支手機同時按，資料庫會排隊處理，絕不發出同一號
  insert into public.order_counters as c (date_key, seq)
  values (today, 1)
  on conflict (date_key)
  do update set seq = c.seq + 1
  returning seq into new_seq;

  -- 超過 999 從 1 重數（跟舊版行為一致；滷味攤一天 999 單就發財了）
  if new_seq > 999 then
    update public.order_counters set seq = 1 where date_key = today;
    new_seq := 1;
  end if;

  return lpad(new_seq::text, 3, '0');  -- 回傳三位數字串，如 '001'
end;
$$;

-- 權限：只准「執行發號函式」，不給其他任何權限
revoke all on function public.next_order_no() from public;
grant execute on function public.next_order_no() to anon, authenticated;
