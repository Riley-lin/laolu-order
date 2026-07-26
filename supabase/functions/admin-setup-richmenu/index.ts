// ============================================================
// 老滷仙 Rich Menu 一鍵建立（admin-setup-richmenu）
// 一次性管理工具：建立「客人選單」＋「老闆選單」、上傳圖、設預設、綁老闆。
//
// 做的事：
//   ① 清掉舊的 Rich Menu（重跑安全）
//   ② 建客人選單（整版一顆「我要點餐」→ 開客人點餐 LIFF）＋上傳圖 → 設為「所有人預設」
//   ③ 建老闆選單（整版一顆「店務台」→ 開老闆店務 LIFF）＋上傳圖
//      → 讀 line_admins 逐一綁到每位老闆的 LINE（老闆看到的是店務台，客人看不到）
//
// 安全：要帶正確通行碼(?key=WEBHOOK_SECRET)才動得了；token 全程只在雲端保險箱，不外流。
// 用法：部署後（Verify JWT 關）在瀏覽器開：
//   https://<專案>.supabase.co/functions/v1/admin-setup-richmenu?key=<你的WEBHOOK_SECRET>
// 跑完看到 JSON 結果即完成；之後這支函式可留著（要換圖再跑一次）或刪除。
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'

const ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN')!
const WEBHOOK_SECRET = Deno.env.get('WEBHOOK_SECRET') ?? ''
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

// 兩個 LIFF 入口（跟現有一致）
const CUSTOMER_LIFF = 'https://liff.line.me/2010753920-y35aYY9d'
const BOSS_LIFF = 'https://liff.line.me/2010753920-djANTSoR'
// 選單圖（已部署在客人端網站）
const IMG_BASE = 'https://laolusian.pages.dev'

const H_JSON = { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }

// 整版單顆按鈕的 Rich Menu 定義（2500x843＝精簡一列）
function menuDef(name: string, label: string, uri: string) {
  return {
    size: { width: 2500, height: 843 },
    selected: false,
    name,
    chatBarText: label,
    areas: [{ bounds: { x: 0, y: 0, width: 2500, height: 843 }, action: { type: 'uri', uri } }],
  }
}

async function createMenu(def: unknown): Promise<string> {
  const res = await fetch('https://api.line.me/v2/bot/richmenu', { method: 'POST', headers: H_JSON, body: JSON.stringify(def) })
  const data = await res.json()
  if (!res.ok) throw new Error('建立選單失敗：' + JSON.stringify(data))
  return data.richMenuId
}

async function uploadImage(richMenuId: string, imgUrl: string) {
  const imgRes = await fetch(imgUrl)
  if (!imgRes.ok) throw new Error('抓選單圖失敗：' + imgUrl + ' HTTP ' + imgRes.status)
  const bytes = new Uint8Array(await imgRes.arrayBuffer())
  const ct = (imgUrl.endsWith('.jpg') || imgUrl.endsWith('.jpeg')) ? 'image/jpeg' : 'image/png'
  const res = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': ct }, body: bytes,
  })
  if (!res.ok) throw new Error('上傳選單圖失敗：' + (await res.text()))
}

async function deleteAllMenus(): Promise<number> {
  const res = await fetch('https://api.line.me/v2/bot/richmenu/list', { headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } })
  const data = await res.json()
  const list = data.richmenus ?? []
  for (const m of list) {
    await fetch(`https://api.line.me/v2/bot/richmenu/${m.richMenuId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } })
  }
  return list.length
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const key = url.searchParams.get('key') ?? req.headers.get('x-webhook-secret') ?? ''
  if (!WEBHOOK_SECRET || key !== WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } })
  }

  const log: string[] = []
  try {
    // ① 清舊
    const removed = await deleteAllMenus()
    log.push(`清掉舊選單 ${removed} 個`)

    // ② 客人選單 → 設為所有人預設
    const custId = await createMenu(menuDef('customer-order', '🍢 我要點餐', CUSTOMER_LIFF))
    await uploadImage(custId, `${IMG_BASE}/richmenu-customer.png`)
    const defRes = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${custId}`, { method: 'POST', headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } })
    if (!defRes.ok) throw new Error('設預設選單失敗：' + (await defRes.text()))
    log.push(`客人選單建好並設為預設：${custId}`)

    // ③ 老闆選單（2×2 四格）→ 綁到每位 line_admins
    //    格子位置對應圖片：左上=即時看單 右上=菜單/售完 左下=店務設定 右下=客人點餐頁
    const bossDef = {
      size: { width: 2500, height: 1686 },
      selected: false,
      name: 'boss-console',
      chatBarText: '🧑‍🍳 店務台',
      areas: [
        { bounds: { x: 0,    y: 0,   width: 1250, height: 843 }, action: { type: 'uri', uri: BOSS_LIFF } },                    // 即時看單（預設看單列表）
        { bounds: { x: 1250, y: 0,   width: 1250, height: 843 }, action: { type: 'uri', uri: BOSS_LIFF + '?tab=menu' } },      // 菜單/售完
        { bounds: { x: 0,    y: 843, width: 1250, height: 843 }, action: { type: 'uri', uri: BOSS_LIFF + '?tab=settings' } },  // 店務設定
        { bounds: { x: 1250, y: 843, width: 1250, height: 843 }, action: { type: 'uri', uri: CUSTOMER_LIFF } },               // 客人點餐頁（老闆自己下單/預覽）
      ],
    }
    const bossId = await createMenu(bossDef)
    await uploadImage(bossId, `${IMG_BASE}/richmenu-boss.jpg`)   // JPEG 壓過(PNG 太大超過 LINE 1MB 上限)
    log.push(`老闆選單(4格)建好：${bossId}`)

    const { data: admins } = await db.from('line_admins').select('line_user_id')
    let linked = 0
    for (const a of admins ?? []) {
      const r = await fetch(`https://api.line.me/v2/bot/user/${a.line_user_id}/richmenu/${bossId}`, { method: 'POST', headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` } })
      if (r.ok) linked++
      else log.push(`綁老闆 ${a.line_user_id} 失敗：${await r.text()}`)
    }
    log.push(`老闆選單已綁定 ${linked}/${(admins ?? []).length} 位老闆`)

    return new Response(JSON.stringify({ ok: true, log }, null, 2), { headers: { 'content-type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e), log }, null, 2), { status: 500, headers: { 'content-type': 'application/json' } })
  }
})
