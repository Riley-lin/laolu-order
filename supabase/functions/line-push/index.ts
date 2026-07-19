// ============================================================
// 老滷仙 LINE 推播員
// 職責：資料庫一有動靜（新訂單／老闆確認接單），觸發器會叫醒它，
//       它負責把訊息真正發進 LINE。
//
//   kind = 'new_order'  → 通知所有管理員（老闆）：有新單！
//   kind = 'confirmed'  → 通知該訂單綁定的客人：取餐時間出爐
//   kind = 'edited'     → 通知該訂單綁定的客人：訂單內容被老闆修改
//
// 客人通知已升級成 Flex 卡片（金額靠右對帳版），跟老闆卡片同一套排版元件。
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

// ---------- 品項條列（對帳版）：一行一項＋每行金額（2026-07-19 Riley 拍板）----------
function flatItems(r: any): any[] {
  return (r.items ?? []).flatMap((o: any) => (o.items ?? []))
}
// 折扣總額＋分區明細（下單當下由點餐頁算好存進訂單＝單一真相來源；舊單沒有就略過）
function discountInfo(r: any): { saved: number; lines: string[] } {
  const packs = r.items ?? []
  const saved = packs.reduce((s: number, o: any) => s + (o.discount || 0), 0)
  const lines = packs.flatMap((o: any) => o.discount_lines ?? [])
  return { saved, lines }
}

// ---------- 對帳版 Flex 列（品名靠左、金額靠右＋折扣明細＋合計）----------
// 老闆卡片與客人卡片共用同一套——兩邊看到的帳永遠同款
// （純文字在 LINE 沒辦法真靠右——字寬不固定；要對齊只能用卡片，2026-07-19 Riley 拍板升級）
function flexItemRows(r: any): any[] {
  const d = discountInfo(r)
  const rows: any[] = flatItems(r).map((v: any) => ({
    type: 'box', layout: 'horizontal', contents: [
      { type: 'text', text: '・' + v.name + ' ×' + v.qty, size: 'sm', weight: 'bold', wrap: true, flex: 5 },
      { type: 'text', text: '$' + (v.price * v.qty), size: 'sm', align: 'end', flex: 2, color: '#B8860B' },
    ],
  }))
  if (d.saved > 0) {
    rows.push({
      type: 'box', layout: 'horizontal', margin: 'sm', contents: [
        { type: 'text', text: '🎁 優惠折抵', size: 'sm', weight: 'bold', color: '#C0392B', flex: 5 },
        { type: 'text', text: '−$' + d.saved, size: 'sm', align: 'end', flex: 2, color: '#C0392B' },
      ],
    })
    d.lines.forEach((l: string) => rows.push({ type: 'text', text: '　' + l, size: 'xs', color: '#999999', wrap: true }))
  }
  rows.push({ type: 'separator', margin: 'sm' })
  rows.push({
    type: 'box', layout: 'horizontal', margin: 'sm', contents: [
      { type: 'text', text: '💰 合計', weight: 'bold', flex: 5 },
      { type: 'text', text: '$' + r.total, weight: 'bold', align: 'end', flex: 2, color: '#B8860B' },
    ],
  })
  return rows
}

// ---------- 客人卡片：訂單確認（跟老闆卡片同款對帳排版）----------
function buildCustomerCard(r: any) {
  return {
    type: 'flex',
    altText: '✅ 訂單確認！#' + r.order_no + '　' + fmtHM(r.pickup_at) + ' 取餐',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'text', text: '✅ 訂單確認！', weight: 'bold', size: 'lg', color: '#2E7D32' },
          { type: 'text', text: '取餐編號 #' + r.order_no, size: 'sm', color: '#888888' },
          { type: 'text', text: '食材新鮮現滷，等候時間約 ' + r.wait_minutes + ' 分鐘，請於 ' + fmtHM(r.pickup_at) + ' 前往現場取餐。', size: 'sm', wrap: true, margin: 'md' },
          { type: 'separator', margin: 'md' },
          ...flexItemRows(r),
        ],
      },
    },
  }
}

// ---------- 客人訊息：取餐時間更新（M3：改時間終於會通知了）----------
function buildRetimedMessage(r: any, oldPickup?: string): string {
  return '⏰ 取餐時間更新（取餐編號 #' + r.order_no + '）\n\n'
    + '新的取餐時間：' + fmtHM(r.pickup_at)
    + (oldPickup ? '（原 ' + fmtHM(oldPickup) + '）' : '') + '\n\n'
    + '如有疑問請致電 0939-955-888'
}

// ---------- 客人卡片：訂單內容更新（同款對帳排版）----------
function buildEditedCard(r: any, oldTotal?: number) {
  const changed = (typeof oldTotal === 'number' && oldTotal !== r.total)
  return {
    type: 'flex',
    altText: '✏️ 訂單內容更新 #' + r.order_no + '（合計 $' + r.total + '）',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'text', text: '✏️ 訂單內容更新', weight: 'bold', size: 'lg', color: '#B8860B' },
          { type: 'text', text: '取餐編號 #' + r.order_no + (changed ? '（原合計 $' + oldTotal + '）' : ''), size: 'sm', color: '#888888' },
          { type: 'separator', margin: 'md' },
          ...flexItemRows(r),
          ...(r.pickup_at ? [{ type: 'text', text: '⏰ 取餐時間不變：' + fmtHM(r.pickup_at), size: 'xs', color: '#888888', margin: 'md', wrap: true }] : []),
          { type: 'text', text: '如有疑問請致電 0939-955-888', size: 'xs', color: '#888888', wrap: true },
        ],
      },
    },
  }
}

// ---------- 老闆訊息：新訂單「按鈕卡片」（M2）----------
// 老闆的裁示：「完成鍵要在 LINE 按，要去後台就不行」——
// 所以新單直接給按鈕：✅25/30/35分＝一鍵接單（客人自動收到取餐時間）；❌＝取消（會再問一次防手滑）。
// 按鈕按下去由接待員（line-webhook）處理，只有名簿裡的老闆按了有效。
function buildNewOrderCard(r: any) {
  // 對帳版排版統一走 flexItemRows——老闆卡片跟客人卡片同一份帳
  // 按鈕文字只放「25分」三個字——三顆擠一排，帶 emoji 會被手機截成「2...」
  const acceptBtn = (m: number) => ({
    type: 'button', style: 'primary', height: 'sm', color: '#B8860B',
    action: {
      type: 'postback',
      label: m + '分',
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
          { type: 'separator', margin: 'sm' },
          ...flexItemRows(r),
          { type: 'text', text: '👇 選等候分鐘＝接單，客人自動收到取餐時間', size: 'xs', color: '#999999', wrap: true, margin: 'md' },
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

  const { kind, record, old_total, old_pickup_at } = await req.json()

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
    await pushMessages(record.line_user_id, [buildCustomerCard(record)])
  }

  if (kind === 'edited' && record?.line_user_id) {
    // 訂單被老闆修改 → 通知綁定的客人新內容（沒綁的不發，優雅降級）
    await pushMessages(record.line_user_id, [buildEditedCard(record, old_total)])
  }

  if (kind === 'retimed' && record?.line_user_id) {
    // 取餐時間被改 → 通知綁定的客人新時間（M3 補上的第四鈴聲）
    await push(record.line_user_id, buildRetimedMessage(record, old_pickup_at))
  }

  return new Response('ok')
})
