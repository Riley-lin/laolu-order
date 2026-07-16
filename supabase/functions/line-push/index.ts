// ============================================================
// 老滷仙 LINE 推播員
// 職責：資料庫一有動靜（新訂單／老闆確認接單），觸發器會叫醒它，
//       它負責把訊息真正發進 LINE。
//
//   kind = 'new_order'  → 通知所有管理員（老闆）：有新單！
//   kind = 'confirmed'  → 通知該訂單綁定的客人：取餐時間出爐
//
// 訊息格式完全沿用 boss.html 的 buildCustomerMessage——
// 也就是老闆在預覽視窗看到的那份，一字不差。
//
// 安全機制：只認得帶正確通行碼（x-webhook-secret）的呼叫，
// 路人拿到網址也叫不動它。
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'

const ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN')!
const WEBHOOK_SECRET = Deno.env.get('WEBHOOK_SECRET')!

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

// ---------- 發 LINE 推播 ----------
async function push(to: string, text: string) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  })
  if (!res.ok) console.error('LINE push 失敗：', res.status, await res.text())
}

// ---------- 台北時間 HH:MM ----------
function fmtHM(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-TW',
    { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false })
}

// ---------- 客人訊息：跟 boss.html 預覽視窗同一份格式 ----------
function buildCustomerMessage(r: any): string {
  const items = (r.items ?? [])
    .flatMap((o: any) => (o.items ?? []).map((v: any) => `${v.name} ×${v.qty}`))
    .join('、')
  return '🍢 老滷仙\n'
    + '✅ 訂單確認！（取餐編號 #' + r.order_no + '）\n\n'
    + '食材新鮮現滷，等候時間約 ' + r.wait_minutes + ' 分鐘，\n'
    + '請於 ' + fmtHM(r.pickup_at) + ' 前往現場取餐。\n\n'
    + '📋 ' + items + '\n'
    + '💰 合計 $' + r.total
}

// ---------- 老闆訊息：新訂單快報 ----------
function buildBossMessage(r: any): string {
  const items = (r.items ?? [])
    .flatMap((o: any) => (o.items ?? []).map((v: any) => `${v.name} ×${v.qty}`))
    .join('、')
  return '🔔 新訂單 #' + r.order_no + '\n\n'
    + '📋 ' + items + '\n'
    + '💰 合計 $' + r.total + '\n\n'
    + '到看單台按「確認接單」就會通知客人取餐時間'
}

Deno.serve(async (req) => {
  // 驗通行碼：不是自己人叫的，一律拒絕
  if (req.headers.get('x-webhook-secret') !== WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 })
  }

  const { kind, record } = await req.json()

  if (kind === 'new_order') {
    // 撈出所有登記過的管理員，逐一通知
    const { data: admins } = await db.from('line_admins').select('line_user_id')
    for (const a of admins ?? []) {
      await push(a.line_user_id, buildBossMessage(record))
    }
  }

  if (kind === 'confirmed' && record?.line_user_id) {
    // 只通知有綁定 LINE 的客人（沒綁的照舊用查詢頁，不影響）
    await push(record.line_user_id, buildCustomerMessage(record))
  }

  return new Response('ok')
})
