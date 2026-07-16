// ============================================================
// 老滷仙 LINE 接待員（Webhook）
// 職責：客人在 LINE 傳訊息給官方帳號時，LINE 會把訊息轉送到這裡。
//
// 它會做四件事：
//   1. 有人加好友 → 回歡迎詞＋教他怎麼綁定訂單
//   2. 有人傳「取餐編號」（例如 004）→ 把他的 LINE 綁到今天的那張訂單
//      （綁定之後，老闆確認接單時，系統就知道要通知誰）
//   3. 老闆傳「老闆綁定 <密語>」→ 登記成管理員（之後新訂單會通知他）
//   4. 有人傳「id」→ 回覆他的 LINE 用戶編號（測試用）
//
// 安全機制：每一則進來的訊息都會驗「LINE 簽章」——
// 用 Channel Secret 算一次雜湊比對，確認真的是 LINE 送來的，
// 不是路人假冒（沒過驗證直接拒收）。
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'

// 這些鑰匙存在 Supabase 的保險箱（Secrets），不寫在程式碼裡
const CHANNEL_SECRET = Deno.env.get('LINE_CHANNEL_SECRET')!
const ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN')!
const BOSS_BIND_CODE = Deno.env.get('BOSS_BIND_CODE') ?? '' // 老闆綁定密語

// 用最高權限連自家資料庫（這段程式跑在雲端、不在瀏覽器，所以安全）
const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

// ---------- 驗證 LINE 簽章：確認訊息真的來自 LINE ----------
async function verifySignature(body: string, signature: string | null): Promise<boolean> {
  if (!signature) return false
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(CHANNEL_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)))
  return expected === signature
}

// ---------- 回覆訊息（用 LINE 給的一次性回覆券 replyToken）----------
async function reply(replyToken: string, text: string) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  })
}

// ---------- 台北時間 HH:MM（跟 boss.html 的 fmtHM 同一套）----------
function fmtHM(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-TW',
    { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false })
}

Deno.serve(async (req) => {
  const body = await req.text()

  // 驗章不過＝不是 LINE 本人，拒收
  if (!(await verifySignature(body, req.headers.get('x-line-signature')))) {
    return new Response('bad signature', { status: 403 })
  }

  const { events } = JSON.parse(body)

  for (const ev of events ?? []) {
    const userId: string | undefined = ev.source?.userId
    if (!userId) continue

    // ① 加好友 → 歡迎詞
    if (ev.type === 'follow') {
      await reply(ev.replyToken,
        '🍢 歡迎光臨老滷仙！\n\n'
        + '線上點餐完成後，把你的「取餐編號」傳給我（例如：004），\n'
        + '老闆確認接單時，取餐時間就會自動通知你 🔔')
      continue
    }

    // 只處理文字訊息
    if (ev.type !== 'message' || ev.message?.type !== 'text') continue
    const text: string = (ev.message.text ?? '').trim()

    // ② 傳「id」→ 回用戶編號（部署測試用）
    if (/^id$/i.test(text)) {
      await reply(ev.replyToken, '你的 LINE 用戶編號：\n' + userId)
      continue
    }

    // ③ 老闆綁定：傳「老闆綁定 <密語>」→ 登記成管理員
    if (text.startsWith('老闆綁定')) {
      const code = text.replace('老闆綁定', '').trim()
      if (!BOSS_BIND_CODE || code !== BOSS_BIND_CODE) {
        await reply(ev.replyToken, '密語不對喔 🤔')
        continue
      }
      await db.from('line_admins').upsert({ line_user_id: userId })
      await reply(ev.replyToken, '✅ 老闆綁定成功！之後有新訂單會通知你。')
      continue
    }

    // ④ 傳取餐編號（例如 004 / #004 / 004A）→ 綁到今天的那張訂單
    const m = text.match(/^#?(\d{1,4}[A-Za-z]?)$/)
    if (m) {
      const orderNo = m[1].toUpperCase()
      // 只找「今天」的訂單——跟查詢頁同一個規則，昨天的編號不算數
      // （雲端主機的時鐘是世界標準時間，要明確講「台北的今天零點」它才不會算錯日）
      const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date())
      const taipeiMidnight = new Date(ymd + 'T00:00:00+08:00').toISOString()
      const { data: order } = await db
        .from('orders')
        .select('id, order_no, status, pickup_at')
        .eq('order_no', orderNo)
        .gte('created_at', taipeiMidnight)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!order) {
        await reply(ev.replyToken, '找不到今天的訂單 #' + orderNo + ' 耶，確認一下編號？')
        continue
      }

      // 把這位客人的 LINE 記到訂單上
      await db.from('orders').update({ line_user_id: userId }).eq('id', order.id)

      // 依訂單目前的狀態，給對應的回覆
      if (order.status === 'confirmed' && order.pickup_at) {
        await reply(ev.replyToken,
          '✅ 綁定成功！你的訂單 #' + order.order_no + ' 老闆已經在滷了，\n'
          + '請於 ' + fmtHM(order.pickup_at) + ' 前往取餐 🍢')
      } else {
        await reply(ev.replyToken,
          '✅ 綁定成功！訂單 #' + order.order_no + ' 等老闆確認接單後，\n'
          + '取餐時間會自動通知你 🔔')
      }
      continue
    }

    // 其他訊息 → 溫柔引導
    await reply(ev.replyToken,
      '我是點餐小幫手 🍢\n傳「取餐編號」給我（例如：004），確認接單後就會通知你取餐時間！')
  }

  return new Response('ok')
})
