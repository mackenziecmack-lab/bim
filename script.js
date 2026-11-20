'use strict';
const $ = id => document.getElementById(id);

// ---------- Estado ----------
let token = sessionStorage.getItem('cb_token') || '';
let eu = '';
let amigos = [];           // [{name, online, away}]
let selecionado = '';
let es = null;             // EventSource
let somAtivo = true;
let modoCadastro = false;
let zTopo = 10;
const chats = {};          // chave -> { janela, hist, nome }
const gruposAbertos = { online: true, offline: true };

// ---------- Sons (sintetizados, sem arquivos) ----------
let audioCtx;
function tom(notas, dur, tipo) {
  if (!somAtivo) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    let t = audioCtx.currentTime;
    notas.forEach(f => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = tipo || 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.12, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + dur);
      t += dur * 0.75;
    });
  } catch (e) {}
}
const somPorta    = () => tom([392, 523, 659, 784], 0.12, 'triangle'); // amigo entrou
const somPortaFim = () => tom([784, 523, 392], 0.12, 'triangle');      // amigo saiu
const somRecebe   = () => tom([988, 740, 988], 0.1);
const somEnvia    = () => tom([660], 0.07);

// ---------- Janelas arrastáveis ----------
document.addEventListener('mousemove', e => {
  if (!arrasto) return;
  arrasto.j.style.left = Math.max(0, e.clientX - arrasto.ox) + 'px';
  arrasto.j.style.top  = Math.max(0, e.clientY - arrasto.oy) + 'px';
});
document.addEventListener('mouseup', () => { arrasto = null; });
let arrasto = null;

function arrastavel(j) {
  j.addEventListener('mousedown', () => { j.style.zIndex = ++zTopo; });
  j.querySelector('.titulo').addEventListener('mousedown', e => {
    if (e.target.classList.contains('btn-titulo')) return;
    const r = j.getBoundingClientRect();
    j.style.transform = 'none';
    j.style.left = r.left + 'px';
    j.style.top = r.top + 'px';
    arrasto = { j, ox: e.clientX - r.left, oy: e.clientY - r.top };
    e.preventDefault();
  });
}
arrastavel($('login-win'));
arrastavel($('lista-win'));

// ---------- API ----------
const MSG_SERVIDOR =
  'Sem conexão com o servidor. Rode "node server.js" na pasta e abra http://localhost:3000 ' +
  '(não abra o index.html direto nem por outro servidor).';

async function api(rota, corpo) {
  let r;
  try {
    r = await fetch('/api/' + rota, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-token': token },
      body: JSON.stringify(corpo || {})
    });
  } catch (e) {
    throw new Error(MSG_SERVIDOR);
  }
  let dados = null;
  try { dados = await r.json(); } catch (e) {}
  if (!r.ok) {
    if (r.status === 401 && token) voltarAoLogin('Sessão expirada. Entre novamente.', true);
    throw new Error((dados && dados.erro) || MSG_SERVIDOR);
  }
  return dados || {};
}

// ---------- Login / cadastro ----------
function status(msg, erro) {
  const s = $('status-login');
  s.textContent = msg || '';
  s.className = 'status-login' + (erro ? ' erro' : '');
}

function alternarModo() {
  modoCadastro = !modoCadastro;
  $('linha-confirma').classList.toggle('escondido', !modoCadastro);
  $('btn-principal').textContent = modoCadastro ? 'Cadastrar' : 'Entrar';
  $('login-titulo').textContent = modoCadastro ? 'Novo Nome - BIM' : 'Entrar - BIM';
  $('link-troca').textContent = modoCadastro ? 'Já tem um nome? Entrar' : 'Não tem um nome? Cadastre-se grátis!';
  $('f-pass').autocomplete = modoCadastro ? 'new-password' : 'current-password';
  status('');
}
$('link-troca').addEventListener('click', e => { e.preventDefault(); alternarModo(); });

async function enviarLogin() {
  const user = $('f-user').value.trim();
  const pass = $('f-pass').value;
  if (!user || !pass) return status('Preencha nome e senha.', true);
  if (modoCadastro && pass !== $('f-pass2').value) return status('As senhas não conferem.', true);
  $('btn-principal').disabled = true;
  status(modoCadastro ? 'Criando seu nome...' : 'Conectando...');
  try {
    const r = await api(modoCadastro ? 'register' : 'login', { user, pass });
    token = r.token;
    sessionStorage.setItem('cb_token', token);
    $('f-pass').value = ''; $('f-pass2').value = '';
    conectar();
  } catch (e) {
    status(e.message, true);
  }
  $('btn-principal').disabled = false;
}
$('btn-principal').addEventListener('click', enviarLogin);
['f-user', 'f-pass', 'f-pass2'].forEach(id =>
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') enviarLogin(); }));

function voltarAoLogin(msg, erro) {
  if (es) { es.close(); es = null; }
  token = ''; eu = ''; amigos = []; selecionado = '';
  sessionStorage.removeItem('cb_token');
  Object.keys(chats).forEach(k => { chats[k].janela.remove(); delete chats[k]; });
  $('lista-win').classList.add('escondido');
  $('login-win').classList.remove('escondido');
  document.title = 'BIM';
  status(msg || '', erro);
}

// ---------- Conexão em tempo real ----------
function conectar() {
  if (es) es.close();
  let iniciou = false;
  es = new EventSource('/api/stream?token=' + encodeURIComponent(token));

  es.addEventListener('init', e => {
    iniciou = true;
    const d = JSON.parse(e.data);
    eu = d.me;
    amigos = d.buddies;
    $('login-win').classList.add('escondido');
    $('lista-win').classList.remove('escondido');
    $('meu-nome').textContent = eu;
    $('lista-titulo').textContent = 'Lista de Amigos de ' + eu;
    desenharLista();
    somPorta();
    d.offline.forEach(m => receber(m, true));
  });

  es.addEventListener('presence', e => {
    const st = JSON.parse(e.data);
    const i = amigos.findIndex(a => a.name.toLowerCase() === st.name.toLowerCase());
    if (i < 0) return;
    const antes = amigos[i];
    amigos[i] = st;
    if (!antes.online && st.online) somPorta();
    if (antes.online && !st.online) somPortaFim();
    desenharLista();
    const c = chats[st.name.toLowerCase()];
    if (c) {
      if (!antes.online && st.online) sistema(c, st.name + ' entrou.');
      if (antes.online && !st.online) sistema(c, st.name + ' saiu.');
    }
  });

  es.addEventListener('msg', e => receber(JSON.parse(e.data), false));

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      voltarAoLogin(iniciou ? 'Conexão perdida.' : 'Não foi possível conectar.', true);
    }
  };
}

// ---------- Lista de amigos ----------
function desenharLista() {
  const box = $('amigos');
  box.innerHTML = '';
  const ord = (a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });
  const on = amigos.filter(a => a.online).sort(ord);
  const off = amigos.filter(a => !a.online).sort(ord);

  if (!amigos.length) {
    box.innerHTML = '<div class="vazio">Sua lista está vazia. Clique em "Adicionar" e digite o nome de um amigo.</div>';
    return;
  }
  grupo(box, 'online', 'Amigos Online (' + on.length + '/' + amigos.length + ')', on);
  grupo(box, 'offline', 'Offline (' + off.length + '/' + amigos.length + ')', off);
}
function grupo(box, id, titulo, lista) {
  const t = document.createElement('div');
  t.className = 'grupo-titulo';
  t.textContent = (gruposAbertos[id] ? '▼ ' : '▶ ') + titulo;
  t.addEventListener('click', () => { gruposAbertos[id] = !gruposAbertos[id]; desenharLista(); });
  box.appendChild(t);
  if (!gruposAbertos[id]) return;
  lista.forEach(a => {
    const l = document.createElement('div');
    l.className = 'amigo' + (a.online ? (a.away ? ' away' : '') : ' offline') +
      (a.name.toLowerCase() === selecionado.toLowerCase() ? ' sel' : '');
    const ausente = a.online && a.away;
    l.innerHTML = '<span>' + esc(a.name) + (ausente ? ' (ausente)' : '') + '</span>';
    l.addEventListener('click', () => { selecionado = a.name; desenharLista(); });
    l.addEventListener('dblclick', () => abrirChat(a.name));
    box.appendChild(l);
  });
}

$('btn-add').addEventListener('click', async () => {
  const nome = (prompt('Nome do amigo que deseja adicionar:') || '').trim();
  if (!nome) return;
  try {
    const r = await api('buddy', { action: 'add', name: nome });
    if (!amigos.some(a => a.name.toLowerCase() === r.buddy.name.toLowerCase())) amigos.push(r.buddy);
    desenharLista();
  } catch (e) { alert(e.message); }
});
$('btn-del').addEventListener('click', async () => {
  if (!selecionado) return alert('Clique em um amigo da lista primeiro.');
  if (!confirm('Remover ' + selecionado + ' da sua lista?')) return;
  try {
    await api('buddy', { action: 'remove', name: selecionado });
    amigos = amigos.filter(a => a.name.toLowerCase() !== selecionado.toLowerCase());
    selecionado = '';
    desenharLista();
  } catch (e) { alert(e.message); }
});

let ausenteMsg = '';
$('btn-away').addEventListener('click', async () => {
  try {
    if (ausenteMsg) {
      ausenteMsg = '';
      await api('status', { away: '' });
      $('btn-away').textContent = '🌙 Ausente';
      $('meu-estado').textContent = 'Disponível';
    } else {
      const m = prompt('Mensagem de ausência:', 'Estou ausente no momento.');
      if (!m) return;
      ausenteMsg = m;
      await api('status', { away: m });
      $('btn-away').textContent = '✔ Voltei';
      $('meu-estado').textContent = 'Ausente: ' + m;
    }
  } catch (e) { alert(e.message); }
});
$('btn-som').addEventListener('click', () => {
  somAtivo = !somAtivo;
  $('btn-som').textContent = somAtivo ? '🔊' : '🔇';
});
$('btn-sair').addEventListener('click', async () => {
  somPortaFim();
  try { await api('logout'); } catch (e) {}
  voltarAoLogin('');
});

// ---------- Conversa ----------
function esc(t) {
  return String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function hora(t) {
  return new Date(t || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
const EMOTICONS = [[':)', '🙂'], [':(', '🙁'], [':D', '😀'], [';)', '😉'], [':P', '😛'], [':O', '😮'], ['<3', '❤️']];
function formatar(texto, fmt) {
  let h = esc(texto);
  EMOTICONS.forEach(([k, v]) => { h = h.split(esc(k)).join(v); });
  if (fmt && fmt.b) h = '<b>' + h + '</b>';
  if (fmt && fmt.i) h = '<i>' + h + '</i>';
  if (fmt && fmt.u) h = '<u>' + h + '</u>';
  return h;
}
function sistema(c, texto) {
  const d = document.createElement('div');
  d.className = 'msg sistema';
  d.textContent = texto;
  c.hist.appendChild(d);
  c.hist.scrollTop = c.hist.scrollHeight;
}
function linha(c, quem, classe, html, t) {
  const d = document.createElement('div');
  d.className = 'msg';
  d.innerHTML = '<span class="' + classe + '">' + esc(quem) + '</span> (' + hora(t) + '): ' + html;
  c.hist.appendChild(d);
  c.hist.scrollTop = c.hist.scrollHeight;
}

function abrirChat(nome, semFoco) {
  const chave = nome.toLowerCase();
  if (chats[chave]) {
    chats[chave].janela.style.zIndex = ++zTopo;
    if (!semFoco) chats[chave].input.focus();
    return chats[chave];
  }
  const n = Object.keys(chats).length;
  const j = document.createElement('div');
  j.className = 'janela chat';
  j.style.left = (290 + n * 28) + 'px';
  j.style.top = (40 + n * 28) + 'px';
  j.style.zIndex = ++zTopo;
  j.innerHTML =
    '<div class="titulo"><span>' + esc(nome) + ' - Mensagem Instantânea</span>' +
    '<button class="btn-titulo" title="Fechar">X</button></div>' +
    '<div class="corpo">' +
      '<div class="menubar-chat"><span>Arquivo</span><span>Editar</span><span>Pessoas</span></div>' +
      '<div class="historico"></div>' +
      '<div class="barra-fmt">' +
        '<button class="botao" data-f="b"><b>B</b></button>' +
        '<button class="botao" data-f="i"><i>I</i></button>' +
        '<button class="botao" data-f="u"><u>U</u></button>' +
      '</div>' +
      '<textarea maxlength="500" placeholder="Digite sua mensagem..."></textarea>' +
      '<div class="chat-rodape"><small>Enter envia · Shift+Enter quebra linha</small>' +
      '<button class="botao">Enviar</button></div>' +
    '</div>';
  $('janelas-chat').appendChild(j);
  arrastavel(j);

  const c = {
    janela: j, nome,
    hist: j.querySelector('.historico'),
    input: j.querySelector('textarea'),
    fmt: { b: false, i: false, u: false }
  };
  chats[chave] = c;

  const a = amigos.find(x => x.name.toLowerCase() === chave);
  if (a && !a.online) sistema(c, nome + ' está offline. Suas mensagens serão entregues quando ele(a) entrar.');
  else if (a && a.away) sistema(c, 'Mensagem de ausência de ' + nome + ': ' + a.away);

  j.querySelectorAll('.barra-fmt .botao').forEach(b => b.addEventListener('click', () => {
    c.fmt[b.dataset.f] = !c.fmt[b.dataset.f];
    b.classList.toggle('ativo');
    c.input.focus();
  }));

  async function enviar() {
    const texto = c.input.value.trim();
    if (!texto) return;
    c.input.value = '';
    try {
      const r = await api('send', { to: nome, text: texto, fmt: c.fmt });
      linha(c, eu, 'eu', formatar(texto, c.fmt));
      somEnvia();
      if (r.offline) sistema(c, nome + ' está offline. A mensagem será entregue quando ele(a) entrar.');
      else if (r.away) linha(c, nome + ' (resposta automática)', 'ele', esc(r.away));
    } catch (e) {
      sistema(c, 'Não enviada: ' + e.message);
    }
  }
  j.querySelector('.chat-rodape .botao').addEventListener('click', enviar);
  c.input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); }
  });
  j.querySelector('.btn-titulo').addEventListener('click', () => { j.remove(); delete chats[chave]; });
  j.addEventListener('mousedown', () => j.querySelector('.titulo').classList.remove('piscando'));

  if (!semFoco) c.input.focus();
  return c;
}

// ---------- Receber mensagens ----------
let piscaTimer = null;
function receber(m, antiga) {
  const c = abrirChat(m.from, true);
  if (antiga) sistema(c, 'Mensagem recebida enquanto você estava offline:');
  linha(c, m.from, 'ele', formatar(m.text, m.fmt), m.t);
  somRecebe();
  // pisca a barra de título e a aba do navegador
  c.janela.querySelector('.titulo').classList.add('piscando');
  if (document.hidden && !piscaTimer) {
    let alt = false;
    piscaTimer = setInterval(() => {
      document.title = (alt = !alt) ? '💬 ' + m.from + ' diz...' : 'BIM';
      if (!document.hidden) { clearInterval(piscaTimer); piscaTimer = null; document.title = 'BIM'; }
    }, 900);
  }
}

// ---------- Início ----------
if (token) {
  status('Reconectando...');
  conectar();
}
