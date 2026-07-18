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
// 小知識：「回覆」不占推播額度（免費），所以老闆按按鈕的回饋全用回覆做
async function reply(replyToken: string, text: string) {
  await replyMessages(replyToken, [{ type: 'text', text }])
}

async function replyMessages(replyToken: string, messages: unknown[]) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  })
  if (!res.ok) console.error('LINE reply 失敗：', res.status, await res.text())
}

// ---------- 台北時間 HH:MM（跟 boss.html 的 fmtHM 同一套）----------
function fmtHM(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-TW',
    { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false })
}

// ============================================================
// 🔘 M2：老闆按鈕處理（2026-07-18 老闆裁示「完成鍵要在 LINE 按」）
// 按鈕藏在推播員發的新單卡片裡，按下去 LINE 會把「postback 資料」
// 送到這裡。資料格式：{ a: 動作, id: 訂單編號, m: 分鐘 }
//   a='ok'  ＝接單（帶等候分鐘）→ 寫入資料庫 → 門鈴自動通知客人
//   a='done'＝完成　a='no1'＝想取消（先問一次防手滑）　a='no'＝真的取消　a='keep'＝不取消
// 安全：先查 line_admins 名簿，不是老闆按的一律拒絕
// 防重複：更新時加「目前狀態」條件，兩個老闆同時按也只會生效一次
// ============================================================
async function handleBossButton(ev: any, userId: string) {
  let p: any = {}
  try { p = JSON.parse(ev.postback?.data ?? '{}') } catch { /* 看不懂的資料就當沒事 */ }
  if (!p.a) return

  // 門禁：只有登記過的老闆能按
  const { data: admin } = await db.from('line_admins')
    .select('line_user_id').eq('line_user_id', userId).maybeSingle()
  if (!admin) {
    await reply(ev.replyToken, '這些按鈕只有老闆能按喔 🍢')
    return
  }

  // ✅ 接單：狀態 new → confirmed（只有還是新單才會成功＝防重複按）
  if (p.a === 'ok') {
    const mins = Math.min(180, Math.max(5, parseInt(p.m, 10) || 30))
    const now = new Date()
    const pickup = new Date(now.getTime() + mins * 60000)
    const { data: rows } = await db.from('orders')
      .update({
        status: 'confirmed', confirmed_at: now.toISOString(),
        wait_minutes: mins, pickup_at: pickup.toISOString(),
      })
      .eq('id', p.id).eq('status', 'new').select()
    if (!rows?.length) {
      await reply(ev.replyToken, '這張單已經處理過囉（可能剛剛已按過或已取消）')
      return
    }
    const r = rows[0]
    // 這次更新會自動觸發資料庫門鈴 → 推播員通知綁定的客人（不用這裡多做事）
    await replyMessages(ev.replyToken, [
      {
        type: 'text',
        text: '✅ 已接單 #' + r.order_no + '，取餐時間 ' + fmtHM(r.pickup_at) + '\n'
          + (r.line_user_id ? '客人已自動收到通知 🔔' : '（這位客人沒綁 LINE，會用查詢頁看時間）'),
      },
      buildCookingCard(r),
    ])
    return
  }

  // 🏁 完成：狀態 confirmed → done
  if (p.a === 'done') {
    const { data: rows } = await db.from('orders')
      .update({ status: 'done' })
      .eq('id', p.id).eq('status', 'confirmed').select()
    if (!rows?.length) {
      await reply(ev.replyToken, '這張單不在製作中，可能已完成或已取消囉')
      return
    }
    await reply(ev.replyToken, '🏁 訂單 #' + rows[0].order_no + ' 完成，辛苦了！')
    return
  }

  // ❌ 第一段：想取消 → 先確認一次（防手滑，跟看單台的確認視窗同一個精神）
  if (p.a === 'no1') {
    const { data: r } = await db.from('orders')
      .select('id, order_no, status').eq('id', p.id).maybeSingle()
    if (!r || (r.status !== 'new' && r.status !== 'confirmed')) {
      await reply(ev.replyToken, '這張單目前不能取消（已完成或已取消）')
      return
    }
    await replyMessages(ev.replyToken, [{
      type: 'flex',
      altText: '確定要取消訂單 #' + r.order_no + ' 嗎？',
      contents: {
        type: 'bubble',
        body: {
          type: 'box', layout: 'vertical', spacing: 'sm', contents: [
            { type: 'text', text: '⚠️ 確定要取消訂單 #' + r.order_no + ' 嗎？', weight: 'bold', wrap: true },
            { type: 'text', text: '取消後客人就點不到這張單了', size: 'xs', color: '#999999', wrap: true },
          ],
        },
        footer: {
          type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
            {
              type: 'button', style: 'secondary', height: 'sm',
              action: { type: 'postback', label: '留著不取消', data: JSON.stringify({ a: 'keep' }), displayText: '訂單留著' },
            },
            {
              type: 'button', style: 'primary', color: '#CC4444', height: 'sm',
              action: { type: 'postback', label: '確定取消', data: JSON.stringify({ a: 'no', id: r.id }), displayText: '確定取消 #' + r.order_no },
            },
          ],
        },
      },
    }])
    return
  }

  // ❌ 第二段：真的取消
  if (p.a === 'no') {
    const { data: rows } = await db.from('orders')
      .update({ status: 'cancelled' })
      .eq('id', p.id).in('status', ['new', 'confirmed']).select()
    if (!rows?.length) {
      await reply(ev.replyToken, '這張單已經不能取消了（可能已完成或已取消）')
      return
    }
    await reply(ev.replyToken, '❌ 訂單 #' + rows[0].order_no + ' 已取消')
    return
  }

  // 🙆 不取消
  if (p.a === 'keep') {
    await reply(ev.replyToken, '好，訂單留著繼續做 🍢')
    return
  }
}

// 接單後回給老闆的「製作中卡片」：上面有完成/取消按鈕，做完直接按
function buildCookingCard(r: any) {
  return {
    type: 'flex',
    altText: '🔥 #' + r.order_no + ' 製作中',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'text', text: '🔥 #' + r.order_no + ' 製作中', weight: 'bold', size: 'lg', color: '#B8860B' },
          { type: 'text', text: '⏰ 取餐時間 ' + fmtHM(r.pickup_at), size: 'sm' },
          { type: 'text', text: '做好了按「完成」歸檔', size: 'xs', color: '#999999' },
        ],
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
          {
            type: 'button', style: 'secondary', height: 'sm',
            action: { type: 'postback', label: '❌ 取消', data: JSON.stringify({ a: 'no1', id: r.id }), displayText: '取消 #' + r.order_no + '？' },
          },
          {
            type: 'button', style: 'primary', color: '#4A8B4A', height: 'sm',
            action: { type: 'postback', label: '🏁 完成', data: JSON.stringify({ a: 'done', id: r.id }), displayText: '完成 #' + r.order_no },
          },
        ],
      },
    },
  }
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

    // ⓪ M2：老闆按了卡片上的按鈕（postback）→ 直接在 LINE 完成接單/完成/取消
    if (ev.type === 'postback') {
      await handleBossButton(ev, userId)
      continue
    }

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
