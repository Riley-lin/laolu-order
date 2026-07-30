// ============================================================
// 老滷仙 下單守門員（place-order）
// 職責：客人送出訂單時，不再讓瀏覽器「直接寫資料庫」，而是先經過這道正門。
//
// 這道門依序檢查五關（2026-07-30 大改版）：
//   ① 身分驗章：客人說「我是誰」不算數，拿 LINE 的 ID Token 去跟 LINE 對章
//   ② 黑名單：有棄單紀錄還在封鎖期內的，客氣地擋下
//   ③ 限流：同一人 或 同一 IP，10 分鐘 5 張就擋（2 分鐘內爆 5 張還會通知老闆）
//   ④ 高額連續下單：30 分鐘內 2 張且每張都 > $500 → 標記＋通知老闆（提醒，不擋）
//   ⑤ 形狀檢查 → 用 service_role 寫入（金額仍由資料庫觸發器重算覆寫）
//
// 搭配 RLS：orders 的「anon 直接 insert」政策已移除 → 客人只能走這道正門。
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'

// 🔓 Turnstile 開關（2026-07-28 Riley 拍板停用）
//   原因：客人端入口已鎖死在 LINE（LIFF 身分＋授權代發訊息＋送出時真的發一則訊息），
//   機器人過不了那四關；而 Turnstile 在 LINE 內嵌瀏覽器裡會誤擋真客人（老闆實測被擋）。
//   要恢復：這行改 true，並把 index.html 的同名開關也改回 true。
const REQUIRE_TURNSTILE = false
const TURNSTILE_SECRET = Deno.env.get('TURNSTILE_SECRET') ?? ''

// LINE Login channel ID（＝ LIFF ID 的前半段）。驗 ID Token 時要告訴 LINE
// 「我要驗的是發給我這個 channel 的票」，才不會收下別人家的票。
const LINE_LOGIN_CHANNEL_ID = '2010753920'

/* 🔧 身分驗章的嚴格程度
   true  ＝ 驗不過就擋（正式行為）
   false ＝ 驗不過時退回用前端送來的 line_user_id（黑名單與限流照樣套用）

   2026-07-30 一度改成 false，因為驗章誤擋了 Riley——
   但後來查 log 發現真兇是我自己的 bug（預檢沒有 records，for...of 直接炸），
   驗章其實是好的。同一晚把取票方式改成 access token（見下）之後，
   誤擋的結構性原因也消失了，所以改回 true。 */
const ID_TOKEN_STRICT = true

// 老闆通知用（Secrets 是專案共用的，line-push 設的這把這裡也讀得到）
const ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') ?? ''

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

// ---------- 防洪參數（要調就改這裡，全檔只有這一處）----------
const RATE_MAX = 5           // 一般限流：10 分鐘最多 5 張
const RATE_WINDOW_MIN = 10
const BURST_MAX = 5          // 爆量：2 分鐘內就下滿 5 張 → 疑似洗版，通知老闆
const BURST_WINDOW_MIN = 2
const HIGH_VALUE_AMOUNT = 500   // 高額門檻：每張都超過這個數字
const HIGH_VALUE_WINDOW_MIN = 10   // 2026-07-30 Riley 從 30 分鐘收緊成 10 分鐘
const HIGH_VALUE_COUNT = 2      // 10 分鐘內第 2 張就算「連續高額」

// 🔔 高額警示要不要發 LINE 給老闆（會扣 1 則訊息額度）
//   老闆嫌吵就改 false——改成 false 之後，看單台的 ⚠️ 標記照樣會有，
//   只是不會主動推播打擾他。
const HIGH_VALUE_PUSH = true

// 擋下時給客人看的話（Riley 定稿，一字不改）
const MSG_RATE_LIMITED =
  '下單太頻繁，老闆會忙不過來，請稍等幾分鐘 ，如有多單需求，請跟店家聯繫喔!📞0939-955-888'

// CORS：允許客人端網頁/LIFF 跨網域呼叫
const cors: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'content-type': 'application/json' } })
}

// ---------- 向 Cloudflare 驗證 Turnstile token（停用中）----------
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

// ============================================================
// ① 身分驗章：把「客人自稱的身分」換成「LINE 認證過的身分」
//
// 【為什麼這是地基】在這之前，前端說「我是 U1234…」後端就信。
//   於是任何人都能冒用別人的 LINE ID 下單——黑名單會變成紙糊的
//   （被封鎖的人只要改一個字就能繞過），限流也一樣。
//
// 【怎麼做】LIFF 會發一張有 LINE 簽名的「身分票」（ID Token），
//   我們把票寄回 LINE 問「這張是不是你發的、發給誰的」，
//   LINE 回覆裡的 sub 就是【真正的】userId。
//
// LINE 官方文件（逐字）：
//   "you can validate the ID token and get the corresponding user's profile information
//    by simply sending the ID token ... and LINE Login channel ID to a dedicated API endpoint"
//   POST https://api.line.me/oauth2/v2.1/verify  （id_token ＋ client_id）
//   回應的 sub ＝ "the User ID for which the ID token is generated"
//   https://developers.line.biz/en/docs/line-login/verify-id-token/
// ============================================================
/* ⏱ 為什麼主力改用 access token（2026-07-30 深夜修正）

   LINE 官方逐字：
     "The ID token is valid for **one hour** after it is issued."
     "An access token is valid for **12 hours** after it is issued."
     https://developers.line.biz/en/reference/liff/

   ID token 只有 1 小時。客人在 LINE 裡開著點餐頁邊看邊聊、放著去忙，
   一小時後送出訂單 → 票過期 → 被擋。這不是「可能發生」，是【一定會發生】。
   一天 10 單的店，只要有一個客人這樣，那就是一張真實流失的訂單。

   access token 有 12 小時，遠遠涵蓋一次點餐的時間。
   驗法是兩步（缺一不可）：
     ① GET /oauth2/v2.1/verify?access_token=…  → 回 client_id，確認這張票是【發給我們 channel】的
        （只做第②步的話，別的 app 的 token 也能通過——那等於沒驗）
     ② GET /v2/profile（Bearer 那張票）        → 回 userId，這才是可信的身分

   ID token 保留當備援：萬一 access token 那條路出狀況，還有第二條腿。 */
async function verifyAccessToken(accessToken: string): Promise<{ userId: string | null, why: string }> {
  if (!accessToken) return { userId: null, why: 'A1_前端沒帶通行票' }
  try {
    // ① 這張票是發給我們 channel 的嗎
    const vr = await fetch('https://api.line.me/oauth2/v2.1/verify?access_token='
      + encodeURIComponent(accessToken))
    const vtext = await vr.text()
    if (!vr.ok) {
      console.error('access token 驗證失敗：', vr.status, vtext)
      return { userId: null, why: 'A2_LINE拒絕(' + vr.status + ')' + vtext.slice(0, 100) }
    }
    const vdata = JSON.parse(vtext)
    if (String(vdata?.client_id) !== LINE_LOGIN_CHANNEL_ID) {
      console.error('access token 的 client_id 不是我們的 channel：', vdata?.client_id)
      return { userId: null, why: 'A3_channel不符(' + vdata?.client_id + ')' }
    }
    // ② 拿這張票去問 LINE「你是誰」
    const pr = await fetch('https://api.line.me/v2/profile', {
      headers: { 'Authorization': 'Bearer ' + accessToken },
    })
    const ptext = await pr.text()
    if (!pr.ok) {
      console.error('取 profile 失敗：', pr.status, ptext)
      return { userId: null, why: 'A4_取身分失敗(' + pr.status + ')' }
    }
    const pdata = JSON.parse(ptext)
    if (typeof pdata?.userId !== 'string') return { userId: null, why: 'A5_回應裡沒有 userId' }
    return { userId: pdata.userId, why: '' }
  } catch (e) {
    console.error('access token 驗證連線失敗：', e)
    return { userId: null, why: 'A6_連線失敗' }
  }
}

// 回傳 { userId, why }：why 是失敗原因代碼，會一路帶到客人端，
// 這樣「客人回報下不了單」時，看畫面上那個代碼就知道斷在哪，不用瞎猜。
async function verifyIdToken(idToken: string): Promise<{ userId: string | null, why: string }> {
  if (!idToken) return { userId: null, why: 'E1_前端沒帶身分票' }
  try {
    const form = new URLSearchParams()
    form.set('id_token', idToken)
    form.set('client_id', LINE_LOGIN_CHANNEL_ID)
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    })
    const text = await res.text()
    if (!res.ok) {
      console.error('ID Token 驗證失敗：', res.status, text)
      return { userId: null, why: 'E2_LINE拒絕(' + res.status + ')' + text.slice(0, 120) }
    }
    const data = JSON.parse(text)
    // sub 才是可信的 userId；順便確認這張票確實是發給我們這個 channel 的
    if (data?.aud !== LINE_LOGIN_CHANNEL_ID) {
      console.error('ID Token 的 aud 不是我們的 channel：', data?.aud, '期待：', LINE_LOGIN_CHANNEL_ID)
      return { userId: null, why: 'E3_channel不符(票是給 ' + data?.aud + ')' }
    }
    if (typeof data?.sub !== 'string') return { userId: null, why: 'E4_回應裡沒有 sub' }
    return { userId: data.sub, why: '' }
  } catch (e) {
    console.error('ID Token 驗證連線失敗：', e)
    return { userId: null, why: 'E5_連線失敗' }
  }
}

// 從訂單內容裡撈出前端自報的 line_user_id（寬鬆模式的退路）
function frontendUserId(records: any): string | null {
  const first = Array.isArray(records) ? records[0] : null
  const id = first?.line_user_id
  return (typeof id === 'string' && /^U[0-9a-f]{32}$/i.test(id)) ? id : null
}

// ---------- 推播給老闆（高額／洗版警示用）----------
//   不經過 line-push，因為那支的職責是「訂單卡片」；
//   警示是另一件事，直接發純文字最單純。失敗只記 log，絕不影響下單。
async function alertBoss(text: string) {
  if (!ACCESS_TOKEN) return
  try {
    const { data: admins } = await db.from('line_admins').select('line_user_id')
    for (const a of admins ?? []) {
      await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ACCESS_TOKEN}` },
        body: JSON.stringify({ to: a.line_user_id, messages: [{ type: 'text', text }] }),
      })
    }
  } catch (e) {
    console.error('警示推播失敗（不影響下單）：', e)
  }
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString()

/* 🚨 應急模式：LINE 掛掉時的備援通道（2026-07-30）

   平常入口鎖死在 LINE，這是優點——每張單都對得到一個真人。
   但 LINE 平台一掛（07-28 發生過），整間店的線上訂餐就歸零。

   應急模式讓客人用「帶通行碼的網址」下單，不需要 LINE 身分。
   三道限制讓它夠安全：平常開關是關的 ＋ 通行碼可一鍵換新 ＋ 只開幾小時。

   ⚠️ 開關與通行碼分開放：
     開關 emergency_on 在 app_config（前端讀得到——客人端要知道現在是不是應急模式）
     通行碼 emergency_code 在 app_secrets（前端讀不到，只有這裡比對）
   放同一個地方的話，通行碼等於印在門上。 */
async function checkEmergency(code: string): Promise<boolean> {
  if (!code) return false
  try {
    const { data: cfg } = await db.from('app_config')
      .select('value').eq('name', 'emergency_on').maybeSingle()
    if (cfg?.value !== '1') return false          // 開關沒開 → 網址外流也是死的
    const { data: sec } = await db.from('app_secrets')
      .select('value').eq('name', 'emergency_code').maybeSingle()
    return !!sec?.value && sec.value === code
  } catch (e) {
    console.error('應急模式檢查失敗：', e)
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
  const idToken: string = payload?.id_token ?? ''
  const accessToken: string = payload?.access_token ?? ''
  const records = payload?.records

  // ⓪ Turnstile（停用中，見檔案開頭說明）
  if (REQUIRE_TURNSTILE) {
    if (!token || !(await verifyTurnstile(token, ip))) {
      return json({ error: 'turnstile_failed', message: '安全驗證未通過，請重新整理頁面再送一次 🙏' }, 403)
    }
  }

  // 🔍 預檢模式（precheck）：只驗身分＋查黑名單，不寫任何東西
  //
  //   【為什麼需要它】客人端的送單順序是「先發 LINE 訊息 → 訊息成功才寫訂單」，
  //   這是為了不要產生「老闆收到單卻不知道是誰」的幽靈單。
  //   但這樣一來，被封鎖的客人會【先把訊息發出去】才被擋 →
  //   老闆聊天室多一則「我已送出訂單 #018」，訂單卻不存在，反而更亂。
  //   所以客人端在發訊息之前先來敲這道門問一句「我能下單嗎」。
  const precheck = payload?.precheck === true

  // ① 形狀檢查（先做，省得對垃圾資料做後面的網路查詢）
  if (!precheck && (!Array.isArray(records) || records.length === 0 || records.length > 10)) {
    return json({ error: 'bad_records', message: '訂單格式異常，請重新整理再試' }, 400)
  }

  // ② 身分驗章 —— 從這裡開始，只認 LINE 認證過的 userId
  //    主力走 access token（12 小時）；它不行才退而求其次用 ID token（1 小時）。
  //    兩條腿都斷了才算失敗——這樣單一 API 抖一下不會讓客人下不了單。
  let v = await verifyAccessToken(accessToken)
  if (!v.userId) {
    const v2 = await verifyIdToken(idToken)
    if (v2.userId) v = v2
    else v = { userId: null, why: v.why + ' ｜ ' + v2.why }
  }
  let userId = v.userId

  if (!userId && !ID_TOKEN_STRICT) {
    // 寬鬆模式：驗不過就退回前端自報的身分（黑名單與限流照樣往下套）
    //   預檢時還沒有 records，所以前端會另外把 line_user_id 放在最外層
    const claimed: string = payload?.line_user_id ?? ''
    userId = (precheck
      ? (/^U[0-9a-f]{32}$/i.test(claimed) ? claimed : null)
      : frontendUserId(records))
    if (userId) console.warn('⚠️ 身分驗章未過，暫用前端身分：', v.why, '→', userId.slice(0, 8) + '…')
  }

  // ②.5 應急模式：沒有 LINE 身分，但帶著有效通行碼 → 放行
  //     這種單標記成 ⚡ 應急單，老闆看單台一眼分得出來
  //     （沒有 LINE 身分＝出問題只能靠電話找人，他要知道）
  let isEmergency = false
  if (!userId) {
    isEmergency = await checkEmergency(String(payload?.e ?? ''))
    if (isEmergency && !precheck) {
      for (const r of records as any[]) { r.emergency = true; r.line_user_id = null }
    }
  }

  if (!userId && !isEmergency) {
    return json({
      error: 'no_line_id',
      // ⚠️ 這句話要同時對兩種人講得通：
      //   ① 真的用瀏覽器開的人 → 要引導他回 LINE
      //   ② 在 LINE 裡但身分票過期的人（頁面開太久）→ 要告訴他重開就好，
      //      不然他會覺得「我明明就在 LINE 裡，這系統壞了」
      message: '請從老滷仙 LINE 官方帳號下方的「我要點餐」進入下單 🙏\n'
        + '（若你已經在 LINE 裡面，請把這頁關掉重新點一次「我要點餐」）',
      why: v.why,     // 除錯用：客人端會把它印在提示最下面一行
    }, 403)
  }
  // 🔑 關鍵一行：不管前端送來什麼，一律用驗過的身分覆蓋。
  //    少了這行，前面的驗章就全白做了。
  //    （應急單沒有 LINE 身分，上面已經設成 null，這裡就不要再動它）
  if (!precheck && userId) for (const r of records as any[]) r.line_user_id = userId

  // ③ 黑名單（棄單封鎖中）
  //    設計成「比對到期時間」，所以 30 天一到自然就過期，不需要任何排程去解封。
  //    ⚠️ 應急單沒有 LINE 身分 → 查不了黑名單，只能靠 IP 限流把關。
  //       這是應急模式的已知代價：故障期間，防護會退化成「擋得住洪水，擋不住特定人」。
  const { data: blocked } = userId
    ? await db.from('blocklist').select('until').eq('line_user_id', userId).maybeSingle()
    : { data: null }
  if (blocked && new Date(blocked.until) > new Date()) {
    const until = new Date(blocked.until).toLocaleDateString('zh-TW',
      { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' })
    return json({
      error: 'blocked',
      message: '您有未取餐紀錄，線上訂餐暫停至 ' + until + '，造成不便請見諒，歡迎現場購買 🙏',
      until: blocked.until,
    }, 403)
  }

  // 預檢到這裡就結束——身分是真的、沒有被封鎖，可以放心去發 LINE 訊息了。
  // （限流刻意不在預檢做：預檢不記帳，若在這裡擋，正常客人會被自己上一秒的預檢誤傷）
  if (precheck) return json({ ok: true, precheck: true }, 200)

  // ④ 限流：人 ＋ IP 雙軌
  //    兩條軌道各司其職：
  //      認人 → 換網路（4G 切 WiFi）也繞不過，因為 LINE 身分不變
  //      認 IP → 有人寫程式用一堆假身分灌單時，還有這道
  //    只要任一條超標就擋。
  //    ⚠️ 應急單沒有身分，那一軌自動跳過，只剩 IP（見上面黑名單處的說明）
  const since = minutesAgo(RATE_WINDOW_MIN)
  const [byUser, byIp] = await Promise.all([
    userId
      ? db.from('order_throttle').select('*', { count: 'exact', head: true })
          .eq('line_user_id', userId).gte('at', since)
      : Promise.resolve({ count: 0 }),
    db.from('order_throttle').select('*', { count: 'exact', head: true })
      .eq('ip', ip).gte('at', since),
  ])
  const userCount = byUser.count ?? 0
  const ipCount = byIp.count ?? 0

  if (userCount >= RATE_MAX || ipCount >= RATE_MAX) {
    // 爆量偵測：這些單是不是「2 分鐘內」灌出來的？
    //   10 分鐘 5 張 ＝ 可能是幫朋友分批訂（正常人）
    //   2 分鐘 5 張  ＝ 不像人手動點得出來 → 通知老闆留意
    const burstQ = userId
      ? db.from('order_throttle').select('*', { count: 'exact', head: true })
          .eq('line_user_id', userId).gte('at', minutesAgo(BURST_WINDOW_MIN))
      : db.from('order_throttle').select('*', { count: 'exact', head: true })
          .eq('ip', ip).gte('at', minutesAgo(BURST_WINDOW_MIN))
    const { count: burst } = await burstQ
    if ((burst ?? 0) >= BURST_MAX) {
      await alertBoss(
        '⚠️ 疑似洗版\n\n有人在 ' + BURST_WINDOW_MIN + ' 分鐘內連續送出 ' + burst + ' 張訂單，'
        + '系統已自動擋下。\n\n若是熟客要訂多份，請直接用 LINE 或電話幫他記單。')
    }
    return json({ error: 'rate_limited', message: MSG_RATE_LIMITED }, 429)
  }

  // ⑤ 高額連續下單警示（提醒，不擋）
  //    條件（Riley 拍板，2026-07-30 收緊）：
  //      同一人 【或】 同一 IP，10 分鐘內 2 張、且【每張都】超過 $500
  //
  //    為什麼要「每張都」而不是「加起來」——只看加總的話，
  //    一群同事各訂各的午餐很容易破 500，警示天天響就沒人看了。
  //
  //    為什麼人和 IP 都要看：跟限流同一個道理。
  //      認人  → 換網路也躲不掉
  //      認 IP → 用不同 LINE 帳號輪流下單也躲不掉
  //    這裡是「提醒」不是「擋」，所以寧可多提醒一點。
  const orderTotal = (records as any[]).reduce((s, r) => s + (Number(r?.total) || 0), 0)
  let isHighValue = false
  if (orderTotal > HIGH_VALUE_AMOUNT) {
    const hvSince = minutesAgo(HIGH_VALUE_WINDOW_MIN)
    const [prevUser, prevIp] = await Promise.all([
      userId
        ? db.from('order_throttle').select('total, at')
            .eq('line_user_id', userId).gte('at', hvSince).gt('total', HIGH_VALUE_AMOUNT)
            .order('at', { ascending: false })
        : Promise.resolve({ data: [] as any[] }),
      db.from('order_throttle').select('total, at')
        .eq('ip', ip).gte('at', hvSince).gt('total', HIGH_VALUE_AMOUNT)
        .order('at', { ascending: false }),
    ])
    // 哪一條先湊滿就用哪一條的資料報給老闆（同一人優先，訊息比較好懂）
    const hitUser = (prevUser.data?.length ?? 0) >= HIGH_VALUE_COUNT - 1
    const hitIp = (prevIp.data?.length ?? 0) >= HIGH_VALUE_COUNT - 1
    if (hitUser || hitIp) {
      isHighValue = true
      const last = (hitUser ? prevUser.data![0] : prevIp.data![0])
      const who = hitUser ? '同一位客人' : '同一個網路（可能是同一群人）'
      const mins = Math.max(1, Math.round((Date.now() - new Date(last.at).getTime()) / 60000))
      if (HIGH_VALUE_PUSH) {
        await alertBoss(
          '⚠️ 高額連續下單\n\n' + who + ' ' + mins + ' 分鐘前下單 $' + last.total
          + '，本次 $' + orderTotal + '，請留意。\n\n（訂單照常成立，看單台會標記這張單）')
      }
    }
  }
  if (isHighValue) for (const r of records as any[]) r.high_value = true

  // ⑥ 記一筆流量帳（限流與高額判斷都靠這張表回頭查）
  await db.from('order_throttle').insert({ ip, line_user_id: userId, total: orderTotal })

  // ⑦ 寫入訂單（繞過 RLS；價格防護觸發器仍會在 INSERT 前重算覆寫金額）
  const { data, error } = await db.from('orders').insert(records).select('order_no')
  if (error) {
    console.error('orders insert error：', error)
    return json({ error: 'insert_failed', message: '訂單寫入失敗（可能網路不穩），請再送一次 🙏' }, 500)
  }

  return json({ ok: true, order_nos: (data ?? []).map((r: any) => r.order_no) }, 200)
})
