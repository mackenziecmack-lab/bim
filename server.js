'use strict';
// BIM - servidor sem dependências externas (só módulos nativos do Node).
// Tempo real via Server-Sent Events (SSE).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.json');

// Conta de administradora (a única que vê as denúncias).
const ADMIN_NOME = process.env.ADMIN_USER || 'XxCreatorxX';
const ADMIN_KEY = ADMIN_NOME.toLowerCase();
// Código secreto exigido para CRIAR a conta de administradora (defina no Render em Environment).
const CODIGO_ADMIN = process.env.CODIGO_ADMIN || '';

const TEMAS = ['azul', 'rosa', 'verde', 'vermelho', 'laranja', 'preto', 'branco'];

// ---------- Utilidades de nomes ----------
const minus = s => String(s).toLowerCase();
const tem = (lista, chave) => lista.some(x => minus(x) === chave);
const sem = (lista, chave) => lista.filter(x => minus(x) !== chave);
const ehAdmin = chave => chave === ADMIN_KEY;
const chaveConversa = (a, b) => [a, b].sort().join('|');

// ---------- Banco de dados (arquivo JSON) ----------
let db = { users: {}, offline: {}, msgs: {}, reports: [], nextReport: 1 };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
db.users = db.users || {};
db.offline = db.offline || {};
db.msgs = db.msgs || {};
db.reports = db.reports || [];
db.nextReport = db.nextReport || 1;
db.groups = db.groups || {};

function guardarMsg(deChave, paraChave, text, fmt, t) {
  const k = chaveConversa(deChave, paraChave);
  const l = db.msgs[k] = db.msgs[k] || [];
  l.push({ f: deChave, text, fmt, t });
  if (l.length > 300) l.splice(0, l.length - 300);
}

// Migração de contas/dados de versões antigas
Object.values(db.users).forEach(u => {
  u.buddies = u.buddies || [];
  u.requests = u.requests || [];
  u.blocked = u.blocked || [];
  u.bio = u.bio || '';
  u.avatar = u.avatar || '';
  u.theme = TEMAS.includes(u.theme) ? u.theme : 'azul';
});
for (const k of Object.keys(db.offline)) {
  const nomes = new Set();
  (db.offline[k] || []).forEach(m => {
    if (typeof m === 'string') return nomes.add(m);
    nomes.add(m.from);
    guardarMsg(minus(m.from), k, m.text, m.fmt, m.t);
  });
  db.offline[k] = [...nomes];
}

let salvando = false;
function salvar() {
  if (salvando) return;
  salvando = true;
  setTimeout(() => {
    salvando = false;
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), e => { if (!e) fs.rename(tmp, DB_FILE, () => {}); });
  }, 300);
}

// ---------- Estado em memória ----------
const sessions = new Map();     // token -> chave (nome minúsculo)
const online = new Map();       // chave -> { clients:Set<res>, away:string, key }
const tentativas = new Map();   // ip -> timestamps (login/cadastro)
const envios = new Map();       // chave -> timestamps (mensagens)
const denunciasRate = new Map();// chave -> timestamps (denúncias)

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
function igual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function criarSessao(chave) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, chave);
  return token;
}

// ---------- Respostas / eventos ----------
function responder(res, codigo, obj) {
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function lerCorpo(req) {
  return new Promise((ok, erro) => {
    let dados = '';
    req.on('data', c => {
      dados += c;
      if (dados.length > 60000) { erro(new Error('grande')); req.destroy(); }
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

// ---------- Perfis, listas e presença ----------
function nomeDe(chave) { return db.users[chave] ? db.users[chave].name : chave; }
function statusDe(nome) {
  const chave = minus(nome);
  const u = db.users[chave];
  const o = online.get(chave);
  return {
    name: u ? u.name : nome,
    online: !!o,
    away: o ? o.away : '',
    avatar: u ? u.avatar : '',
    bio: u ? u.bio : ''
  };
}
function listasDe(chave) {
  const u = db.users[chave];
  return { buddies: u.buddies.map(statusDe), requests: u.requests.map(statusDe), blocked: u.blocked };
}
function enviarListas(chave) {
  if (db.users[chave] && online.has(chave)) empurrar(chave, 'lists', listasDe(chave));
}
function avisarPresenca(chave) {
  const st = statusDe(db.users[chave].name);
  for (const [k] of online) {
    const u = db.users[k];
    if (u && tem(u.buddies, chave)) empurrar(k, 'presence', st);
  }
}
function grupoPublico(g) {
  return {
    id: g.id, name: g.name, dono: nomeDe(g.dono),
    members: g.members.map(k => {
      const st = statusDe(nomeDe(k));
      return { name: st.name, avatar: st.avatar, online: st.online, admin: g.admins.includes(k) };
    })
  };
}
function gruposDe(chave) {
  return Object.values(db.groups).filter(g => g.members.includes(chave)).map(grupoPublico);
}
function enviarGrupos(chave) {
  if (db.users[chave] && online.has(chave)) empurrar(chave, 'groups', gruposDe(chave));
}
function aceitar(a, b) {
  const ua = db.users[a], ub = db.users[b];
  ua.requests = sem(ua.requests, b);
  ub.requests = sem(ub.requests, a);
  if (!tem(ua.buddies, b)) ua.buddies.push(ub.name);
  if (!tem(ub.buddies, a)) ub.buddies.push(ua.name);
}
function desfazerAmizade(a, b) {
  const ua = db.users[a], ub = db.users[b];
  ua.buddies = sem(ua.buddies, b);
  ub.buddies = sem(ub.buddies, a);
  ua.requests = sem(ua.requests, b);
  ub.requests = sem(ub.requests, a);
}
function denunciasAbertas() { return db.reports.filter(r => r.status === 'aberta').length; }

// Encerra sessões e conexões de uma conta (usado ao banir)
function derrubar(chave) {
  for (const [t, k] of sessions) if (k === chave) sessions.delete(t);
  const o = online.get(chave);
  if (o) {
    online.delete(chave);
    o.clients.forEach(r => { evento(r, 'banned', {}); r.end(); });
    if (db.users[chave]) avisarPresenca(chave);
  }
}

// Troca a chave interna de uma conta (mudança de nome de usuário)
function migrarChave(velha, nova, nome) {
  db.users[nova] = db.users[velha];
  delete db.users[velha];
  for (const [t, k] of sessions) if (k === velha) sessions.set(t, nova);
  const o = online.get(velha);
  if (o) { online.delete(velha); online.set(nova, o); o.key = nova; }
  if (db.offline[velha]) { db.offline[nova] = db.offline[velha]; delete db.offline[velha]; }
  for (const k of Object.keys(db.offline)) db.offline[k] = db.offline[k].map(n => minus(n) === velha ? nome : n);
  for (const k of Object.keys(db.msgs)) {
    const [a, b] = k.split('|');
    if (a !== velha && b !== velha) continue;
    const novoK = chaveConversa(a === velha ? nova : a, b === velha ? nova : b);
    const lista = db.msgs[k];
    delete db.msgs[k];
    lista.forEach(m => { if (m.f === velha) m.f = nova; });
    db.msgs[novoK] = lista;
  }
  Object.values(db.groups).forEach(g => {
    g.members = g.members.map(x => x === velha ? nova : x);
    g.admins = g.admins.map(x => x === velha ? nova : x);
    if (g.dono === velha) g.dono = nova;
  });
  for (const k of Object.keys(db.msgs)) {
    if (k.startsWith('g:')) db.msgs[k].forEach(m => { if (m.f === velha) m.f = nova; });
  }
  db.reports.forEach(r => {
    if (r.deKey === velha) { r.deKey = nova; r.de = nome; }
    if (r.alvoKey === velha) { r.alvoKey = nova; r.alvo = nome; }
  });
}

// ---------- Arquivos estáticos (com suporte a Range, necessário p/ áudio no iPhone) ----------
const ESTATICOS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/script.js': ['script.js', 'application/javascript; charset=utf-8']
};
function servirArquivo(req, res, arq, tipo) {
  const caminho = path.join(__dirname, arq);
  fs.stat(caminho, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end('Arquivo não encontrado'); }
    const base = { 'Content-Type': tipo, 'Accept-Ranges': 'bytes' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let ini, fim;
      if (m[1]) { ini = parseInt(m[1], 10); fim = m[2] ? parseInt(m[2], 10) : st.size - 1; }
      else { ini = Math.max(0, st.size - parseInt(m[2], 10)); fim = st.size - 1; }
      fim = Math.min(fim, st.size - 1);
      if (ini > fim) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      res.writeHead(206, Object.assign({}, base, {
        'Content-Range': 'bytes ' + ini + '-' + fim + '/' + st.size,
        'Content-Length': fim - ini + 1
      }));
      return fs.createReadStream(caminho, { start: ini, end: fim }).pipe(res);
    }
    res.writeHead(200, Object.assign({}, base, { 'Content-Length': st.size }));
    fs.createReadStream(caminho).pipe(res);
  });
}

// ---------- Servidor ----------
const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  res.setHeader('X-Content-Type-Options', 'nosniff');

  try {
    if (req.method === 'GET' && url.pathname === '/nostalgia.mp3') {
      // Acha o arquivo de música, não importa o nome exato (ex.: "Nostalgia - Votabias(720P_HD).mp4")
      const tipos = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', ogg: 'audio/ogg', wav: 'audio/wav' };
      let achado = null;
      try {
        achado = fs.readdirSync(__dirname).find(f => /^nostalgia.*\.(mp3|m4a|mp4|webm|ogg|wav)$/i.test(f));
      } catch (e) {}
      if (!achado) { res.writeHead(404); return res.end('Música não encontrada'); }
      const ext = achado.split('.').pop().toLowerCase();
      return servirArquivo(req, res, achado, tipos[ext]);
    }

    if (req.method === 'GET' && ESTATICOS[url.pathname]) {
      const [arq, tipo] = ESTATICOS[url.pathname];
      return servirArquivo(req, res, arq, tipo);
    }

    // Fluxo em tempo real
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      const chave = sessions.get(url.searchParams.get('token'));
      if (!chave || !db.users[chave] || db.users[chave].banned) { res.writeHead(401); return res.end(); }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      let o = online.get(chave);
      const primeira = !o;
      if (!o) { o = { clients: new Set(), away: '', key: chave }; online.set(chave, o); }
      o.clients.add(res);
      const u = db.users[chave];
      const l = listasDe(chave);
      evento(res, 'init', {
        me: u.name, theme: u.theme, bio: u.bio, avatar: u.avatar,
        admin: ehAdmin(chave),
        abertas: ehAdmin(chave) ? denunciasAbertas() : 0,
        buddies: l.buddies, requests: l.requests, blocked: l.blocked,
        groups: gruposDe(chave),
        unread: db.offline[chave] || []
      });
      delete db.offline[chave];
      salvar();
      if (primeira) avisarPresenca(chave);
      const ka = setInterval(() => res.write(': ka\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ka);
        o.clients.delete(res);
        if (!o.clients.size && online.get(o.key) === o) {
          online.delete(o.key);
          if (db.users[o.key]) avisarPresenca(o.key);
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
      if (ehAdmin(chave)) {
        if (!CODIGO_ADMIN) return responder(res, 403, { erro: 'Esse nome é reservado.' });
        if (!b.codigo) return responder(res, 403, { erro: 'Esse nome é reservado. Digite o código de administrador.', codigo: true });
        if (!igual(b.codigo, CODIGO_ADMIN)) return responder(res, 403, { erro: 'Código de administrador incorreto.', codigo: true });
      }
      const salt = crypto.randomBytes(16).toString('hex');
      db.users[chave] = {
        name: nome, salt, hash: hashSenha(senha, salt),
        buddies: [], requests: [], blocked: [],
        bio: '', avatar: '', theme: 'azul', created: Date.now()
      };
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
      if (u.banned) return responder(res, 403, { erro: 'Esta conta foi suspensa.' });
      return responder(res, 200, { token: criarSessao(chave) });
    }

    // Rotas autenticadas
    const chave = sessions.get(req.headers['x-token']);
    if (!chave || !db.users[chave] || db.users[chave].banned) return responder(res, 401, { erro: 'Sessão expirada.' });
    const eu = db.users[chave];

    // Enviar mensagem
    if (url.pathname === '/api/send') {
      if (limite(envios, chave, 20, 10000)) return responder(res, 429, { erro: 'Calma! Você está enviando rápido demais.' });
      const texto = String(b.text || '').trim().slice(0, 500);
      if (!texto) return responder(res, 400, { erro: 'Mensagem vazia.' });
      const paraChave = minus(b.to || '');
      const dest = db.users[paraChave];
      if (!dest) return responder(res, 404, { erro: 'Usuário não encontrado.' });
      if (paraChave === chave) return responder(res, 400, { erro: 'Você não pode enviar para si mesmo.' });
      if (!tem(eu.buddies, paraChave) || !tem(dest.buddies, chave)) return responder(res, 403, { erro: 'Vocês ainda não são amigos.' });
      if (tem(dest.blocked, chave) || tem(eu.blocked, paraChave)) return responder(res, 403, { erro: 'Não foi possível entregar a mensagem.' });
      const f = b.fmt || {};
      const msg = { from: eu.name, text: texto, fmt: { b: !!f.b, i: !!f.i, u: !!f.u }, t: Date.now() };
      guardarMsg(chave, paraChave, msg.text, msg.fmt, msg.t);
      const o = online.get(paraChave);
      if (o) {
        empurrar(paraChave, 'msg', msg);
        salvar();
        return responder(res, 200, { ok: true, msg, away: o.away });
      }
      const fila = db.offline[paraChave] = db.offline[paraChave] || [];
      if (!tem(fila, chave)) fila.push(eu.name);
      salvar();
      return responder(res, 200, { ok: true, msg, offline: true });
    }

    // Histórico de uma conversa
    if (url.pathname === '/api/history') {
      const w = minus(b.with || '');
      if (!db.users[w] || !tem(eu.buddies, w)) return responder(res, 403, { erro: 'Vocês não são amigos.' });
      const msgs = (db.msgs[chaveConversa(chave, w)] || []).slice(-100)
        .map(m => ({ from: nomeDe(m.f), text: m.text, fmt: m.fmt, t: m.t }));
      return responder(res, 200, { msgs });
    }

    // Amizades: add / accept / decline / remove / block / unblock
    if (url.pathname === '/api/buddy') {
      const acao = b.action;
      const alvoChave = minus(String(b.name || '').trim());
      const dest = db.users[alvoChave];
      if (!dest) return responder(res, 404, { erro: 'Usuário não encontrado.' });
      if (alvoChave === chave) return responder(res, 400, { erro: 'Você não pode fazer isso com você mesmo.' });
      let msg = '';
      let pedidoEntregue = false;
      if (acao === 'add') {
        if (tem(eu.buddies, alvoChave)) return responder(res, 400, { erro: 'Vocês já são amigos.' });
        if (tem(eu.blocked, alvoChave)) return responder(res, 400, { erro: 'Você bloqueou essa pessoa. Desbloqueie antes de adicionar.' });
        if (eu.buddies.length >= 100) return responder(res, 400, { erro: 'Limite de 100 amigos.' });
        if (tem(dest.blocked, chave)) {
          msg = 'Pedido enviado! Aguarde ele(a) aceitar.'; // não revela o bloqueio
        } else if (tem(eu.requests, alvoChave)) {
          aceitar(chave, alvoChave);
          msg = 'Vocês agora são amigos!';
        } else {
          if (!tem(dest.requests, chave)) {
            if (dest.requests.length >= 50) return responder(res, 400, { erro: 'Essa pessoa já tem pedidos demais pendentes.' });
            dest.requests.push(eu.name);
            pedidoEntregue = true;
          }
          msg = 'Pedido enviado! Aguarde ele(a) aceitar.';
        }
      } else if (acao === 'accept') {
        if (!tem(eu.requests, alvoChave)) return responder(res, 400, { erro: 'Pedido não encontrado.' });
        if (eu.buddies.length >= 100) return responder(res, 400, { erro: 'Limite de 100 amigos.' });
        aceitar(chave, alvoChave);
      } else if (acao === 'decline') {
        eu.requests = sem(eu.requests, alvoChave);
      } else if (acao === 'remove') {
        desfazerAmizade(chave, alvoChave);
      } else if (acao === 'block') {
        if (!tem(eu.blocked, alvoChave)) eu.blocked.push(dest.name);
        desfazerAmizade(chave, alvoChave);
      } else if (acao === 'unblock') {
        eu.blocked = sem(eu.blocked, alvoChave);
      } else {
        return responder(res, 400, { erro: 'Ação inválida.' });
      }
      salvar();
      enviarListas(chave);
      enviarListas(alvoChave);
      if (pedidoEntregue) empurrar(alvoChave, 'request', { name: eu.name });
      return responder(res, 200, { ok: true, msg, listas: listasDe(chave) });
    }

    // Ver perfil de alguém
    if (url.pathname === '/api/perfil') {
      const alvoChave = minus(b.name || '');
      const u = db.users[alvoChave];
      if (!u || (alvoChave !== chave && tem(u.blocked, chave))) return responder(res, 404, { erro: 'Usuário não encontrado.' });
      const st = statusDe(u.name);
      return responder(res, 200, { name: st.name, bio: st.bio, avatar: st.avatar, online: st.online });
    }

    // Salvar meu perfil (bio, foto, cor)
    if (url.pathname === '/api/salvar-perfil') {
      if (b.theme !== undefined) {
        if (!TEMAS.includes(b.theme)) return responder(res, 400, { erro: 'Cor inválida.' });
        eu.theme = b.theme;
      }
      if (b.bio !== undefined) eu.bio = String(b.bio).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 150);
      if (b.avatar !== undefined) {
        const a = String(b.avatar);
        if (a && (a.length > 30000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(a))) {
          return responder(res, 400, { erro: 'Imagem inválida.' });
        }
        eu.avatar = a;
      }
      salvar();
      avisarPresenca(chave);
      return responder(res, 200, { ok: true });
    }

    // Mudar nome de usuário
    if (url.pathname === '/api/renomear') {
      if (limite(tentativas, ip, 10, 60000)) return responder(res, 429, { erro: 'Muitas tentativas. Aguarde um minuto.' });
      const nome = String(b.name || '').trim();
      if (!/^[A-Za-z0-9_]{3,16}$/.test(nome)) return responder(res, 400, { erro: 'Nome: 3 a 16 letras, números ou _.' });
      if (ehAdmin(chave)) return responder(res, 400, { erro: 'A conta de administradora não pode mudar de nome.' });
      const nova = minus(nome);
      if (nova !== chave && (db.users[nova] || ehAdmin(nova))) return responder(res, 409, { erro: 'Esse nome já está em uso.' });
      const velhoNome = eu.name;
      if (nome === velhoNome) return responder(res, 200, { ok: true, name: nome });
      const amigosAntes = eu.buddies.slice();
      eu.name = nome;
      if (nova !== chave) migrarChave(chave, nova, nome);
      for (const k of Object.keys(db.users)) {
        const u = db.users[k];
        ['buddies', 'requests', 'blocked'].forEach(campo => {
          u[campo] = u[campo].map(x => minus(x) === chave ? nome : x);
        });
      }
      salvar();
      const info = { old: velhoNome, name: nome };
      empurrar(nova, 'renamed', info);
      amigosAntes.forEach(a => { const k = minus(a); empurrar(k, 'renamed', info); enviarListas(k); });
      enviarListas(nova);
      return responder(res, 200, { ok: true, name: nome });
    }

    // Denunciar (a conversa vai para a administradora)
    if (url.pathname === '/api/report') {
      if (limite(denunciasRate, chave, 5, 600000)) return responder(res, 429, { erro: 'Você já fez denúncias demais. Tente mais tarde.' });
      const alvoChave = minus(b.name || '');
      const alvo = db.users[alvoChave];
      if (!alvo) return responder(res, 404, { erro: 'Usuário não encontrado.' });
      if (alvoChave === chave) return responder(res, 400, { erro: 'Você não pode denunciar a si mesmo.' });
      const motivo = String(b.motivo || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!motivo) return responder(res, 400, { erro: 'Escreva o motivo da denúncia.' });
      let lista, grupoNome = '';
      if (b.grupo) {
        const gr = db.groups[String(b.grupo)];
        if (!gr || !gr.members.includes(chave) || !gr.members.includes(alvoChave)) return responder(res, 400, { erro: 'Grupo inválido.' });
        lista = db.msgs['g:' + gr.id] || [];
        grupoNome = gr.name;
      } else {
        lista = db.msgs[chaveConversa(chave, alvoChave)] || [];
      }
      const conversa = lista.slice(-60).map(m => ({ from: nomeDe(m.f), text: m.text, t: m.t }));
      db.reports.push({
        id: db.nextReport++, t: Date.now(), status: 'aberta',
        de: eu.name, deKey: chave, alvo: alvo.name, alvoKey: alvoChave,
        motivo, conversa, grupo: grupoNome
      });
      if (db.reports.length > 1000) db.reports.shift();
      salvar();
      empurrar(ADMIN_KEY, 'denuncia', { n: denunciasAbertas() });
      return responder(res, 200, { ok: true });
    }

    // ---- Somente administradora ----
    if (url.pathname === '/api/admin-denuncias') {
      if (!ehAdmin(chave)) return responder(res, 403, { erro: 'Sem permissão.' });
      const reports = db.reports.slice().reverse().slice(0, 100).map(r => Object.assign({}, r, {
        banido: !!(db.users[r.alvoKey] && db.users[r.alvoKey].banned)
      }));
      return responder(res, 200, { reports, abertas: denunciasAbertas() });
    }
    if (url.pathname === '/api/admin-resolver') {
      if (!ehAdmin(chave)) return responder(res, 403, { erro: 'Sem permissão.' });
      const r = db.reports.find(x => x.id === b.id);
      if (!r) return responder(res, 404, { erro: 'Denúncia não encontrada.' });
      const alvo = db.users[r.alvoKey];
      if (b.acao === 'arquivar') {
        r.status = 'arquivada';
      } else if (b.acao === 'banir') {
        if (!alvo || ehAdmin(r.alvoKey)) return responder(res, 400, { erro: 'Não é possível banir essa conta.' });
        alvo.banned = true;
        r.status = 'banido';
        derrubar(r.alvoKey);
      } else if (b.acao === 'desbanir') {
        if (alvo) delete alvo.banned;
        r.status = 'arquivada';
      } else {
        return responder(res, 400, { erro: 'Ação inválida.' });
      }
      salvar();
      return responder(res, 200, { ok: true, abertas: denunciasAbertas() });
    }

    // ---- Grupos ----
    if (url.pathname === '/api/grupo-criar') {
      const nome = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
      if (nome.length < 2) return responder(res, 400, { erro: 'Dê um nome ao grupo (2 a 24 caracteres).' });
      if (Object.values(db.groups).filter(g => g.members.includes(chave)).length >= 20) return responder(res, 400, { erro: 'Limite de 20 grupos.' });
      const membros = [chave];
      (Array.isArray(b.members) ? b.members : []).slice(0, 29).forEach(n => {
        const k = minus(n);
        const u = db.users[k];
        if (u && k !== chave && !membros.includes(k) && tem(eu.buddies, k) && !tem(u.blocked, chave)) membros.push(k);
      });
      const id = crypto.randomBytes(4).toString('hex');
      const g = db.groups[id] = { id, name: nome, members: membros, admins: [chave], dono: chave, created: Date.now() };
      salvar();
      g.members.forEach(enviarGrupos);
      return responder(res, 200, { ok: true, id, grupos: gruposDe(chave) });
    }

    if (url.pathname === '/api/grupo-acao') {
      const g = db.groups[String(b.id || '')];
      if (!g || !g.members.includes(chave)) return responder(res, 404, { erro: 'Grupo não encontrado.' });
      const souAdm = g.admins.includes(chave);
      const souDono = g.dono === chave;
      const alvoChave = minus(b.name || '');
      const alvo = db.users[alvoChave];
      const afetados = g.members.slice();
      const negar = () => responder(res, 403, { erro: 'Só administradores podem fazer isso.' });
      switch (b.acao) {
        case 'add':
          if (!souAdm) return negar();
          if (!alvo) return responder(res, 404, { erro: 'Usuário não encontrado.' });
          if (g.members.includes(alvoChave)) return responder(res, 400, { erro: 'Essa pessoa já está no grupo.' });
          if (g.members.length >= 30) return responder(res, 400, { erro: 'Limite de 30 membros.' });
          if (!tem(eu.buddies, alvoChave) || tem(alvo.blocked, chave)) return responder(res, 400, { erro: 'Você só pode adicionar seus amigos.' });
          g.members.push(alvoChave);
          afetados.push(alvoChave);
          break;
        case 'remove':
          if (!souAdm) return negar();
          if (alvoChave === chave || !g.members.includes(alvoChave)) return responder(res, 400, { erro: 'Membro inválido.' });
          if (g.admins.includes(alvoChave) && !souDono) return responder(res, 403, { erro: 'Só a dona do grupo remove administradores.' });
          if (alvoChave === g.dono) return responder(res, 403, { erro: 'Não dá para remover a dona do grupo.' });
          g.members = g.members.filter(k => k !== alvoChave);
          g.admins = g.admins.filter(k => k !== alvoChave);
          break;
        case 'promote':
          if (!souAdm) return negar();
          if (!g.members.includes(alvoChave)) return responder(res, 400, { erro: 'Membro inválido.' });
          if (!g.admins.includes(alvoChave)) g.admins.push(alvoChave);
          break;
        case 'demote':
          if (!souDono) return responder(res, 403, { erro: 'Só a dona do grupo pode tirar um administrador.' });
          if (alvoChave === g.dono || !g.members.includes(alvoChave)) return responder(res, 400, { erro: 'Membro inválido.' });
          g.admins = g.admins.filter(k => k !== alvoChave);
          break;
        case 'rename': {
          if (!souAdm) return negar();
          const nome = String(b.novoNome || '').replace(/\s+/g, ' ').trim().slice(0, 24);
          if (nome.length < 2) return responder(res, 400, { erro: 'Nome muito curto.' });
          g.name = nome;
          break;
        }
        case 'leave':
          g.members = g.members.filter(k => k !== chave);
          g.admins = g.admins.filter(k => k !== chave);
          if (!g.members.length) { delete db.groups[g.id]; delete db.msgs['g:' + g.id]; break; }
          if (!g.admins.length) g.admins.push(g.members[0]);
          if (g.dono === chave) g.dono = g.admins[0];
          break;
        case 'delete':
          if (!souDono) return responder(res, 403, { erro: 'Só a dona do grupo pode excluir.' });
          delete db.groups[g.id];
          delete db.msgs['g:' + g.id];
          break;
        default:
          return responder(res, 400, { erro: 'Ação inválida.' });
      }
      salvar();
      afetados.forEach(enviarGrupos);
      return responder(res, 200, { ok: true, grupos: gruposDe(chave) });
    }

    if (url.pathname === '/api/grupo-enviar') {
      if (limite(envios, chave, 20, 10000)) return responder(res, 429, { erro: 'Calma! Você está enviando rápido demais.' });
      const g = db.groups[String(b.id || '')];
      if (!g || !g.members.includes(chave)) return responder(res, 404, { erro: 'Grupo não encontrado.' });
      const texto = String(b.text || '').trim().slice(0, 500);
      if (!texto) return responder(res, 400, { erro: 'Mensagem vazia.' });
      const f = b.fmt || {};
      const msg = { gid: g.id, from: eu.name, text: texto, fmt: { b: !!f.b, i: !!f.i, u: !!f.u }, t: Date.now() };
      const k = 'g:' + g.id;
      const l = db.msgs[k] = db.msgs[k] || [];
      l.push({ f: chave, text: msg.text, fmt: msg.fmt, t: msg.t });
      if (l.length > 300) l.splice(0, l.length - 300);
      g.members.forEach(m => {
        const u = db.users[m];
        if (m === chave || !u || tem(u.blocked, chave)) return;
        if (online.has(m)) return empurrar(m, 'gmsg', msg);
        const fila = db.offline[m] = db.offline[m] || [];
        if (!fila.includes('#' + g.id)) fila.push('#' + g.id);
      });
      salvar();
      return responder(res, 200, { ok: true, msg });
    }

    if (url.pathname === '/api/grupo-historico') {
      const g = db.groups[String(b.id || '')];
      if (!g || !g.members.includes(chave)) return responder(res, 404, { erro: 'Grupo não encontrado.' });
      const msgs = (db.msgs['g:' + g.id] || []).filter(m => m.f === chave || !tem(eu.blocked, m.f)).slice(-100)
        .map(m => ({ from: nomeDe(m.f), text: m.text, fmt: m.fmt, t: m.t }));
      return responder(res, 200, { msgs });
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
  if (!CODIGO_ADMIN) console.log('Aviso: defina CODIGO_ADMIN para poder criar a conta ' + ADMIN_NOME + '.');
});
