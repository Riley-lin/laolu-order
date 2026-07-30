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

// 老闆專用的圖文選單 ID（4 格版：即時看單／日報／菜單／點餐）
// 綁定成功時掛到那個人身上，解除綁定時拿掉 → 自動掉回全體預設的客人版（2 格）。
// 這串【不是機密】，只是選單的身分證號碼；換新選單圖之後要回來更新這一行。
// 查目前有哪些選單：GET https://api.line.me/v2/bot/richmenu/list
const RICHMENU_BOSS = 'richmenu-fe1d3d519470fc31a7082f91014f520f'

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
  return timingSafeEqual(expected, signature)
}

// 常數時間字串比對：不管哪個字元不同都跑完全長，避免用「比對第幾個字元才失敗」的時間差反推簽章
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false   // 長度固定（base64 SHA-256），這個提前返回不洩漏有用資訊
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
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

// ---------- 個人圖文選單切換（2026-07-30 新增）----------
//
// 在這之前，「綁定成通知對象」和「看到哪一版圖文選單」是兩件不相干的事：
// 綁定只寫進 line_admins，選單還要另外用工具頁一個一個掛，換手機就要重來一次。
// 現在把兩件事綁在一起——傳一句話，通知跟選單一起換。
//
// LINE 官方 API（逐字）：
//   掛上：POST   https://api.line.me/v2/bot/user/{userId}/richmenu/{richMenuId}
//   拿掉：DELETE https://api.line.me/v2/bot/user/{userId}/richmenu
//   https://developers.line.biz/en/docs/messaging-api/use-per-user-rich-menus/
//
// ⚠️ 這兩支【失敗也不擋流程】：選單沒換成功頂多是畫面不對，
//    但「綁定/解綁」本身關係到收不收得到訂單通知，不能因為選單掛掉就整個失敗。
async function linkBossMenu(userId: string) {
  const res = await fetch(
    `https://api.line.me/v2/bot/user/${userId}/richmenu/${RICHMENU_BOSS}`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } },
  )
  if (!res.ok) console.error('掛老闆選單失敗：', res.status, await res.text())
  return res.ok
}

// 拿掉個人選單後，這個人就會掉回「全體預設選單」＝客人版 2 格
async function unlinkBossMenu(userId: string) {
  const res = await fetch(
    `https://api.line.me/v2/bot/user/${userId}/richmenu`,
    { method: 'DELETE', headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } },
  )
  if (!res.ok) console.error('取消老闆選單失敗：', res.status, await res.text())
  return res.ok
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
    await reply(ev.replyToken, '這些按鈕只有老闆能按喔')
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
    // 只推一張「已接單·製作中」卡片就好（不再另發一段文字，介面乾淨）
    await replyMessages(ev.replyToken, [buildCookingCard(r)])
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
    await reply(ev.replyToken, '訂單 #' + rows[0].order_no + ' 完成，辛苦了！')
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
    await reply(ev.replyToken, '訂單 #' + rows[0].order_no + ' 已取消')
    return
  }

  // 🙆 不取消
  if (p.a === 'keep') {
    await reply(ev.replyToken, '好，訂單留著繼續做')
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
          { type: 'text', text: '✅ #' + r.order_no + ' 已接單 · 製作中', weight: 'bold', size: 'lg', color: '#2E7D32' },
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
    // 🛡 防重放：每則事件有唯一 webhookEventId。先「插入」去重表，插得進＝第一次處理；
    //    插不進（主鍵衝突 23505）＝這則事件已處理過（LINE 重送或有人重放封包）→ 直接跳過。
    //    先插後做＝原子操作，兩個同時進來也只有一個成功。
    const eventId: string | undefined = ev.webhookEventId
    if (eventId) {
      const { error: dupErr } = await db.from('line_webhook_events').insert({ event_id: eventId })
      if (dupErr) {
        if (dupErr.code === '23505') continue            // 重複事件 → 跳過
        console.error('dedup insert error（不擋，照常處理保可用）：', dupErr)
      }
    }

    const userId: string | undefined = ev.source?.userId
    if (!userId) continue

    // ⓪ M2：老闆按了卡片上的按鈕（postback）→ 直接在 LINE 完成接單/完成/取消
    if (ev.type === 'postback') {
      await handleBossButton(ev, userId)
      continue
    }

    // ① 加好友 → 歡迎詞（2026-07-19 老闆親擬版；(耶)(拜託)轉成表情符號）
    if (ev.type === 'follow') {
      await reply(ev.replyToken,
        '🍢 歡迎光臨 🙌\n'
        + '點擊下方『我要點餐』就能線上預訂，\n'
        + '獨立作業敬請耐心等候')
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

    // ❌ 已移除：公休／營業時間的自動回覆（2026-07-28 Riley 拍板關閉）
    //   關鍵字比對不懂上下文，只要句子裡出現那幾個字就會噴答案，例如：
    //     「上次公休沒買到好可惜」→ 回一串公休日（人家在感嘆）
    //     「我明天休假要去買」    → 回一串公休日（講的是自己休假）
    //     「不是問公休啦，我問有沒有素的」→ 還是回公休日（更慘）
    //   而它的價值早就被取代了：公休日就掛在點餐頁最上面的公告條，客人一進去就看到。
    //   價值低、誤觸代價高（機器人顯得很笨）→ 關掉，這類問題留給老闆在後台人工回。
    //   要恢復請不要用「包含比對」；改用完全比對，或直接接語意理解。

    // ③.5 老闆解除綁定：傳「老闆解除綁定」→ 把自己從管理員名簿移除（換手機/員工異動用；只會移除自己，免密語）
    if (text === '老闆解除綁定' || text === '解除綁定') {
      await db.from('line_admins').delete().eq('line_user_id', userId)
      const ok = await unlinkBossMenu(userId)   // 順便把選單換回客人版
      await reply(ev.replyToken,
        '已解除綁定，這支手機之後不會再收到新訂單通知。'
        + (ok ? '\n下方選單已換回客人版（重開聊天室即可看到）' : ''))
      continue
    }

    // ③ 老闆綁定：傳「老闆綁定 <密語>」→ 登記成管理員
    if (text.startsWith('老闆綁定')) {
      const code = text.replace('老闆綁定', '').trim()
      if (!BOSS_BIND_CODE || code !== BOSS_BIND_CODE) {
        await reply(ev.replyToken, '密語不對喔')
        continue
      }
      await db.from('line_admins').upsert({ line_user_id: userId })
      const ok = await linkBossMenu(userId)     // 順便換成老闆版 4 格選單
      await reply(ev.replyToken,
        '老闆綁定成功！之後有新訂單會通知你。'
        + (ok ? '\n下方選單已換成店務版（重開聊天室即可看到）' : ''))
      continue
    }

    // ④.0 送單確認（2026-07-28 Riley 升級：三重驗證才回覆）
    //
    //   客人按「送出訂單」時，點餐頁會以【客人自己的身分】傳一則訊息進來：
    //     您好~ / 我已送出訂單囉~ / 訂單編號：#005 / 手機末三碼：888 / 我會前往取餐…
    //
    //   ⚠️ 為什麼要驗三樣（Riley 抓到的問題）：
    //     舊版只要句子裡有「我已送出訂單 #任何數字」就回「已收到」，
    //     於是隨便打 #999 也會得到確認 → 那是【假確認】，客人打錯編號會被誤導。
    //     現在必須「同一個人 × 同一張單 × 同一支電話」三者都對得上才回。
    //
    //   ⚠️ 為什麼要先等 2 秒：
    //     這則訊息是在【訂單寫進資料庫之前】發出的（先發訊息、成功才寫單，
    //     這樣才不會產生「老闆收到單卻不知道是誰」的幽靈單）→ 馬上查一定查不到。
    //     等 2 秒讓前端把訂單寫完，再查就對得上。
    //     （LINE 的 replyToken 還在有效期內，2 秒很安全。）
    //
    //   驗不過就【完全不回】——寧可少一則確認，也不要給錯誤的確認。
    const oc = text.includes('我已送出訂單') ? text.match(/#([0-9]{1,4}[A-Za-z]?)/) : null
    if (oc) {
      const orderNo = oc[1].toUpperCase()
      const tailM = text.match(/末三碼[：:]\s*(\d{3})/)
      const tail = tailM ? tailM[1] : ''
      if (!tail) continue                       // 沒帶末三碼＝不是我們發的格式 → 安靜

      // 只找「今天」的單（跟看單台同一個規則；雲端時鐘是 UTC，要明講台北零點）
      const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date())
      const taipeiMidnight = new Date(ymd + 'T00:00:00+08:00').toISOString()
      const findOrder = async () => (await db
        .from('orders')
        .select('order_no, customer_phone, line_user_id')
        .eq('order_no', orderNo)                 // ② 訂單編號要存在
        .eq('line_user_id', userId)              // ① 必須是【他自己】下的單
        .gte('created_at', taipeiMidnight)
        .maybeSingle()).data

      // 先查一次；查不到才等 1.5 秒重試一次（訂單可能還在寫入途中）。
      // 這樣正常客人不用每次都白等，亂傳的人也只是多等一下下、照樣得不到回應。
      let order = await findOrder()
      if (!order) { await new Promise(r => setTimeout(r, 1500)); order = await findOrder() }

      // ③ 手機末三碼要對得上（資料庫存的是完整號碼，取後三碼比對）
      const dbTail = (order?.customer_phone ?? '').replace(/\D/g, '').slice(-3)
      if (!order || dbTail !== tail) continue    // 三者只要有一樣對不上 → 安靜，不給假確認

      await reply(ev.replyToken,
        '已收到訂單 #' + order.order_no + '\n'
        + '店家確認接單後，可在下方「訂單查詢」查看取餐時間')
      continue
    }

    // ❌ 已移除：「傳純數字取餐編號 → 綁定訂單」（2026-07-28 Riley 抓到）
    //   為什麼砍：它是【覆蓋式】綁定——任何人傳「001」就把那張單的 line_user_id
    //   改成自己，於是
    //     ① 真正下單的客人收不到取餐通知
    //     ② 亂打數字的人反而收到別人的訂單內容（姓名、電話、明細）
    //   而這個功能本來的用途（客人手動把 LINE 綁到訂單）已經被 LIFF 自動綁定取代，
    //   留著只剩風險。要恢復的話必須先做「只能綁自己剛下的單」的驗證。

    // 其他訊息 → 「不自動回覆」：讓機器人安靜，客人留給老闆的話乖乖留著、老闆可在 LINE 後台人工回
    //   （引導已在「加好友歡迎詞」講過；特定指令 公休/取餐編號/老闆綁定 仍照常有反應）
  }

  return new Response('ok')
})
