'use strict';
// BIM - servidor sem dependências externas (só módulos nativos do Node).
// Tempo real via Server-Sent Events (SSE).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.json');

// ---------- Banco de dados (arquivo JSON) ----------
let db = { users: {}, offline: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
db.users = db.users || {};
db.offline = db.offline || {};

let salvando = false;
function salvar() {
  if (salvando) return;
  salvando = true;
  setTimeout(() => {
    salvando = false;
    fs.writeFile(DB_FILE, JSON.stringify(db), () => {});
  }, 300);
}

// ---------- Estado em memória ----------
const sessions = new Map();   // token -> chave (nome minúsculo)
const online = new Map();     // chave -> { clients:Set<res>, away:string }
const tentativas = new Map(); // ip -> timestamps (login/cadastro)
const envios = new Map();     // chave -> timestamps (mensagens)

function limite(mapa, id, max, janelaMs) {
  const agora = Date.now();
  const lista = (mapa.get(id) || []).filter(t => agora - t < janelaMs);
  lista.push(agora);
  mapa.set(id, lista);
  return lista.length > max;
}

function hashSenha(senha, salt) {
  return crypto.scryptSync(senha, salt, 64).toString('hex');
}
function criarSessao(chave) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, chave);
  return token;
}

// ---------- Utilidades ----------
function responder(res, codigo, obj) {
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function lerCorpo(req) {
  return new Promise((ok, erro) => {
    let dados = '';
    req.on('data', c => {
      dados += c;
      if (dados.length > 10000) { erro(new Error('grande')); req.destroy(); }
    });
    req.on('end', () => { try { ok(JSON.parse(dados || '{}')); } catch (e) { erro(e); } });
    req.on('error', erro);
  });
}
function evento(res, tipo, dados) {
  res.write('event: ' + tipo + '\ndata: ' + JSON.stringify(dados) + '\n\n');
}
function empurrar(chave, tipo, dados) {
  const o = online.get(chave);
  if (o) o.clients.forEach(r => evento(r, tipo, dados));
}
function statusDe(nome) {
  const chave = nome.toLowerCase();
  const u = db.users[chave];
  const o = online.get(chave);
  return { name: u ? u.name : nome, online: !!o, away: o ? o.away : '' };
}
function avisarPresenca(chave) {
  const st = statusDe(db.users[chave].name);
  for (const [k] of online) {
    const u = db.users[k];
    if (u && u.buddies.some(b => b.toLowerCase() === chave)) empurrar(k, 'presence', st);
  }
}

// ---------- Arquivos estáticos ----------
const ESTATICOS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/script.js': ['script.js', 'application/javascript; charset=utf-8']
};

// ---------- Servidor ----------
const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  res.setHeader('X-Content-Type-Options', 'nosniff');

  try {
    // Arquivos do site
    if (req.method === 'GET' && ESTATICOS[url.pathname]) {
      const [arq, tipo] = ESTATICOS[url.pathname];
      return fs.readFile(path.join(__dirname, arq), (e, buf) => {
        if (e) { res.writeHead(404); return res.end('Arquivo não encontrado'); }
        res.writeHead(200, { 'Content-Type': tipo });
        res.end(buf);
      });
    }

    // Fluxo em tempo real
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      const chave = sessions.get(url.searchParams.get('token'));
      if (!chave || !db.users[chave]) { res.writeHead(401); return res.end(); }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      let o = online.get(chave);
      const primeira = !o;
      if (!o) { o = { clients: new Set(), away: '' }; online.set(chave, o); }
      o.clients.add(res);
      const u = db.users[chave];
      evento(res, 'init', {
        me: u.name,
        buddies: u.buddies.map(statusDe),
        offline: db.offline[chave] || []
      });
      delete db.offline[chave];
      salvar();
      if (primeira) avisarPresenca(chave);
      const ka = setInterval(() => res.write(': ka\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ka);
        o.clients.delete(res);
        if (!o.clients.size && online.get(chave) === o) {
          online.delete(chave);
          avisarPresenca(chave);
        }
      });
      return;
    }

    if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) {
      res.writeHead(404); return res.end('Não encontrado');
    }

    const b = await lerCorpo(req);

    // Cadastro
    if (url.pathname === '/api/register') {
      if (limite(tentativas, ip, 10, 60000)) return responder(res, 429, { erro: 'Muitas tentativas. Aguarde um minuto.' });
      const nome = String(b.user || '').trim();
      const senha = String(b.pass || '');
      if (!/^[A-Za-z0-9_]{3,16}$/.test(nome)) return responder(res, 400, { erro: 'Nome: 3 a 16 letras, números ou _.' });
      if (senha.length < 6 || senha.length > 64) return responder(res, 400, { erro: 'A senha precisa ter de 6 a 64 caracteres.' });
      const chave = nome.toLowerCase();
      if (db.users[chave]) return responder(res, 409, { erro: 'Esse nome já está em uso.' });
      const salt = crypto.randomBytes(16).toString('hex');
      db.users[chave] = { name: nome, salt, hash: hashSenha(senha, salt), buddies: [], created: Date.now() };
      salvar();
      return responder(res, 200, { token: criarSessao(chave) });
    }

    // Login
    if (url.pathname === '/api/login') {
      if (limite(tentativas, ip, 10, 60000)) return responder(res, 429, { erro: 'Muitas tentativas. Aguarde um minuto.' });
      const chave = String(b.user || '').trim().toLowerCase();
      const u = db.users[chave];
      const senha = String(b.pass || '');
      if (!u) return responder(res, 401, { erro: 'Nome ou senha incorretos.' });
      const a = Buffer.from(hashSenha(senha, u.salt), 'hex');
      const c = Buffer.from(u.hash, 'hex');
      if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return responder(res, 401, { erro: 'Nome ou senha incorretos.' });
      return responder(res, 200, { token: criarSessao(chave) });
    }

    // Rotas autenticadas
    const chave = sessions.get(req.headers['x-token']);
    if (!chave || !db.users[chave]) return responder(res, 401, { erro: 'Sessão expirada.' });
    const eu = db.users[chave];

    if (url.pathname === '/api/send') {
      if (limite(envios, chave, 20, 10000)) return responder(res, 429, { erro: 'Calma! Você está enviando rápido demais.' });
      const texto = String(b.text || '').trim().slice(0, 500);
      if (!texto) return responder(res, 400, { erro: 'Mensagem vazia.' });
      const paraChave = String(b.to || '').toLowerCase();
      const dest = db.users[paraChave];
      if (!dest) return responder(res, 404, { erro: 'Usuário não encontrado.' });
      if (paraChave === chave) return responder(res, 400, { erro: 'Você não pode enviar para si mesmo.' });
      const f = b.fmt || {};
      const msg = { from: eu.name, text: texto, fmt: { b: !!f.b, i: !!f.i, u: !!f.u }, t: Date.now() };
      const o = online.get(paraChave);
      if (o) {
        empurrar(paraChave, 'msg', msg);
        return responder(res, 200, { ok: true, away: o.away });
      }
      const fila = db.offline[paraChave] = db.offline[paraChave] || [];
      fila.push(msg);
      if (fila.length > 50) fila.shift();
      salvar();
      return responder(res, 200, { ok: true, offline: true });
    }

    if (url.pathname === '/api/buddy') {
      const alvo = String(b.name || '').trim();
      const alvoChave = alvo.toLowerCase();
      if (b.action === 'remove') {
        eu.buddies = eu.buddies.filter(x => x.toLowerCase() !== alvoChave);
        salvar();
        return responder(res, 200, { ok: true });
      }
      const dest = db.users[alvoChave];
      if (!dest) return responder(res, 404, { erro: 'Usuário não encontrado.' });
      if (alvoChave === chave) return responder(res, 400, { erro: 'Você não pode adicionar a si mesmo.' });
      if (eu.buddies.length >= 100) return responder(res, 400, { erro: 'Limite de 100 amigos.' });
      if (!eu.buddies.some(x => x.toLowerCase() === alvoChave)) { eu.buddies.push(dest.name); salvar(); }
      return responder(res, 200, { buddy: statusDe(dest.name) });
    }

    if (url.pathname === '/api/status') {
      const o = online.get(chave);
      if (o) { o.away = String(b.away || '').slice(0, 100); avisarPresenca(chave); }
      return responder(res, 200, { ok: true });
    }

    if (url.pathname === '/api/logout') {
      sessions.delete(req.headers['x-token']);
      return responder(res, 200, { ok: true });
    }

    responder(res, 404, { erro: 'Rota desconhecida.' });
  } catch (e) {
    if (!res.headersSent) responder(res, 400, { erro: 'Requisição inválida.' });
  }
});

servidor.listen(PORT, () => {
  console.log('BIM rodando em http://localhost:' + PORT);
});
