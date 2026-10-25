// Запуск: node server.js  (потрібен лише Node.js 16+, без npm install)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, FILE = path.join(__dirname, 'news.json'), MAX = 200, LIM = 3e6;
let news = []; try { news = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
const save = () => fs.writeFile(FILE + '.tmp', JSON.stringify(news), e => { if (!e) fs.rename(FILE + '.tmp', FILE, () => {}); });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' };
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...cors }); res.end(JSON.stringify(obj)); };
const clip = (s, n) => String(s || '').slice(0, n);
const types = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

// ================= АДМІНИ ТА ФІГУРАНТИ =================
// Облікові записи зберігаються ТІЛЬКИ тут, у браузер вони не потрапляють.
const ADMINS = {
  'Shadow_Observer_00': 'NullPointer666',
  'Archivist_Void': 'WhisperOfYaniv',
  'Agent_Semenivna_X': 'KvasoKorova2010',
  'Phantom_Protocol_9': 'TysaDeepSwimmer',
  'Grim_Registrar': 'BlackListZubovych'
};
const FIG_FILE = path.join(__dirname, 'figures.json');
let figs = { custom: [], overrides: {}, hidden: [] };
try { const j = JSON.parse(fs.readFileSync(FIG_FILE, 'utf8')); figs = { custom: j.custom || [], overrides: j.overrides || {}, hidden: j.hidden || [] }; } catch (e) {}
const saveFigs = () => fs.writeFile(FIG_FILE + '.tmp', JSON.stringify(figs), e => { if (!e) fs.rename(FIG_FILE + '.tmp', FIG_FILE, () => {}); });
const sessions = new Map(), fails = new Map();
const h256 = x => crypto.createHash('sha256').update(String(x)).digest();
const eq = (a, b) => crypto.timingSafeEqual(h256(a), h256(b));
const auth = req => { const m = /^Bearer (\w+)$/.exec(req.headers.authorization || ''); const s = m && sessions.get(m[1]);
  return s && s.exp > Date.now() ? { token: m[1], name: s.name } : null; };
function readJson(req, res, cb) {
  let b = '', big = false;
  req.on('data', c => { b += c; if (b.length > LIM) { big = true; req.destroy(); } });
  req.on('end', () => { if (big) return; let d; try { d = JSON.parse(b || '{}'); } catch (e) { return send(res, 400, { error: 'Некоректні дані' }); } cb(d); });
}
const COLORS = ['red', 'yellow', 'orange', 'green', 'purple'], RINGS = ['normal', 'red', 'green', 'yellow', 'purple'];
function cleanFig(d) {
  const name = clip(d.name, 120).trim(), dossier = clip(d.dossier, 1500).trim(), badge = clip(d.badge, 80).trim().toUpperCase();
  if (!name || !dossier || !badge) return null;
  const im = String(d.img || '');
  const img = (/^(https?:\/\/|data:image\/)/i.test(im) || /^[\w.-]+\.(jpe?g|png|webp)$/i.test(im)) ? im.slice(0, 2e6) : '';
  const meters = (Array.isArray(d.meters) ? d.meters : []).slice(0, 4)
    .map(m => [clip(m && m[0], 60).trim(), Math.max(0, Math.min(100, Math.round(Number(m && m[1]) || 0))), clip(m && m[2], 60).trim()]).filter(m => m[0]);
  return { name, dob: clip(d.dob, 40).trim() || null, img, badge, color: COLORS.includes(d.color) ? d.color : 'red',
    ring: RINGS.includes(d.ring) ? d.ring : 'normal', dossier, meters };
}
// ---- Анонімні доноси (надсилати може кожен, читати й керувати — лише адміни) ----
const DN_FILE = path.join(__dirname, 'denunciations.json');
let dns = []; try { dns = JSON.parse(fs.readFileSync(DN_FILE, 'utf8')); if (!Array.isArray(dns)) dns = []; } catch (e) {}
const saveDns = () => fs.writeFile(DN_FILE + '.tmp', JSON.stringify(dns), e => { if (!e) fs.rename(DN_FILE + '.tmp', DN_FILE, () => {}); });
const dnHits = new Map();

function handleAdmin(req, res, u) {
  if (u === '/api/denunciations' || u.startsWith('/api/denunciations/')) {
    const id = u.split('/')[3];
    if (req.method === 'POST' && !id) {
      const ip = req.socket.remoteAddress, now = Date.now(), hits = (dnHits.get(ip) || []).filter(t => now - t < 6e5);
      if (hits.length >= 5) { send(res, 429, { error: 'Забагато доносів. Зачекайте кілька хвилин.' }); return true; }
      readJson(req, res, d => {
        const who = clip(d.who, 120).trim(), text = clip(d.text, 2000).trim(), im = String(d.img || '');
        if (!who || !text) return send(res, 400, { error: 'Вкажіть, на кого донос, та опишіть порушення.' });
        if (im.length > 2.5e6) return send(res, 413, { error: 'Фото завелике.' });
        if (im && !/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+\/=]+$/.test(im)) return send(res, 400, { error: 'Фото має бути зображенням (JPEG, PNG, WebP або GIF).' });
        hits.push(now); dnHits.set(ip, hits);
        dns.unshift({ id: now.toString(36) + crypto.randomBytes(3).toString('hex'), who, text, img: im, date: new Date().toISOString(), archived: false });
        dns = dns.slice(0, 500); saveDns(); send(res, 201, { ok: true });
      });
      return true;
    }
    if (!auth(req)) { send(res, 401, { error: 'Потрібна авторизація' }); return true; }
    if (req.method === 'GET' && !id) { send(res, 200, dns); return true; }
    const it = id && dns.find(x => x.id === id);
    if (req.method === 'PUT' && id) {
      if (!it) { send(res, 404, { error: 'Не знайдено' }); return true; }
      readJson(req, res, d => { it.archived = !!d.archived; saveDns(); send(res, 200, it); });
      return true;
    }
    if (req.method === 'DELETE' && id) {
      if (!it) { send(res, 404, { error: 'Не знайдено' }); return true; }
      dns = dns.filter(x => x.id !== id); saveDns(); send(res, 200, { ok: true }); return true;
    }
    send(res, 405, { error: 'method' }); return true;
  }
  if (u === '/api/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress, f = fails.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - f.t > 6e4) { f.n = 0; f.t = Date.now(); }
    if (f.n >= 5) { send(res, 429, { error: 'Забагато спроб. Зачекайте хвилину.' }); return true; }
    readJson(req, res, d => {
      const l = String(d.login || ''), pw = String(d.password || '');
      const name = Object.keys(ADMINS).find(k => eq(k, l) && eq(ADMINS[k], pw));
      if (!name) { f.n++; fails.set(ip, f); return send(res, 401, { error: 'Невірний логін або пароль' }); }
      fails.delete(ip);
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, { name, exp: Date.now() + 7 * 864e5 });
      send(res, 200, { token, name });
    });
    return true;
  }
  if (u === '/api/logout' && req.method === 'POST') { const a = auth(req); if (a) sessions.delete(a.token); send(res, 200, { ok: true }); return true; }
  if (u === '/api/figures' || u.startsWith('/api/figures/')) {
    const id = u.split('/')[3];
    if (req.method === 'GET' && !id) { send(res, 200, figs); return true; }
    const a = auth(req);
    if (!a) { send(res, 401, { error: 'Потрібна авторизація' }); return true; }
    if (req.method === 'POST' && !id) {
      readJson(req, res, d => {
        const f = cleanFig(d); if (!f) return send(res, 400, { error: 'Заповніть ПІБ, плашку та досьє' });
        const item = { id: 'c' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), ...f, cat: 'custom', by: a.name };
        figs.custom.push(item); saveFigs(); send(res, 201, item);
      });
      return true;
    }
    if (req.method === 'PUT' && id) {
      readJson(req, res, d => {
        const f = cleanFig(d); if (!f) return send(res, 400, { error: 'Заповніть ПІБ, плашку та досьє' });
        const i = figs.custom.findIndex(x => x.id === id);
        if (i > -1) figs.custom[i] = { ...figs.custom[i], ...f };
        else if (/^\d+$/.test(id)) { figs.overrides[id] = f; figs.hidden = figs.hidden.filter(x => x !== id); }
        else return send(res, 404, { error: 'Не знайдено' });
        saveFigs(); send(res, 200, { ok: true });
      });
      return true;
    }
    if (req.method === 'DELETE' && id) {
      const i = figs.custom.findIndex(x => x.id === id);
      if (i > -1) figs.custom.splice(i, 1);
      else if (/^\d+$/.test(id)) { if (!figs.hidden.includes(id)) figs.hidden.push(id); delete figs.overrides[id]; }
      else { send(res, 404, { error: 'Не знайдено' }); return true; }
      saveFigs(); send(res, 200, { ok: true }); return true;
    }
    send(res, 405, { error: 'method' }); return true;
  }
  return false;
}

http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (handleAdmin(req, res, u)) return;
  if (u === '/api/news' || u.startsWith('/api/news/')) {
    const id = u.split('/')[3];
    if (req.method === 'GET' && !id) return send(res, 200, news);
    if (req.method === 'DELETE' && id) { news = news.filter(n => String(n.id) !== id); save(); return send(res, 200, { ok: true }); }
    if (req.method === 'POST') {
      let b = '', big = false;
      req.on('data', c => { b += c; if (b.length > LIM) { big = true; req.destroy(); } });
      req.on('end', () => {
        if (big) return;
        let d; try { d = JSON.parse(b); } catch (e) { return send(res, 400, { error: 'json' }); }
        if (id) { // /api/news/:id/like
          const n = news.find(x => String(x.id) === id); if (!n) return send(res, 404, { error: 'not found' });
          n.likes = Math.max(0, (n.likes || 0) + (d.delta > 0 ? 1 : -1)); save(); return send(res, 200, n);
        }
        const title = clip(d.title, 140).trim(), text = clip(d.text, 2000).trim();
        if (!title || !text) return send(res, 400, { error: 'empty' });
        const img = /^(https?:\/\/|data:image\/)/i.test(d.img || '') ? String(d.img).slice(0, 2e6) : '';
        const item = { id: Date.now() * 1000 + Math.floor(Math.random() * 1000), title, text,
          author: clip(d.author, 40).trim() || 'Анонім', img,
          date: new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }), likes: 0 };
        news.unshift(item); news = news.slice(0, MAX); save(); send(res, 201, item);
      });
      return;
    }
    return send(res, 405, { error: 'method' });
  }
  const f = path.basename(u === '/' ? 'index.html' : decodeURIComponent(u)), t = types[path.extname(f).toLowerCase()];
  if (!t) { res.writeHead(404); return res.end('404'); }
  fs.readFile(path.join(__dirname, f), (e, data) => {
    if (e) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': t }); res.end(data);
  });
}).listen(PORT, () => console.log('Сайт: http://localhost:' + PORT));
