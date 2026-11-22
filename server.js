'use strict';
// BIM - servidor sem dependências externas (só módulos nativos do Node).
// Tempo real via Server-Sent Events (SSE).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.json');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(DB_FILE), 'uploads');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

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

// ---------- Banco de dados ----------
// Onde os dados ficam guardados:
//  1) Upstash Redis (gratuito e permanente), se UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN existirem
//  2) arquivo JSON (DB_FILE) - no plano grátis do Render ele é apagado quando o servidor reinicia/dorme
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USA_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const PREFIXO = 'bim:';
const VALIDADE_SESSAO = 90 * 24 * 3600 * 1000; // 90 dias

let db = { users: {}, offline: {}, msgs: {}, reports: [], nextReport: 1, groups: {}, sessions: {}, files: {} };
const sessions = new Map();     // token -> { k: chave, t: último uso }
const ultimoSalvo = new Map();  // chave do Redis -> texto já salvo

function guardarMsg(deChave, paraChave, text, fmt, t, arq) {
  const k = chaveConversa(deChave, paraChave);
  const l = db.msgs[k] = db.msgs[k] || [];
  l.push({ f: deChave, text, fmt, t, a: arq || undefined });
  if (l.length > 300) l.splice(0, l.length - 300);
}

function carregarArquivo() {
  let texto;
  try { texto = fs.readFileSync(DB_FILE, 'utf8'); } catch (e) { return false; }
  try { db = JSON.parse(texto); return true; }
  catch (e) {
    // Nunca sobrescreve um arquivo ilegível sem guardar uma cópia antes
    const bkp = DB_FILE + '.corrompido-' + Date.now();
    try { fs.writeFileSync(bkp, texto); } catch (e2) {}
    console.log('AVISO: arquivo de dados ilegível. Cópia guardada em ' + bkp);
    return false;
  }
}

// Migração / normalização dos dados (versões antigas e campos que faltam)
function normalizarDb() {
  const TEMAS_OK = ['azul', 'rosa', 'verde', 'vermelho', 'laranja', 'preto', 'branco'];
  db.users = db.users || {};
  db.offline = db.offline || {};
  db.msgs = db.msgs || {};
  db.reports = db.reports || [];
  db.nextReport = db.nextReport || 1;
  db.groups = db.groups || {};
  db.sessions = db.sessions || {};
  db.files = db.files || {};
  Object.values(db.users).forEach(u => {
    u.buddies = u.buddies || [];
    u.requests = u.requests || [];
    u.blocked = u.blocked || [];
    u.bio = u.bio || '';
    u.avatar = u.avatar || '';
    u.theme = TEMAS_OK.includes(u.theme) ? u.theme : 'azul';
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
  // Sessões salvas (assim ninguém é deslogado quando o servidor reinicia)
  const agora = Date.now();
  for (const [token, s] of Object.entries(db.sessions)) {
    const sess = typeof s === 'string' ? { k: s, t: agora } : s;
    if (sess && db.users[sess.k] && agora - sess.t < VALIDADE_SESSAO) sessions.set(token, sess);
  }
}

// ----- Redis (Upstash, via REST) -----
async function redis(cmds) {
  const r = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('Redis respondeu HTTP ' + r.status);
  const saida = await r.json();
  const erro = saida.find(x => x && x.error);
  if (erro) throw new Error(erro.error);
  return saida.map(x => x.result);
}

function sincronizarSessoes() { db.sessions = Object.fromEntries(sessions); }

// Divide o banco em pedaços pequenos: meta, um por usuário e um por conversa
function partes() {
  sincronizarSessoes();
  const m = new Map();
  m.set(PREFIXO + 'meta', JSON.stringify({
    reports: db.reports, nextReport: db.nextReport, groups: db.groups,
    offline: db.offline, sessions: db.sessions, files: db.files
  }));
  for (const [k, u] of Object.entries(db.users)) m.set(PREFIXO + 'u:' + k, JSON.stringify(u));
  for (const [k, l] of Object.entries(db.msgs)) m.set(PREFIXO + 'm:' + k, JSON.stringify(l));
  return m;
}

async function carregarRedis() {
  const [chaves] = await redis([['KEYS', PREFIXO + '*']]);
  if (!chaves.length) return false;
  const novo = { users: {}, offline: {}, msgs: {}, reports: [], nextReport: 1, groups: {}, sessions: {}, files: {} };
  for (let i = 0; i < chaves.length; i += 40) {
    const lote = chaves.slice(i, i + 40);
    const [valores] = await redis([['MGET'].concat(lote)]);
    lote.forEach((k, j) => {
      if (valores[j] == null) return;
      const obj = JSON.parse(valores[j]);
      const nome = k.slice(PREFIXO.length);
      if (nome === 'meta') Object.assign(novo, obj);
      else if (nome.startsWith('u:')) novo.users[nome.slice(2)] = obj;
      else if (nome.startsWith('m:')) novo.msgs[nome.slice(2)] = obj;
      ultimoSalvo.set(k, valores[j]);
    });
  }
  db = novo;
  return true;
}

let redisOcupado = false, redisRepetir = false;
async function salvarRedis() {
  if (redisOcupado) { redisRepetir = true; return; }
  redisOcupado = true;
  try {
    do {
      redisRepetir = false;
      const atual = partes();
      const cmds = [];
      for (const [k, v] of atual) if (ultimoSalvo.get(k) !== v) cmds.push({ c: ['SET', k, v], k, v });
      for (const k of ultimoSalvo.keys()) if (!atual.has(k)) cmds.push({ c: ['DEL', k], k, v: null });
      let lote = [], tam = 0;
      const enviar = async () => {
        if (!lote.length) return;
        await redis(lote.map(x => x.c));
        lote.forEach(x => x.v === null ? ultimoSalvo.delete(x.k) : ultimoSalvo.set(x.k, x.v));
        lote = []; tam = 0;
      };
      for (const x of cmds) {
        const t = x.c.reduce((s, p) => s + String(p).length, 0);
        if (lote.length && tam + t > 700000) await enviar();
        lote.push(x); tam += t;
      }
      await enviar();
    } while (redisRepetir);
  } catch (e) {
    console.log('Erro ao salvar no Redis (vou tentar de novo):', e.message);
    setTimeout(salvar, 10000);
  } finally {
    redisOcupado = false;
  }
}

function gravarArquivoSync() {
  sincronizarSessoes();
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {}
}

let agendado = null;
function salvar() {
  if (agendado) return;
  agendado = setTimeout(async () => {
    agendado = null;
    sincronizarSessoes();
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), e => { if (!e) fs.rename(tmp, DB_FILE, () => {}); });
    if (USA_REDIS) await salvarRedis();
  }, USA_REDIS ? 1500 : 300);
}

let encerrando = false;
async function encerrar() {
  if (encerrando) return;
  encerrando = true;
  gravarArquivoSync();
  if (USA_REDIS) await Promise.race([salvarRedis(), new Promise(r => setTimeout(r, 6000))]);
  process.exit(0);
}
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);

// ---------- Estado em memória ----------
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
  sessions.set(token, { k: chave, t: Date.now() });
  // no máximo 10 sessões por conta (apaga as mais antigas)
  const dela = [...sessions].filter(([, s]) => s.k === chave).sort((a, b) => a[1].t - b[1].t);
  while (dela.length > 10) sessions.delete(dela.shift()[0]);
  salvar();
  return token;
}
function sessaoChave(token) {
  const s = sessions.get(token);
  if (!s) return undefined;
  if (Date.now() - s.t > VALIDADE_SESSAO) { sessions.delete(token); return undefined; }
  return s.k;
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
  for (const [t, s] of sessions) if (s.k === chave) sessions.delete(t);
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
  for (const [t, s] of sessions) if (s.k === velha) s.k = nova;
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
  Object.values(db.files).forEach(m => { if (m.f === velha) m.f = nova; });
  db.reports.forEach(r => {
    if (r.deKey === velha) { r.deKey = nova; r.de = nome; }
    if (r.alvoKey === velha) { r.alvoKey = nova; r.alvo = nome; }
  });
}

// ---------- Anexos (fotos, vídeos, áudios e arquivos) ----------
// Cloudflare R2 (armazenamento grande e barato). Se as 4 variáveis existirem, os arquivos vão direto do
// celular para o R2 (sem passar pelo servidor) e os limites ficam bem maiores.
const R2_ACCOUNT = process.env.R2_ACCOUNT_ID || '';
const R2_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET || '';
const USA_R2 = !!(R2_ACCOUNT && R2_KEY_ID && R2_SECRET && R2_BUCKET);
const R2_HOST = R2_ACCOUNT + '.r2.cloudflarestorage.com';
const numero = (v, padrao) => { const n = parseFloat(v); return n > 0 ? n : padrao; };
const MAX_ARQUIVO = Math.round(numero(process.env.MAX_ARQUIVO_MB, USA_R2 ? 1024 : 15) * 1048576);   // por arquivo
const TOTAL_MAX = Math.round(numero(process.env.TOTAL_MAX_GB, USA_R2 ? 9 : 0.146) * 1073741824);      // total guardado (apaga os mais antigos)
const VALIDADE_ARQUIVO = 30 * 24 * 3600 * 1000;                    // sem R2: arquivos expiram em 30 dias
const VALIDADE_R2 = Math.round(numero(process.env.VALIDADE_DIAS, 0) * 24 * 3600 * 1000);   // com R2: 0 = nunca expira

// Gera um link assinado (AWS Signature V4) para o R2, sem precisar de nenhuma biblioteca
function r2Assinar(metodo, chaveObj, extra, expira) {
  const agora = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dia = agora.slice(0, 8);
  const escopo = dia + '/auto/s3/aws4_request';
  const enc = x => encodeURIComponent(x).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const q = Object.assign({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': R2_KEY_ID + '/' + escopo,
    'X-Amz-Date': agora,
    'X-Amz-Expires': String(expira),
    'X-Amz-SignedHeaders': 'host'
  }, extra || {});
  const query = Object.keys(q).sort().map(k => enc(k) + '=' + enc(q[k])).join('&');
  const caminho = '/' + R2_BUCKET + '/' + chaveObj;
  const sha = d => crypto.createHash('sha256').update(d).digest('hex');
  const canon = [metodo, caminho, query, 'host:' + R2_HOST + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const paraAssinar = ['AWS4-HMAC-SHA256', agora, escopo, sha(canon)].join('\n');
  const hm = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const chaveAssin = hm(hm(hm(hm('AWS4' + R2_SECRET, dia), 'auto'), 's3'), 'aws4_request');
  const assinatura = crypto.createHmac('sha256', chaveAssin).update(paraAssinar).digest('hex');
  return 'https://' + R2_HOST + caminho + '?' + query + '&X-Amz-Signature=' + assinatura;
}
const PREFIXO_ARQ = 'bimf:';                     // no Redis (prefixo diferente do 'bim:' de propósito)
const PEDACO = 600000;                           // caracteres base64 por pedaço no Redis
const PERIGOSOS = /\.(exe|msi|bat|cmd|com|scr|pif|vbs|vbe|js|jse|wsf|ps1|jar|apk|dmg|lnk|reg|hta|cpl)$/i;
const uploads = new Map();                       // chave -> timestamps (envios de arquivo)
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {}

// Descobre o tipo pelo conteúdo do arquivo (não confia no que o navegador diz)
function tipoPorBytes(b, decl) {
  const a = (i, n) => b.toString('latin1', i, i + n);
  const audio = /^audio\//.test(decl || '');
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { k: 'image', y: 'image/jpeg' };
  if (b[0] === 0x89 && a(1, 3) === 'PNG') return { k: 'image', y: 'image/png' };
  if (a(0, 4) === 'GIF8') return { k: 'image', y: 'image/gif' };
  if (a(0, 4) === 'RIFF' && a(8, 4) === 'WEBP') return { k: 'image', y: 'image/webp' };
  if (a(0, 4) === 'RIFF' && a(8, 4) === 'WAVE') return { k: 'audio', y: 'audio/wav' };
  if (a(4, 4) === 'ftyp') {
    const marca = a(8, 4);
    if (marca === 'qt  ') return { k: 'video', y: 'video/quicktime' };
    if (marca === 'M4A ' || marca === 'M4B ') return { k: 'audio', y: 'audio/mp4' };
    if (/^(heic|heix|hevc|mif1|msf1|avif)/.test(marca)) return { k: 'file', y: 'application/octet-stream' };
    return audio ? { k: 'audio', y: 'audio/mp4' } : { k: 'video', y: 'video/mp4' };
  }
  if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return audio ? { k: 'audio', y: 'audio/webm' } : { k: 'video', y: 'video/webm' };
  if (a(0, 3) === 'ID3' || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)) return { k: 'audio', y: 'audio/mpeg' };
  if (a(0, 4) === 'OggS') return { k: 'audio', y: 'audio/ogg' };
  return { k: 'file', y: 'application/octet-stream' };
}
function nomeSeguro(n) {
  n = String(n || '').replace(/[\x00-\x1f\x7f<>:"\\|?*\/]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100);
  return n || 'arquivo';
}
function arqPublico(id) {
  const m = id && db.files[id];
  if (!m) return null;
  return { id, n: m.n, y: m.y, k: m.k, s: m.s, exp: !!m.exp };
}
// Forma da mensagem enviada ao navegador (histórico e denúncias)
function msgOut(m) {
  const o = { from: nomeDe(m.f), text: m.text, fmt: m.fmt, t: m.t };
  if (m.a) o.file = arqPublico(m.a);
  return o;
}
// null = sem anexo, false = anexo inválido, senão o id
function anexoValido(id, chave) {
  if (!id) return null;
  const m = db.files[String(id)];
  if (!m || m.exp || m.p || m.f !== chave) return false;
  return String(id);
}

async function arquivoParaRedis(id, caminho) {
  const b64 = (await fs.promises.readFile(caminho)).toString('base64');
  const n = Math.ceil(b64.length / PEDACO);
  for (let i = 0; i < n; i += 3) {
    const lote = [];
    for (let j = i; j < Math.min(i + 3, n); j++) {
      lote.push(redis([['SET', PREFIXO_ARQ + id + ':' + j, b64.slice(j * PEDACO, (j + 1) * PEDACO)]]));
    }
    await Promise.all(lote);
  }
  return n;
}
const restaurando = new Map();
function restaurarDoRedis(id, m) {
  if (restaurando.has(id)) return restaurando.get(id);
  const p = (async () => {
    const partes = [];
    for (let i = 0; i < m.c; i += 2) {
      const chaves = [];
      for (let j = i; j < Math.min(i + 2, m.c); j++) chaves.push(PREFIXO_ARQ + id + ':' + j);
      const [vals] = await redis([['MGET'].concat(chaves)]);
      if (vals.some(v => v == null)) return false;
      partes.push(...vals);
    }
    const tmp = path.join(UPLOAD_DIR, id + '.tmp');
    await fs.promises.writeFile(tmp, Buffer.from(partes.join(''), 'base64'));
    await fs.promises.rename(tmp, path.join(UPLOAD_DIR, id));
    return true;
  })().catch(e => { console.log('Erro ao recuperar arquivo do Redis:', e.message); return false; })
    .finally(() => restaurando.delete(id));
  restaurando.set(id, p);
  return p;
}
async function apagarArquivoRedis(id, n) {
  if (!USA_REDIS || !n) return;
  const chaves = [];
  for (let j = 0; j < n; j++) chaves.push(PREFIXO_ARQ + id + ':' + j);
  for (let i = 0; i < chaves.length; i += 50) await redis([['DEL'].concat(chaves.slice(i, i + 50))]);
}
async function expirarArquivo(id) {
  const m = db.files[id];
  if (!m || m.exp) return;
  m.exp = true;   // a mensagem continua no histórico, mas mostra "arquivo expirado"
  if (m.r) {
    try { await fetch(r2Assinar('DELETE', id, null, 300), { method: 'DELETE' }); }
    catch (e) { console.log('Erro ao apagar arquivo do R2:', e.message); }
  }
  try { fs.unlinkSync(path.join(UPLOAD_DIR, id)); } catch (e) {}
  try { await apagarArquivoRedis(id, m.c); } catch (e) { console.log('Erro ao apagar arquivo do Redis:', e.message); }
  m.c = 0;
}
function espacoUsado() {
  return Object.values(db.files).reduce((s, m) => s + (m.exp ? 0 : m.s), 0);
}
async function liberarEspaco(precisa) {
  const ativos = Object.entries(db.files).filter(([, m]) => !m.exp).sort((a, b) => a[1].t - b[1].t);
  let total = espacoUsado();
  while (total + precisa > TOTAL_MAX && ativos.length) {
    const [id, m] = ativos.shift();
    total -= m.s;
    await expirarArquivo(id);
  }
  salvar();
}
async function limparArquivos() {
  const agora = Date.now();
  let mudou = false;
  for (const [id, m] of Object.entries(db.files)) {
    if (m.exp) { if (agora - m.t > 365 * 24 * 3600 * 1000) { delete db.files[id]; mudou = true; } continue; }
    const lim = m.r ? VALIDADE_R2 : VALIDADE_ARQUIVO;
    const velho = lim > 0 && agora - m.t > lim;
    const orfao = !m.u && agora - m.t > 3600000;   // enviado mas nunca anexado a uma mensagem
    const sumiu = !m.r && !USA_REDIS && !fs.existsSync(path.join(UPLOAD_DIR, id));
    if (velho || orfao || sumiu) { await expirarArquivo(id); mudou = true; }
  }
  if (espacoUsado() > TOTAL_MAX) { await liberarEspaco(0); mudou = true; }
  if (mudou) salvar();
  // arquivos soltos no disco que o banco não conhece
  try {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      const id = f.replace(/\.tmp$/, '');
      const p = path.join(UPLOAD_DIR, f);
      if ((!db.files[id] || db.files[id].exp) && agora - fs.statSync(p).mtimeMs > 3600000) fs.unlink(p, () => {});
    }
  } catch (e) {}
}

async function receberUpload(req, res) {
  if (USA_R2) { req.resume(); return responder(res, 400, { erro: 'Atualize a página e tente de novo.' }); }
  const chave = sessaoChave(req.headers['x-token']);
  if (!chave || !db.users[chave] || db.users[chave].banned) { req.resume(); return responder(res, 401, { erro: 'Sessão expirada.' }); }
  if (limite(uploads, chave, 10, 60000)) { req.resume(); return responder(res, 429, { erro: 'Muitos envios de arquivo seguidos. Aguarde um pouco.' }); }
  const tam = parseInt(req.headers['content-length'] || '0', 10);
  if (!tam) { req.resume(); return responder(res, 400, { erro: 'Arquivo vazio.' }); }
  if (tam > MAX_ARQUIVO) {
    const recusar = () => responder(res, 413, { erro: 'Arquivo grande demais (máximo ' + Math.round(MAX_ARQUIVO / 1048576) + ' MB).' });
    if (tam > 100 * 1024 * 1024) { res.setHeader('Connection', 'close'); res.on('finish', () => req.destroy()); return recusar(); }
    // lê e descarta o arquivo até o fim para o navegador conseguir receber a resposta
    req.on('end', recusar);
    return req.resume();
  }
  let nome = '';
  try { nome = decodeURIComponent(String(req.headers['x-filename'] || '')); } catch (e) {}
  nome = nomeSeguro(nome);
  if (PERIGOSOS.test(nome)) { req.resume(); return responder(res, 400, { erro: 'Esse tipo de arquivo não pode ser enviado (por segurança).' }); }
  if (espacoUsado() + tam > TOTAL_MAX) await liberarEspaco(tam);

  const id = crypto.randomBytes(16).toString('hex');
  const caminho = path.join(UPLOAD_DIR, id);
  const tmp = caminho + '.tmp';
  let bytes = 0;
  const contador = new Transform({
    transform(pedaco, enc, cb) {
      bytes += pedaco.length;
      if (bytes > MAX_ARQUIVO) return cb(new Error('grande'));
      cb(null, pedaco);
    }
  });
  try {
    await pipeline(req, contador, fs.createWriteStream(tmp));
  } catch (e) {
    fs.unlink(tmp, () => {});
    return responder(res, 413, { erro: 'O envio foi interrompido. Tente de novo.' });
  }
  if (!bytes) { fs.unlink(tmp, () => {}); return responder(res, 400, { erro: 'Arquivo vazio.' }); }
  const head = Buffer.alloc(16);
  const fd = fs.openSync(tmp, 'r');
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);
  const tipo = tipoPorBytes(head, String(req.headers['x-filetype'] || ''));
  fs.renameSync(tmp, caminho);
  let pedacos = 0;
  if (USA_REDIS) {
    try { pedacos = await arquivoParaRedis(id, caminho); }
    catch (e) {
      fs.unlink(caminho, () => {});
      console.log('Erro ao guardar arquivo no Redis:', e.message);
      return responder(res, 502, { erro: 'Não consegui guardar o arquivo. Tente de novo.' });
    }
  }
  db.files[id] = { n: nome, y: tipo.y, k: tipo.k, s: bytes, f: chave, t: Date.now(), c: pedacos, u: 0 };
  salvar();
  return responder(res, 200, { ok: true, file: arqPublico(id) });
}

async function servirAnexo(req, res, id) {
  const m = /^[0-9a-f]{32}$/.test(id) ? db.files[id] : null;
  if (!m || m.exp) { res.writeHead(404); return res.end('Arquivo não encontrado ou expirado.'); }
  if (m.r) {
    const inl = m.k === 'image' || m.k === 'video' || m.k === 'audio';
    const asc = m.n.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    const disp = (inl ? 'inline' : 'attachment') + '; filename="' + asc + '"; filename*=UTF-8\'\'' + encodeURIComponent(m.n);
    const alvo = r2Assinar('GET', id, {
      'response-content-disposition': disp,
      'response-content-type': inl ? m.y : 'application/octet-stream'
    }, 3600);
    res.writeHead(302, { Location: alvo, 'Cache-Control': 'private, max-age=1800' });
    return res.end();
  }
  const caminho = path.join(UPLOAD_DIR, id);
  if (!fs.existsSync(caminho)) {
    if (!USA_REDIS || !(await restaurarDoRedis(id, m))) { res.writeHead(404); return res.end('Arquivo indisponível.'); }
  }
  const inline = m.k === 'image' || m.k === 'video' || m.k === 'audio';
  const ascii = m.n.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return servirArquivo(req, res, caminho, inline ? m.y : 'application/octet-stream', {
    'Content-Disposition': (inline ? 'inline' : 'attachment') + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(m.n),
    'Cache-Control': 'private, max-age=86400',
    'Content-Security-Policy': "default-src 'none'; sandbox"
  });
}

// ---------- Arquivos estáticos (com suporte a Range, necessário p/ áudio no iPhone) ----------
const ESTATICOS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/script.js': ['script.js', 'application/javascript; charset=utf-8']
};
function servirArquivo(req, res, arq, tipo, extras) {
  const caminho = path.isAbsolute(arq) ? arq : path.join(__dirname, arq);
  fs.stat(caminho, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end('Arquivo não encontrado'); }
    const base = Object.assign({ 'Content-Type': tipo, 'Accept-Ranges': 'bytes' }, extras || {});
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

    if (req.method === 'GET' && url.pathname.startsWith('/f/')) {
      return await servirAnexo(req, res, url.pathname.slice(3));
    }

    if (req.method === 'GET' && ESTATICOS[url.pathname]) {
      const [arq, tipo] = ESTATICOS[url.pathname];
      return servirArquivo(req, res, arq, tipo);
    }

    // Verificação simples (usada para manter o servidor acordado e para o app saber se a sessão ainda vale)
    if (req.method === 'GET' && url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
    if (req.method === 'GET' && url.pathname === '/api/sessao') {
      const k = sessaoChave(url.searchParams.get('token'));
      if (!k || !db.users[k] || db.users[k].banned) return responder(res, 401, { ok: false });
      return responder(res, 200, { ok: true });
    }

    // Fluxo em tempo real
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      const chave = sessaoChave(url.searchParams.get('token'));
      if (!chave || !db.users[chave] || db.users[chave].banned) { res.writeHead(401); return res.end(); }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      const sess = sessions.get(url.searchParams.get('token'));
      if (sess) sess.t = Date.now(); // renova a validade
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

    if (url.pathname === '/api/upload') return await receberUpload(req, res);

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
    const chave = sessaoChave(req.headers['x-token']);
    if (!chave || !db.users[chave] || db.users[chave].banned) return responder(res, 401, { erro: 'Sessão expirada.' });
    const eu = db.users[chave];

    // ---- Envio direto de arquivos para o R2 ----
    if (url.pathname === '/api/config-upload') return responder(res, 200, { r2: USA_R2, max: MAX_ARQUIVO });

    if (url.pathname === '/api/upload-url') {
      if (!USA_R2) return responder(res, 400, { erro: 'Armazenamento R2 não configurado.' });
      if (limite(uploads, chave, 10, 60000)) return responder(res, 429, { erro: 'Muitos envios de arquivo seguidos. Aguarde um pouco.' });
      const tam = Math.floor(Number(b.size) || 0);
      if (tam <= 0) return responder(res, 400, { erro: 'Arquivo vazio.' });
      if (tam > MAX_ARQUIVO) return responder(res, 413, { erro: 'Arquivo grande demais (máximo ' + Math.round(MAX_ARQUIVO / 1048576) + ' MB).' });
      const nome = nomeSeguro(b.name);
      if (PERIGOSOS.test(nome)) return responder(res, 400, { erro: 'Esse tipo de arquivo não pode ser enviado (por segurança).' });
      if (espacoUsado() + tam > TOTAL_MAX) await liberarEspaco(tam);
      const id = crypto.randomBytes(16).toString('hex');
      db.files[id] = { n: nome, y: 'application/octet-stream', k: 'file', s: tam, f: chave, t: Date.now(), c: 0, u: 0, r: 1, p: 1 };
      salvar();
      return responder(res, 200, { id, url: r2Assinar('PUT', id, null, 3600) });
    }

    if (url.pathname === '/api/upload-done') {
      const id = String(b.id || '');
      const m = db.files[id];
      if (!m || !m.r || !m.p || m.f !== chave) return responder(res, 404, { erro: 'Envio não encontrado.' });
      let total = 0, head = Buffer.alloc(0);
      try {
        const r = await fetch(r2Assinar('GET', id, null, 300), { headers: { Range: 'bytes=0-15' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const cr = /\/(\d+)$/.exec(r.headers.get('content-range') || '');
        head = Buffer.from(await r.arrayBuffer());
        total = cr ? parseInt(cr[1], 10) : head.length;
      } catch (e) {
        return responder(res, 400, { erro: 'O envio não foi concluído. Tente de novo.' });
      }
      if (!total || total > MAX_ARQUIVO) {
        await expirarArquivo(id);
        delete db.files[id];
        salvar();
        return responder(res, 413, { erro: 'Arquivo grande demais (máximo ' + Math.round(MAX_ARQUIVO / 1048576) + ' MB).' });
      }
      const tipo = tipoPorBytes(head, String(b.type || ''));
      m.y = tipo.y; m.k = tipo.k; m.s = total; delete m.p;
      salvar();
      return responder(res, 200, { ok: true, file: arqPublico(id) });
    }

    // Enviar mensagem
    if (url.pathname === '/api/send') {
      if (limite(envios, chave, 20, 10000)) return responder(res, 429, { erro: 'Calma! Você está enviando rápido demais.' });
      const texto = String(b.text || '').trim().slice(0, 500);
      const idArq = anexoValido(b.file, chave);
      if (idArq === false) return responder(res, 400, { erro: 'Arquivo inválido ou expirado. Envie de novo.' });
      if (!texto && !idArq) return responder(res, 400, { erro: 'Mensagem vazia.' });
      const paraChave = minus(b.to || '');
      const dest = db.users[paraChave];
      if (!dest) return responder(res, 404, { erro: 'Usuário não encontrado.' });
      if (paraChave === chave) return responder(res, 400, { erro: 'Você não pode enviar para si mesmo.' });
      if (!tem(eu.buddies, paraChave) || !tem(dest.buddies, chave)) return responder(res, 403, { erro: 'Vocês ainda não são amigos.' });
      if (tem(dest.blocked, chave) || tem(eu.blocked, paraChave)) return responder(res, 403, { erro: 'Não foi possível entregar a mensagem.' });
      const f = b.fmt || {};
      const msg = { from: eu.name, text: texto, fmt: { b: !!f.b, i: !!f.i, u: !!f.u }, t: Date.now() };
      if (idArq) { msg.file = arqPublico(idArq); db.files[idArq].u = 1; }
      guardarMsg(chave, paraChave, msg.text, msg.fmt, msg.t, idArq);
      const o = online.get(paraChave);
      if (o) {
        empurrar(paraChave, 'msg', msg);
        salvar();
        return responder(res, 200, { ok: true, msg, away: o.away });
      }
      const fila = db.offline[paraChave] = db.offline[paraChave] || [];
      if (fila.length < 200) fila.push(eu.name); // uma entrada por mensagem (o site mostra a contagem)
      salvar();
      return responder(res, 200, { ok: true, msg, offline: true });
    }

    // Histórico de uma conversa
    if (url.pathname === '/api/history') {
      const w = minus(b.with || '');
      if (!db.users[w] || !tem(eu.buddies, w)) return responder(res, 403, { erro: 'Vocês não são amigos.' });
      const msgs = (db.msgs[chaveConversa(chave, w)] || []).slice(-100)
        .map(msgOut);
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
      const conversa = lista.slice(-60).map(msgOut);
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
      const idArq = anexoValido(b.file, chave);
      if (idArq === false) return responder(res, 400, { erro: 'Arquivo inválido ou expirado. Envie de novo.' });
      if (!texto && !idArq) return responder(res, 400, { erro: 'Mensagem vazia.' });
      const f = b.fmt || {};
      const msg = { gid: g.id, from: eu.name, text: texto, fmt: { b: !!f.b, i: !!f.i, u: !!f.u }, t: Date.now() };
      if (idArq) { msg.file = arqPublico(idArq); db.files[idArq].u = 1; }
      const k = 'g:' + g.id;
      const l = db.msgs[k] = db.msgs[k] || [];
      l.push({ f: chave, text: msg.text, fmt: msg.fmt, t: msg.t, a: idArq || undefined });
      if (l.length > 300) l.splice(0, l.length - 300);
      g.members.forEach(m => {
        const u = db.users[m];
        if (m === chave || !u || tem(u.blocked, chave)) return;
        if (online.has(m)) return empurrar(m, 'gmsg', msg);
        const fila = db.offline[m] = db.offline[m] || [];
        if (fila.length < 200) fila.push('#' + g.id);
      });
      salvar();
      return responder(res, 200, { ok: true, msg });
    }

    if (url.pathname === '/api/grupo-historico') {
      const g = db.groups[String(b.id || '')];
      if (!g || !g.members.includes(chave)) return responder(res, 404, { erro: 'Grupo não encontrado.' });
      const msgs = (db.msgs['g:' + g.id] || []).filter(m => m.f === chave || !tem(eu.blocked, m.f)).slice(-100)
        .map(msgOut);
      return responder(res, 200, { msgs });
    }

    if (url.pathname === '/api/status') {
      const o = online.get(chave);
      if (o) { o.away = String(b.away || '').slice(0, 100); avisarPresenca(chave); }
      return responder(res, 200, { ok: true });
    }

    if (url.pathname === '/api/logout') {
      sessions.delete(req.headers['x-token']);
      salvar();
      return responder(res, 200, { ok: true });
    }

    responder(res, 404, { erro: 'Rota desconhecida.' });
  } catch (e) {
    if (!res.headersSent) responder(res, 400, { erro: 'Requisição inválida.' });
  }
});

async function iniciar() {
  if (USA_REDIS) {
    try {
      const achou = await carregarRedis();
      if (!achou) {
        // Redis vazio: se houver arquivo antigo, aproveita; senão começa do zero
        if (carregarArquivo()) console.log('Dados do arquivo copiados para o Redis.');
        else console.log('Redis vazio: começando do zero.');
      } else {
        console.log('Dados carregados do Redis.');
      }
    } catch (e) {
      // Não sobe com banco vazio: isso apagaria tudo no próximo salvamento
      console.log('ERRO: não consegui ler o Redis (' + e.message + '). Confira as variáveis UPSTASH_*.');
      process.exit(1);
    }
  } else {
    carregarArquivo();
    console.log('Aviso: guardando dados só em arquivo. No Render grátis eles somem quando o servidor reinicia (veja o LEIA-ME).');
  }
  normalizarDb();
  console.log(USA_R2 ? 'Arquivos: usando Cloudflare R2 (máx. ' + Math.round(MAX_ARQUIVO / 1048576) + ' MB por arquivo).' : 'Arquivos: sem R2, limite de ' + Math.round(MAX_ARQUIVO / 1048576) + ' MB (veja o LEIA-ME).');
  if (USA_REDIS) salvar();
  limparArquivos().catch(e => console.log('Erro na limpeza de arquivos:', e.message));
  setInterval(() => limparArquivos().catch(() => {}), 3600000).unref();
  servidor.listen(PORT, () => {
    console.log('BIM rodando em http://localhost:' + PORT);
    if (!CODIGO_ADMIN) console.log('Aviso: defina CODIGO_ADMIN para poder criar a conta ' + ADMIN_NOME + '.');
  });
}
iniciar();
