// ============================================================
// 老滷仙 下單守門員（place-order）
// 職責：客人送出訂單時，不再讓瀏覽器「直接寫資料庫」，而是先經過這道正門：
//   ① 驗 Cloudflare Turnstile token（擋機器人／洗版）
//   ② 依 IP 限流（同一 IP 10 分鐘最多 10 張，防洪但不誤傷幫朋友訂的客人）
//   ③ 用 service_role 高權限寫入訂單（BEFORE INSERT 的 guard_order_price 仍會重算覆寫金額）
//
// 搭配 RLS：orders 的「anon 直接 insert」政策會被移除 → 客人只能走這道正門，關掉後門。
// 機密：TURNSTILE_SECRET 存 Supabase 保險箱（Secrets），不寫在程式碼裡。
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'

const TURNSTILE_SECRET = Deno.env.get('TURNSTILE_SECRET') ?? ''
const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

// 防洪參數（數字可調）：同一 IP、10 分鐘、最多 10 張
const RATE_MAX = 10
const RATE_WINDOW_MIN = 10

// CORS：允許客人端網頁/LIFF 跨網域呼叫
const cors: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'content-type': 'application/json' } })
}

// 向 Cloudflare 驗證 Turnstile token（回 success=true 才放行）
async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  if (!TURNSTILE_SECRET) { console.error('TURNSTILE_SECRET 未設定'); return false }
  const form = new URLSearchParams()
  form.set('secret', TURNSTILE_SECRET)
  form.set('response', token)
  if (ip && ip !== 'unknown') form.set('remoteip', ip)
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })
    const data = await res.json()
    if (!data.success) console.error('turnstile 未過：', data['error-codes'])
    return !!data.success
  } catch (e) {
    console.error('turnstile 驗證連線失敗：', e)
    return false
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  // 取客人 IP（Supabase Edge 在最前面代理，真實 IP 在 x-forwarded-for 第一個）
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'

  let payload: any
  try { payload = await req.json() } catch { return json({ error: 'bad_json' }, 400) }
  const token: string = payload?.token ?? ''
  const records = payload?.records

  // ① Turnstile 驗證
  if (!token || !(await verifyTurnstile(token, ip))) {
    return json({ error: 'turnstile_failed', message: '安全驗證未通過，請重新整理頁面再送一次 🙏' }, 403)
  }

  // ② IP 限流（先數這個 IP 近 10 分鐘幾張，超過就擋）
  const since = new Date(Date.now() - RATE_WINDOW_MIN * 60000).toISOString()
  const { count } = await db.from('order_throttle')
    .select('*', { count: 'exact', head: true })
    .eq('ip', ip).gte('at', since)
  if ((count ?? 0) >= RATE_MAX) {
    return json({ error: 'rate_limited', message: '下單太頻繁囉，請稍等幾分鐘再試 🍢（幫多位朋友訂請分批稍候）' }, 429)
  }
  await db.from('order_throttle').insert({ ip })   // 記一筆這次下單，供限流計數

  // ③ 基本形狀檢查（其餘由 DB 的 guard_order_price 觸發器把關：金額重算、未知品項、數量）
  if (!Array.isArray(records) || records.length === 0 || records.length > 10) {
    return json({ error: 'bad_records', message: '訂單格式異常，請重新整理再試' }, 400)
  }

  // ④ 用 service_role 寫入（繞過 RLS；價格防護觸發器仍在 INSERT 前重算覆寫金額）
  const { data, error } = await db.from('orders').insert(records).select('order_no')
  if (error) {
    console.error('orders insert error：', error)
    return json({ error: 'insert_failed', message: '訂單寫入失敗（可能網路不穩），請再送一次 🙏' }, 500)
  }

  return json({ ok: true, order_nos: (data ?? []).map((r: any) => r.order_no) }, 200)
})
