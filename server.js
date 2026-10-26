// Запуск: MONGODB_URI="mongodb+srv://..." node server.js
// Дані (новини, фігуранти, доноси, адмін-сесії) зберігаються в MongoDB і не зникають при перезапуску.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { MongoClient } = require('mongodb');

const URI = process.env.MONGODB_URI;
if (!URI) {
  console.error('ПОМИЛКА: не задано змінну середовища MONGODB_URI (рядок підключення до MongoDB).');
  process.exit(1);
}
const PORT = process.env.PORT || 3000, LIM = 3e6;
const NEWS_DELETE_ADMIN_ONLY = /^(1|true|yes)$/i.test(process.env.NEWS_DELETE_ADMIN_ONLY || '');

// ---------- Адміни (облікові записи лише тут, у браузер не потрапляють) ----------
const ADMINS = {
  'Shadow_Observer_00': 'NullPointer666',
  'Archivist_Void': 'WhisperOfYaniv',
  'Agent_Semenivna_X': 'KvasoKorova2010',
  'Phantom_Protocol_9': 'TysaDeepSwimmer',
  'Grim_Registrar': 'BlackListZubovych'
};

// ---------- Утиліти ----------
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' };
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...cors }); res.end(JSON.stringify(obj)); };
const clip = (s, n) => String(s || '').slice(0, n);
const sha = x => crypto.createHash('sha256').update(String(x)).digest();
const eq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const types = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const kyiv = () => new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
const NOID = { projection: { _id: 0, createdAt: 0 } };
const hits = { dn: new Map(), news: new Map(), fails: new Map() };
setInterval(() => Object.values(hits).forEach(m => m.clear()), 6e5).unref();
const tooMany = (map, ip, max) => { const n = (map.get(ip) || 0) + 1; map.set(ip, n); return n > max; };
const limitOf = (qs, def, max) => Math.min(max, Math.max(1, parseInt(new URLSearchParams(qs || '').get('limit'), 10) || def));
const imgOk = im => /^https?:\/\//i.test(im) || /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+\/=]+$/.test(im);

function readJson(req) {
  return new Promise((resolve, reject) => {
    let b = '', big = false;
    req.on('data', c => { if (big) return; b += c; if (b.length > LIM) { big = true; b = ''; } });
    req.on('end', () => { if (big) return reject(new HttpError(413, 'Завеликий запит')); try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(new HttpError(400, 'Некоректні дані')); } });
    req.on('error', reject);
  });
}

// ---------- MongoDB ----------
const C = {};
async function initDb() {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'mirotvorets');
  C.news = db.collection('news'); C.figures = db.collection('figures'); C.builtin = db.collection('builtin_figures');
  C.dns = db.collection('denunciations'); C.sessions = db.collection('sessions');
  await Promise.all([
    C.news.createIndex({ id: 1 }, { unique: true }), C.news.createIndex({ createdAt: -1 }),
    C.figures.createIndex({ id: 1 }, { unique: true }), C.builtin.createIndex({ id: 1 }, { unique: true }),
    C.dns.createIndex({ id: 1 }, { unique: true }), C.dns.createIndex({ createdAt: -1 }),
    C.sessions.createIndex({ token: 1 }, { unique: true }), C.sessions.createIndex({ exp: 1 }, { expireAfterSeconds: 0 })
  ]);
  await migrate();
  console.log('MongoDB підключено');
}

// Одноразовий імпорт зі старих JSON-файлів (лише якщо колекція порожня, а файл існує)
async function migrate() {
  const rd = f => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')); } catch (e) { return null; } };
  const back = (arr, i) => new Date(Date.now() - (arr.length - i) * 1000);
  try {
    if (!(await C.news.countDocuments({}))) { const a = rd('news.json');
      if (Array.isArray(a) && a.length) await C.news.insertMany(a.map((n, i) => ({ ...n, likes: n.likes || 0, createdAt: new Date(Date.now() - i * 1000) })), { ordered: false }); }
    if (!(await C.dns.countDocuments({}))) { const a = rd('denunciations.json');
      if (Array.isArray(a) && a.length) await C.dns.insertMany(a.map((n, i) => ({ ...n, createdAt: new Date(Date.now() - i * 1000) })), { ordered: false }); }
    if (!(await C.figures.countDocuments({})) && !(await C.builtin.countDocuments({}))) { const f = rd('figures.json');
      if (f) {
        if (Array.isArray(f.custom) && f.custom.length) await C.figures.insertMany(f.custom.map((x, i) => ({ ...x, createdAt: back(f.custom, i) })), { ordered: false });
        for (const [id, o] of Object.entries(f.overrides || {})) await C.builtin.updateOne({ id }, { $set: { override: o, hidden: false } }, { upsert: true });
        for (const id of f.hidden || []) await C.builtin.updateOne({ id: String(id) }, { $set: { hidden: true, override: null } }, { upsert: true });
      } }
  } catch (e) { console.error('Міграція зі старих файлів пропущена:', e.message); }
}

// ---------- Авторизація (сесії в MongoDB, переживають перезапуск) ----------
async function auth(req) {
  const m = /^Bearer (\w+)$/.exec(req.headers.authorization || ''); if (!m) return null;
  const s = await C.sessions.findOne({ token: sha(m[1]).toString('hex'), exp: { $gt: new Date() } });
  return s ? { token: m[1], name: s.name } : null;
}
const needAuth = async req => { const a = await auth(req); if (!a) throw new HttpError(401, 'Потрібна авторизація'); return a; };

// ---------- Фігуранти ----------
const COLORS = ['red', 'yellow', 'orange', 'green', 'purple'], RINGS = ['normal', 'red', 'green', 'yellow', 'purple'];
function cleanFig(d) {
  const name = clip(d.name, 120).trim(), dossier = clip(d.dossier, 1500).trim(), badge = clip(d.badge, 80).trim().toUpperCase();
  if (!name || !dossier || !badge) throw new HttpError(400, 'Заповніть ПІБ, плашку та досьє');
  const im = String(d.img || '');
  const img = (imgOk(im) || /^[\w.-]+\.(jpe?g|png|webp)$/i.test(im)) ? im.slice(0, 2e6) : '';
  const meters = (Array.isArray(d.meters) ? d.meters : []).slice(0, 4)
    .map(m => [clip(m && m[0], 60).trim(), Math.max(0, Math.min(100, Math.round(Number(m && m[1]) || 0))), clip(m && m[2], 60).trim()]).filter(m => m[0]);
  return { name, dob: clip(d.dob, 40).trim() || null, img, badge, color: COLORS.includes(d.color) ? d.color : 'red',
    ring: RINGS.includes(d.ring) ? d.ring : 'normal', dossier, meters };
}

// ---------- Маршрути API ----------
async function api(req, res, u, qs) {
  const id = u.split('/')[3], M = req.method, ip = req.socket.remoteAddress;

  // --- вхід / вихід ---
  if (u === '/api/login' && M === 'POST') {
    if ((hits.fails.get(ip) || 0) >= 5) throw new HttpError(429, 'Забагато спроб. Зачекайте хвилину.');
    const d = await readJson(req), l = String(d.login || ''), pw = String(d.password || '');
    const name = Object.keys(ADMINS).find(k => eq(k, l) && eq(ADMINS[k], pw));
    if (!name) { hits.fails.set(ip, (hits.fails.get(ip) || 0) + 1); setTimeout(() => hits.fails.delete(ip), 6e4).unref(); throw new HttpError(401, 'Невірний логін або пароль'); }
    hits.fails.delete(ip);
    const token = crypto.randomBytes(24).toString('hex');
    await C.sessions.insertOne({ token: sha(token).toString('hex'), name, exp: new Date(Date.now() + 7 * 864e5) });
    return send(res, 200, { token, name });
  }
  if (u === '/api/logout' && M === 'POST') {
    const a = await auth(req); if (a) await C.sessions.deleteOne({ token: sha(a.token).toString('hex') });
    return send(res, 200, { ok: true });
  }

  // --- новини ---
  if (u === '/api/news' || u.startsWith('/api/news/')) {
    if (M === 'GET' && !id) return send(res, 200, await C.news.find({}, NOID).sort({ createdAt: -1 }).limit(limitOf(qs, 100, 300)).toArray());
    if (M === 'POST' && !id) {
      if (tooMany(hits.news, ip, 20)) throw new HttpError(429, 'Забагато новин. Зачекайте кілька хвилин.');
      const d = await readJson(req), title = clip(d.title, 140).trim(), text = clip(d.text, 2000).trim();
      if (!title || !text) throw new HttpError(400, 'Порожній заголовок або текст');
      const im = String(d.img || '');
      const item = { id: Date.now() * 1000 + Math.floor(Math.random() * 1000), title, text, author: clip(d.author, 40).trim() || 'Анонім',
        img: imgOk(im) ? im.slice(0, 2e6) : '', date: kyiv(), likes: 0 };
      await C.news.insertOne({ ...item, createdAt: new Date() });
      return send(res, 201, item);
    }
    const nid = Number(id);
    if (id && !Number.isFinite(nid)) throw new HttpError(404, 'Не знайдено');
    if (M === 'POST' && id) {                                   // /api/news/:id/like
      const d = await readJson(req);
      if (d.delta > 0) await C.news.updateOne({ id: nid }, { $inc: { likes: 1 } });
      else await C.news.updateOne({ id: nid, likes: { $gt: 0 } }, { $inc: { likes: -1 } });
      const n = await C.news.findOne({ id: nid }, NOID); if (!n) throw new HttpError(404, 'Не знайдено');
      return send(res, 200, n);
    }
    if (M === 'DELETE' && id) {
      if (NEWS_DELETE_ADMIN_ONLY) await needAuth(req);
      await C.news.deleteOne({ id: nid }); return send(res, 200, { ok: true });
    }
    throw new HttpError(405, 'method');
  }

  // --- фігуранти ---
  if (u === '/api/figures' || u.startsWith('/api/figures/')) {
    if (M === 'GET' && !id) {
      const custom = await C.figures.find({}, NOID).sort({ createdAt: 1 }).toArray(), overrides = {}, hidden = [];
      for (const b of await C.builtin.find({}, { projection: { _id: 0 } }).toArray()) { if (b.override) overrides[b.id] = b.override; if (b.hidden) hidden.push(b.id); }
      return send(res, 200, { custom, overrides, hidden });
    }
    const a = await needAuth(req);
    if (M === 'POST' && !id) {
      const f = cleanFig(await readJson(req));
      const item = { id: 'c' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), ...f, cat: 'custom', by: a.name };
      await C.figures.insertOne({ ...item, createdAt: new Date() }); return send(res, 201, item);
    }
    if (M === 'PUT' && id) {
      const f = cleanFig(await readJson(req));
      if (/^c[a-z0-9]+$/.test(id)) { if (!(await C.figures.updateOne({ id }, { $set: f })).matchedCount) throw new HttpError(404, 'Не знайдено'); }
      else if (/^\d+$/.test(id)) await C.builtin.updateOne({ id }, { $set: { override: f, hidden: false } }, { upsert: true });
      else throw new HttpError(404, 'Не знайдено');
      return send(res, 200, { ok: true });
    }
    if (M === 'DELETE' && id) {
      if (/^c[a-z0-9]+$/.test(id)) await C.figures.deleteOne({ id });
      else if (/^\d+$/.test(id)) await C.builtin.updateOne({ id }, { $set: { hidden: true, override: null } }, { upsert: true });
      else throw new HttpError(404, 'Не знайдено');
      return send(res, 200, { ok: true });
    }
    throw new HttpError(405, 'method');
  }

  // --- анонімні доноси (надсилати може кожен, читати й керувати — лише адміни) ---
  if (u === '/api/denunciations' || u.startsWith('/api/denunciations/')) {
    if (M === 'POST' && !id) {
      if (tooMany(hits.dn, ip, 5)) throw new HttpError(429, 'Забагато доносів. Зачекайте кілька хвилин.');
      const d = await readJson(req), who = clip(d.who, 120).trim(), text = clip(d.text, 2000).trim(), im = String(d.img || '');
      if (!who || !text) throw new HttpError(400, 'Вкажіть, на кого донос, та опишіть порушення.');
      if (im.length > 2.5e6) throw new HttpError(413, 'Фото завелике.');
      if (im && !/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+\/=]+$/.test(im)) throw new HttpError(400, 'Фото має бути зображенням (JPEG, PNG, WebP або GIF).');
      const now = new Date();
      await C.dns.insertOne({ id: now.getTime().toString(36) + crypto.randomBytes(3).toString('hex'), who, text, img: im, date: now.toISOString(), archived: false, createdAt: now });
      return send(res, 201, { ok: true });
    }
    await needAuth(req);
    if (M === 'GET' && !id) return send(res, 200, await C.dns.find({}, NOID).sort({ createdAt: -1 }).limit(limitOf(qs, 300, 500)).toArray());
    if (M === 'PUT' && id) {
      const d = await readJson(req);
      if (!(await C.dns.updateOne({ id }, { $set: { archived: !!d.archived } })).matchedCount) throw new HttpError(404, 'Не знайдено');
      return send(res, 200, await C.dns.findOne({ id }, NOID));
    }
    if (M === 'DELETE' && id) {
      if (!(await C.dns.deleteOne({ id })).deletedCount) throw new HttpError(404, 'Не знайдено');
      return send(res, 200, { ok: true });
    }
    throw new HttpError(405, 'method');
  }
  throw new HttpError(404, 'Не знайдено');
}

// ---------- HTTP-сервер ----------
const server = http.createServer(async (req, res) => {
  const [u, qs] = req.url.split('?');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (u === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (u.startsWith('/api/')) {
    try { await api(req, res, u, qs); }
    catch (e) {
      if (res.headersSent) return;
      if (e instanceof HttpError) return send(res, e.code, { error: e.message });
      console.error(e); send(res, 500, { error: 'Помилка бази даних. Спробуйте пізніше.' });
    }
    return;
  }
  let f; try { f = path.basename(u === '/' ? 'index.html' : decodeURIComponent(u)); } catch (e) { res.writeHead(400); return res.end(); }
  const t = types[path.extname(f).toLowerCase()];
  if (!t) { res.writeHead(404); return res.end('404'); }
  fs.readFile(path.join(__dirname, f), (e, data) => {
    if (e) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': t }); res.end(data);
  });
});

initDb().then(() => server.listen(PORT, () => console.log('Сайт: http://localhost:' + PORT)))
  .catch(e => { console.error('Не вдалося підключитися до MongoDB:', e.message); process.exit(1); });
