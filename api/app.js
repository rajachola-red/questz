import crypto from 'node:crypto';
import { Redis } from '@upstash/redis';
import { put, get } from '@vercel/blob';

// Find the Redis REST settings under any name/prefix Vercel's integration may have used
const E = process.env;
const pick = re => Object.keys(E).find(k => re.test(k));
const url = E[pick(/REST_(API_)?URL$/)], token = E[pick(/REST_(API_)?TOKEN$/)];
const r = url && token ? new Redis({ url, token }) : null;
const J = (d, s = 200) => Response.json(d, { status: s });
const W = () => Math.floor((Date.now() / 864e5 + 3) / 7); // week number, Monday start

// Verify the signed Telegram initData sent by the Mini App
function auth(req) {
  const p = new URLSearchParams((req.headers.get('authorization') || '').replace(/^tma /, ''));
  const hash = p.get('hash');
  p.delete('hash');
  const check = [...p].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN || '').digest();
  const good = crypto.createHmac('sha256', key).update(check).digest('hex');
  if (!hash || hash.length !== good.length || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(good))) return null;
  if (Date.now() / 1000 - p.get('auth_date') > 86400) return null;
  const u = JSON.parse(p.get('user'));
  return { id: String(u.id), name: u.username ? '@' + u.username : u.first_name || 'Anon' };
}

async function top(k) {
  const a = await r.zrange(k, 0, 19, { rev: true, withScores: true });
  const ids = a.filter((_, i) => i % 2 === 0).map(String);
  const names = ids.length ? await r.hmget('names', ...ids) : {};
  return ids.map((id, i) => ({ n: names?.[id] || 'Anon', s: a[i * 2 + 1] }));
}

async function run(req) {
  if (!r) return J({ error: 'Redis is not connected to this deployment. Connect Upstash Redis to the project, then redeploy.' }, 500);
  const u = new URL(req.url), d = u.searchParams.get('do');
  if (d === 'board') return J({ all: await top('lb'), wk: await top('wk:' + W()) });

  const me = auth(req);
  if (!me) return J({ error: 'Session expired. Please reopen the app from Telegram.' }, 401);
  const { id, name } = me;
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  if (d === 'me') {
    await r.hset('names', { [id]: name });
    const [mission, archive] = await Promise.all([r.hget('cur', id), r.lrange('arc:' + id, 0, 99)]);
    return J({ name, mission, archive });
  }
  if (d === 'accept') {
    const m = String(body.mission || '').slice(0, 300);
    if (!m) return J({ error: 'Empty mission' }, 400);
    await r.hset('cur', { [id]: m });
    return J({ ok: 1 });
  }
  if (d === 'quit') {
    await r.hdel('cur', id);
    return J({ ok: 1 });
  }
  if (d === 'done') {
    const m = await r.hget('cur', id);
    if (!m || !(await r.hdel('cur', id))) return J({ error: 'No active mission' }, 400);
    let p = null;
    if (body.photo) {
      const b = Buffer.from(String(body.photo).split(',')[1] || '', 'base64');
      if (b.length > 600e3) return J({ error: 'Photo too large' }, 413);
      p = (await put(`${id}/photo.jpg`, b, { access: 'private', contentType: 'image/jpeg', addRandomSuffix: true })).pathname;
    }
    const k = 'wk:' + W();
    await Promise.all([
      r.hset('names', { [id]: name }),
      r.lpush('arc:' + id, { t: String(m), d: Date.now(), p }),
      r.zincrby('lb', 1, id),
      r.zincrby(k, 1, id),
      r.expire(k, 1209600),
    ]);
    return J({ ok: 1 });
  }
  if (d === 'photo') {
    const p = u.searchParams.get('p') || '';
    if (!p.startsWith(id + '/') || p.includes('..')) return J({ error: 'Forbidden' }, 403);
    const f = await get(p, { access: 'private' });
    if (!f?.stream) return J({ error: 'Not found' }, 404);
    return new Response(f.stream, { headers: { 'content-type': f.blob.contentType, 'cache-control': 'private, max-age=3600' } });
  }
  return J({ error: 'Bad request' }, 400);
}

async function h(req) {
  try { return await run(req); } catch (e) { return J({ error: 'Server error: ' + e.message }, 500); }
}

export const GET = h, POST = h;
