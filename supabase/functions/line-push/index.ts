// ============================================================
// 老滷仙 LINE 推播員
// 職責：資料庫一有動靜（新訂單／老闆確認接單），觸發器會叫醒它，
//       它負責把訊息真正發進 LINE。
//
//   kind = 'new_order'  → 通知所有管理員（老闆）：有新單！
//   kind = 'confirmed'  → 通知該訂單綁定的客人：取餐時間出爐
//   kind = 'edited'     → 通知該訂單綁定的客人：訂單內容被老闆修改
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
  await pushMessages(to, [{ type: 'text', text }])
}

// 進階版：可以發任何形式的訊息（文字、按鈕卡片…）
async function pushMessages(to: string, messages: unknown[]) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages }),
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

// ---------- 客人訊息：訂單內容更新（跟 boss.html 編輯預覽同一份格式）----------
function buildEditedMessage(r: any, oldTotal?: number): string {
  const items = (r.items ?? [])
    .flatMap((o: any) => (o.items ?? []).map((v: any) => `${v.name} ×${v.qty}`))
    .join('、')
  const totalLine = (typeof oldTotal === 'number' && oldTotal !== r.total)
    ? '💰 合計 $' + r.total + '（原 $' + oldTotal + '）'
    : '💰 合計 $' + r.total
  return '🍢 老滷仙\n'
    + '✏️ 訂單內容更新（取餐編號 #' + r.order_no + '）\n\n'
    + '📋 新內容：' + items + '\n'
    + totalLine + '\n'
    + (r.pickup_at ? '⏰ 取餐時間不變：' + fmtHM(r.pickup_at) + '\n' : '')
    + '\n如有疑問請致電 0939-955-888'
}

// ---------- 老闆訊息：新訂單「按鈕卡片」（M2）----------
// 老闆的裁示：「完成鍵要在 LINE 按，要去後台就不行」——
// 所以新單直接給按鈕：✅25/30/35分＝一鍵接單（客人自動收到取餐時間）；❌＝取消（會再問一次防手滑）。
// 按鈕按下去由接待員（line-webhook）處理，只有名簿裡的老闆按了有效。
function buildNewOrderCard(r: any) {
  const items = (r.items ?? [])
    .flatMap((o: any) => (o.items ?? []).map((v: any) => `${v.name} ×${v.qty}`))
    .join('、')
  const acceptBtn = (m: number) => ({
    type: 'button', style: 'primary', height: 'sm', color: '#B8860B',
    action: {
      type: 'postback',
      label: '✅ ' + m + '分',
      data: JSON.stringify({ a: 'ok', id: r.id, m }),
      displayText: '接單 #' + r.order_no + '（等候 ' + m + ' 分鐘）',
    },
  })
  return {
    type: 'flex',
    altText: '🔔 新訂單 #' + r.order_no + '（$' + r.total + '）',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'text', text: '🔔 新訂單 #' + r.order_no, weight: 'bold', size: 'lg', color: '#B8860B' },
          { type: 'text', text: '👤 ' + (r.customer_name ?? '') + '　📞 ' + (r.customer_phone ?? ''), size: 'sm', wrap: true },
          { type: 'text', text: '📋 ' + items, size: 'sm', wrap: true },
          { type: 'text', text: '💰 合計 $' + r.total, weight: 'bold', margin: 'md' },
          { type: 'text', text: '按下方按鈕接單，客人會自動收到取餐時間', size: 'xs', color: '#999999', wrap: true, margin: 'md' },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [25, 30, 35].map(acceptBtn) },
          {
            type: 'button', style: 'secondary', height: 'sm',
            action: {
              type: 'postback',
              label: '❌ 取消這張單',
              data: JSON.stringify({ a: 'no1', id: r.id }),
              displayText: '取消 #' + r.order_no + '？',
            },
          },
        ],
      },
    },
  }
}

Deno.serve(async (req) => {
  // 驗通行碼：不是自己人叫的，一律拒絕
  if (req.headers.get('x-webhook-secret') !== WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 })
  }

  const { kind, record, old_total } = await req.json()

  if (kind === 'new_order') {
    // 撈出所有登記過的管理員，逐一發「按鈕卡片」（M2：接單直接在 LINE 按）
    const { data: admins } = await db.from('line_admins').select('line_user_id')
    const card = buildNewOrderCard(record)
    for (const a of admins ?? []) {
      await pushMessages(a.line_user_id, [card])
    }
  }

  if (kind === 'confirmed' && record?.line_user_id) {
    // 只通知有綁定 LINE 的客人（沒綁的照舊用查詢頁，不影響）
    await push(record.line_user_id, buildCustomerMessage(record))
  }

  if (kind === 'edited' && record?.line_user_id) {
    // 訂單被老闆修改 → 通知綁定的客人新內容（沒綁的不發，優雅降級）
    await push(record.line_user_id, buildEditedMessage(record, old_total))
  }

  return new Response('ok')
})
