-- ============================================================
-- 老滷仙 M0：訂單資料表（orders）
-- 用法：Supabase 儀表板 → SQL Editor → 貼上整份 → 按 Run
-- ============================================================

-- 建立訂單表：每一筆 = 客人送出的一張訂單
create table public.orders (
  -- 系統自動產生的唯一編號（像身分證字號，絕不重複）
  id uuid primary key default gen_random_uuid(),

  -- 取餐編號（沿用網頁產生的格式，例如 0705-012）
  order_no text not null,

  -- 客人資料
  customer_name  text not null,
  customer_phone text not null,

  -- 訂購模式（single＝個人單 / group＝團體單，沿用網頁的分法）
  mode text,

  -- 訂單明細：整包購物車內容存成 JSON（品項、數量、單價、辣度湯量備註都在裡面）
  items jsonb not null,

  -- 合計金額（存整數，台幣沒有小數）
  total integer not null,

  -- 整單備註
  note text,

  -- 訂單狀態：new＝新單 → done＝完成 → cancelled＝取消（老闆在 boss.html 改）
  status text not null default 'new',

  -- 下單時間（資料庫自動蓋章，存 UTC，顯示時再轉台北時間）
  created_at timestamptz not null default now()
);

-- ============================================================
-- 資安設定（RLS：Row Level Security，一定要開！）
-- 白話：資料表預設是「誰都不准碰」，下面再一條一條開門。
-- ============================================================

alter table public.orders enable row level security;

-- 門 1：任何人（客人的瀏覽器，用 anon 鑰匙）可以「投單」——只能寫入，不能偷看
create policy "客人可以送出訂單"
  on public.orders
  for insert
  to anon
  with check (true);

-- 門 2：只有「登入過的人」（老闆）可以看訂單——保護客人的姓名電話
create policy "老闆登入後可以看訂單"
  on public.orders
  for select
  to authenticated
  using (true);

-- 門 3：只有登入的老闆可以改訂單狀態（標記完成／取消）
create policy "老闆登入後可以更新訂單"
  on public.orders
  for update
  to authenticated
  using (true);

-- 注意：沒有開 delete 的門 = 誰都不能刪訂單（帳本不可竄改，要作廢就標 cancelled）
