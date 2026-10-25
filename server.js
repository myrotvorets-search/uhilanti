// Запуск: node server.js  (потрібен лише Node.js 16+, без npm install)
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000, FILE = path.join(__dirname, 'news.json'), MAX = 200, LIM = 3e6;
let news = []; try { news = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
const save = () => fs.writeFile(FILE + '.tmp', JSON.stringify(news), e => { if (!e) fs.rename(FILE + '.tmp', FILE, () => {}); });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...cors }); res.end(JSON.stringify(obj)); };
const clip = (s, n) => String(s || '').slice(0, n);
const types = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
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
