'use strict';
const $ = id => document.getElementById(id);

// ---------- Estado ----------
let token = sessionStorage.getItem('cb_token') || '';
let eu = '';
let meu = { bio: '', avatar: '', theme: 'azul' };
let souAdmin = false;
let amigos = [];           // [{name, online, away, avatar, bio}]
let pedidos = [];          // pedidos de amizade recebidos
let bloqueados = [];       // nomes
let selecionado = '';
let es = null;             // EventSource
let somAtivo = true;
let modoCadastro = false;
let zTopo = 10;
const chats = {};          // chave -> chat
const janelas = {};        // id -> elemento (janelas extras)
const renders = {};        // id -> função que redesenha a janela
const gruposAbertos = { online: true, offline: true };

const TEMAS = [
  ['azul', '#1b5fd6', 'Azul'], ['rosa', '#ee5fa4', 'Rosa'], ['verde', '#2fa84a', 'Verde'],
  ['vermelho', '#d02a20', 'Vermelho'], ['laranja', '#f08a1c', 'Laranja'],
  ['preto', '#111111', 'Preto'], ['branco', '#f4f4f4', 'Branco']
];

// ---------- Tema de cor ----------
function aplicarTema(t) {
  if (!TEMAS.some(x => x[0] === t)) t = 'azul';
  document.body.className = 'tema-' + t;
  try { localStorage.setItem('bim_tema', t); } catch (e) {}
}
try { aplicarTema(localStorage.getItem('bim_tema') || 'azul'); } catch (e) {}

// ---------- Música de fundo ----------
const musica = $('musica');
musica.volume = 0.12; // bem baixinho
let musicaLigada = true;
try { musicaLigada = localStorage.getItem('bim_musica') !== 'off'; } catch (e) {}
function atualizarBtnMusica() {
  $('btn-musica').textContent = (musicaLigada && !musica.paused) ? '🎵' : '🔇';
}
function tocarMusica() {
  if (!musicaLigada) return;
  const p = musica.play();
  if (p && p.then) p.then(atualizarBtnMusica).catch(() => {});
}
// Navegadores só deixam tocar depois do primeiro toque/tecla
document.addEventListener('pointerdown', tocarMusica, { once: true });
document.addEventListener('keydown', tocarMusica, { once: true });
$('btn-musica').addEventListener('click', () => {
  musicaLigada = !musicaLigada;
  try { localStorage.setItem('bim_musica', musicaLigada ? 'on' : 'off'); } catch (e) {}
  if (musicaLigada) tocarMusica(); else musica.pause();
  atualizarBtnMusica();
});
musica.addEventListener('error', () => $('btn-musica').classList.add('escondido'));
musica.addEventListener('play', atualizarBtnMusica);
musica.addEventListener('pause', atualizarBtnMusica);

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
const somPorta    = () => tom([392, 523, 659, 784], 0.12, 'triangle');
const somPortaFim = () => tom([784, 523, 392], 0.12, 'triangle');
const somRecebe   = () => tom([988, 740, 988], 0.1);
const somEnvia    = () => tom([660], 0.07);

// ---------- Janelas arrastáveis ----------
let arrasto = null;
document.addEventListener('mousemove', e => {
  if (!arrasto) return;
  arrasto.j.style.left = Math.max(0, e.clientX - arrasto.ox) + 'px';
  arrasto.j.style.top  = Math.max(0, e.clientY - arrasto.oy) + 'px';
});
document.addEventListener('mouseup', () => { arrasto = null; });

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

// Janela extra genérica (perfil, pedidos, denúncias...)
function janela(id, titulo, largura) {
  if (janelas[id]) { janelas[id].style.zIndex = ++zTopo; return { nova: false }; }
  const n = Object.keys(janelas).length;
  const j = document.createElement('div');
  j.className = 'janela janela-extra';
  j.style.left = (300 + n * 26) + 'px';
  j.style.top = (50 + n * 26) + 'px';
  j.style.width = largura + 'px';
  j.style.zIndex = ++zTopo;
  j.innerHTML = '<div class="titulo"><span></span><button class="btn-titulo" title="Fechar">X</button></div><div class="corpo"></div>';
  j.querySelector('.titulo span').textContent = titulo;
  document.body.appendChild(j);
  arrastavel(j);
  janelas[id] = j;
  j.querySelector('.btn-titulo').addEventListener('click', () => fecharJanela(id));
  return { nova: true, j, corpo: j.querySelector('.corpo') };
}
function fecharJanela(id) {
  if (janelas[id]) { janelas[id].remove(); delete janelas[id]; }
  delete renders[id];
}
function atualizarJanelas() {
  ['pedidos', 'perfil'].forEach(k => { if (janelas[k] && renders[k]) renders[k](); });
}
function fecharTodasJanelas() { Object.keys(janelas).forEach(fecharJanela); }

function botao(texto, fn, extra) {
  const b = document.createElement('button');
  b.className = 'botao' + (extra ? ' ' + extra : '');
  b.type = 'button';
  b.textContent = texto;
  b.addEventListener('click', fn);
  return b;
}

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
    const err = new Error((dados && dados.erro) || MSG_SERVIDOR);
    if (dados && dados.codigo) err.codigo = true;
    throw err;
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
  if (!modoCadastro) $('linha-codigo').classList.add('escondido');
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
    const corpo = { user, pass };
    if (modoCadastro) corpo.codigo = $('f-codigo').value;
    const r = await api(modoCadastro ? 'register' : 'login', corpo);
    token = r.token;
    sessionStorage.setItem('cb_token', token);
    $('f-pass').value = ''; $('f-pass2').value = ''; $('f-codigo').value = '';
    conectar();
  } catch (e) {
    if (e.codigo) $('linha-codigo').classList.remove('escondido');
    status(e.message, true);
  }
  $('btn-principal').disabled = false;
}
$('btn-principal').addEventListener('click', enviarLogin);
['f-user', 'f-pass', 'f-pass2', 'f-codigo'].forEach(id =>
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') enviarLogin(); }));

function voltarAoLogin(msg, erro) {
  if (es) { es.close(); es = null; }
  token = ''; eu = ''; amigos = []; pedidos = []; bloqueados = []; selecionado = ''; souAdmin = false;
  sessionStorage.removeItem('cb_token');
  Object.keys(chats).forEach(k => { chats[k].janela.remove(); delete chats[k]; });
  fecharTodasJanelas();
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
    meu = { bio: d.bio || '', avatar: d.avatar || '', theme: d.theme || 'azul' };
    souAdmin = !!d.admin;
    amigos = d.buddies; pedidos = d.requests; bloqueados = d.blocked;
    aplicarTema(meu.theme);
    $('login-win').classList.add('escondido');
    $('lista-win').classList.remove('escondido');
    $('btn-denuncias').classList.toggle('escondido', !souAdmin);
    marcarDenuncias(d.abertas || 0);
    atualizarPerfilMini();
    desenharLista();
    atualizarBadgePedidos();
    somPorta();
    (d.unread || []).forEach(n => { const c = abrirChat(n, true); avisarNova(c); });
    if ((d.unread || []).length) somRecebe();
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
      atualizarContato(c);
      if (!antes.online && st.online) sistema(c, st.name + ' entrou.');
      if (antes.online && !st.online) sistema(c, st.name + ' saiu.');
    }
  });

  es.addEventListener('lists', e => aplicarListas(JSON.parse(e.data)));
  es.addEventListener('request', () => { somRecebe(); $('btn-pedidos').classList.add('destaque'); });
  es.addEventListener('msg', e => receber(JSON.parse(e.data)));

  es.addEventListener('renamed', e => {
    const d = JSON.parse(e.data);
    const velha = d.old.toLowerCase(), nova = d.name.toLowerCase();
    if (velha === eu.toLowerCase()) {
      eu = d.name;
      atualizarPerfilMini();
      return;
    }
    if (selecionado.toLowerCase() === velha) selecionado = d.name;
    const c = chats[velha];
    if (c && velha !== nova) {
      delete chats[velha]; chats[nova] = c;
      c.nome = d.name; c.chave = nova;
      c.janela.querySelector('.titulo-txt').textContent = d.name + ' - Mensagem Instantânea';
    } else if (c) {
      c.nome = d.name;
      c.janela.querySelector('.titulo-txt').textContent = d.name + ' - Mensagem Instantânea';
    }
    if (c) sistema(c, d.old + ' agora se chama ' + d.name + '.');
  });

  es.addEventListener('denuncia', e => { marcarDenuncias(JSON.parse(e.data).n); somRecebe(); if (janelas.denuncias && renders.denuncias) renders.denuncias(); });
  es.addEventListener('banned', () => voltarAoLogin('Sua conta foi suspensa.', true));

  es.onerror = () => {
    if (es && es.readyState === EventSource.CLOSED) {
      voltarAoLogin(iniciou ? 'Conexão perdida.' : 'Não foi possível conectar.', true);
    }
  };
}

function aplicarListas(l) {
  if (!l) return;
  amigos = l.buddies; pedidos = l.requests; bloqueados = l.blocked;
  desenharLista();
  atualizarBadgePedidos();
  atualizarJanelas();
  Object.values(chats).forEach(atualizarContato);
}

function atualizarPerfilMini() {
  $('meu-nome').textContent = eu;
  $('lista-titulo').textContent = 'Lista de Amigos de ' + eu;
  $('meu-avatar').innerHTML = meu.avatar ? '<img alt="" src="' + esc(meu.avatar) + '">' : '🙂';
  $('minha-bio').textContent = meu.bio || '';
}
function atualizarBadgePedidos() {
  $('btn-pedidos').textContent = '📨 Pedidos' + (pedidos.length ? ' (' + pedidos.length + ')' : '');
  $('btn-pedidos').classList.toggle('destaque', pedidos.length > 0);
}
function marcarDenuncias(n) {
  $('btn-denuncias').textContent = '🛡 Denúncias' + (n ? ' (' + n + ')' : '');
  $('btn-denuncias').classList.toggle('destaque', n > 0);
}

// ---------- Avatares ----------
function miniAv(av) {
  return av ? '<img class="mini-av" alt="" src="' + esc(av) + '">' : '<span class="mini-av">🙂</span>';
}
function avatarBox(av, cls) {
  return '<div class="avatar ' + (cls || '') + '">' + (av ? '<img alt="" src="' + esc(av) + '">' : '🙂') + '</div>';
}

// ---------- Lista de amigos ----------
function desenharLista() {
  const box = $('amigos');
  box.innerHTML = '';
  const ord = (a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });
  const on = amigos.filter(a => a.online).sort(ord);
  const off = amigos.filter(a => !a.online).sort(ord);

  if (!amigos.length) {
    box.innerHTML = '<div class="vazio">Sua lista está vazia. Clique em "Adicionar" e digite o nome de uma pessoa para enviar um pedido de amizade.</div>';
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
    l.innerHTML = '<span>' + miniAv(a.avatar) + esc(a.name) + (ausente ? ' (ausente)' : '') + '</span>';
    l.addEventListener('click', () => { selecionado = a.name; desenharLista(); });
    l.addEventListener('dblclick', () => abrirChat(a.name));
    box.appendChild(l);
  });
}

function exigirSelecionado() {
  if (!selecionado) { alert('Clique em um amigo da lista primeiro.'); return false; }
  return true;
}

// Ações de amizade
async function acaoBuddy(action, name) {
  const r = await api('buddy', { action, name });
  aplicarListas(r.listas);
  return r;
}
async function bloquear(nome, semConfirmar) {
  if (!semConfirmar && !confirm('Bloquear ' + nome + '? Essa pessoa não poderá mais te enviar mensagens nem pedidos de amizade.')) return;
  try {
    await acaoBuddy('block', nome);
    if (selecionado.toLowerCase() === nome.toLowerCase()) selecionado = '';
    desenharLista();
  } catch (e) { alert(e.message); }
}
async function denunciar(nome) {
  const motivo = prompt('Por que você está denunciando ' + nome + '?\n(A conversa de vocês será enviada para a administradora avaliar.)');
  if (motivo === null) return;
  if (!motivo.trim()) return alert('Escreva o motivo da denúncia.');
  try {
    await api('report', { name: nome, motivo: motivo.trim() });
    alert('Denúncia enviada. Obrigada por avisar!');
    if (amigos.some(a => a.name.toLowerCase() === nome.toLowerCase()) &&
        confirm('Quer bloquear ' + nome + ' também?')) bloquear(nome, true);
  } catch (e) { alert(e.message); }
}

$('btn-add').addEventListener('click', async () => {
  const nome = (prompt('Nome de quem você quer adicionar:') || '').trim();
  if (!nome) return;
  try {
    const r = await acaoBuddy('add', nome);
    alert(r.msg || 'Pedido enviado!');
  } catch (e) { alert(e.message); }
});
$('btn-del').addEventListener('click', async () => {
  if (!exigirSelecionado()) return;
  if (!confirm('Remover ' + selecionado + ' da sua lista?')) return;
  try { await acaoBuddy('remove', selecionado); selecionado = ''; desenharLista(); }
  catch (e) { alert(e.message); }
});
$('btn-bloq').addEventListener('click', () => { if (exigirSelecionado()) bloquear(selecionado); });
$('btn-denun').addEventListener('click', () => { if (exigirSelecionado()) denunciar(selecionado); });
$('btn-ver').addEventListener('click', () => { if (exigirSelecionado()) verPerfil(selecionado); });
$('btn-pedidos').addEventListener('click', abrirPedidos);
$('btn-perfil').addEventListener('click', abrirMeuPerfil);
$('btn-denuncias').addEventListener('click', abrirDenuncias);

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

// ---------- Janela: pedidos de amizade ----------
function abrirPedidos() {
  $('btn-pedidos').classList.remove('destaque');
  const w = janela('pedidos', 'Pedidos de amizade', 300);
  if (!w.nova) return;
  renders.pedidos = () => {
    w.corpo.innerHTML = '';
    if (!pedidos.length) {
      w.corpo.innerHTML = '<div class="vazio">Nenhum pedido pendente.</div>';
      return;
    }
    pedidos.forEach(p => {
      const item = document.createElement('div');
      item.className = 'pedido';
      item.innerHTML = '<div class="pedido-topo">' + avatarBox(p.avatar) +
        '<div><b>' + esc(p.name) + '</b> quer ser seu amigo<br><small>' + esc(p.bio || '') + '</small></div></div>';
      const bt = document.createElement('div');
      bt.className = 'pedido-btns';
      const tentar = fn => async () => { try { await fn(); } catch (e) { alert(e.message); } };
      bt.appendChild(botao('✔ Aceitar', tentar(() => acaoBuddy('accept', p.name))));
      bt.appendChild(botao('✖ Recusar', tentar(() => acaoBuddy('decline', p.name))));
      bt.appendChild(botao('🚫 Bloquear', tentar(() => acaoBuddy('block', p.name))));
      bt.appendChild(botao('🚩 Denunciar', () => denunciar(p.name)));
      item.appendChild(bt);
      w.corpo.appendChild(item);
    });
  };
  renders.pedidos();
}

// ---------- Janela: ver perfil de outra pessoa ----------
async function verPerfil(nome) {
  try {
    const p = await api('perfil', { name: nome });
    const w = janela('ver-' + p.name.toLowerCase(), 'Perfil de ' + p.name, 260);
    if (!w.nova) return;
    w.corpo.innerHTML = '<div class="ver-perfil">' + avatarBox(p.avatar, 'grande') +
      '<b>' + esc(p.name) + '</b><small>' + (p.online ? 'Online' : 'Offline') + '</small>' +
      '<div class="ver-bio">' + (p.bio ? esc(p.bio) : 'Sem bio.') + '</div></div>';
  } catch (e) { alert(e.message); }
}

// ---------- Janela: meu perfil ----------
function redimensionar(arquivo) {
  return new Promise((ok, erro) => {
    const url = URL.createObjectURL(arquivo);
    const img = new Image();
    img.onload = () => {
      const T = 96;
      const cv = document.createElement('canvas');
      cv.width = cv.height = T;
      const lado = Math.min(img.width, img.height);
      cv.getContext('2d').drawImage(img, (img.width - lado) / 2, (img.height - lado) / 2, lado, lado, 0, 0, T, T);
      URL.revokeObjectURL(url);
      ok(cv.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); erro(new Error('Não consegui ler essa imagem.')); };
    img.src = url;
  });
}

function abrirMeuPerfil() {
  const w = janela('perfil', 'Meu perfil', 310);
  if (!w.nova) return;
  const c = w.corpo;
  let novoAvatar = meu.avatar;
  c.innerHTML =
    '<div class="perfil-edit"><div id="pf-av"></div><div class="perfil-edit-btns"></div></div>' +
    '<input type="file" accept="image/*" class="escondido" id="pf-file">' +
    '<label>Nome de usuário</label><input class="entrada" id="pf-nome" maxlength="16" spellcheck="false">' +
    '<label>Bio</label><textarea id="pf-bio" maxlength="150" rows="3" placeholder="Fale um pouco sobre você..."></textarea>' +
    '<label>Cor do site</label><div class="cores" id="pf-cores"></div>' +
    '<label>Pessoas bloqueadas</label><div class="entrada-inset bloq-lista" id="pf-bloq"></div>' +
    '<div class="botoes-login"><button class="botao" id="pf-salvar">Salvar</button></div>' +
    '<div class="status-login" id="pf-status"></div>';
  const q = id => c.querySelector('#' + id);
  const st = (m, erro) => { q('pf-status').textContent = m || ''; q('pf-status').className = 'status-login' + (erro ? ' erro' : ''); };
  const desenharAv = () => { q('pf-av').innerHTML = avatarBox(novoAvatar, 'grande'); };
  desenharAv();
  q('pf-nome').value = eu;
  q('pf-bio').value = meu.bio;

  const bt = c.querySelector('.perfil-edit-btns');
  bt.appendChild(botao('📷 Trocar foto', () => q('pf-file').click()));
  bt.appendChild(botao('Remover foto', () => { novoAvatar = ''; desenharAv(); }));
  q('pf-file').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try { novoAvatar = await redimensionar(f); desenharAv(); st(''); }
    catch (err) { st(err.message, true); }
    e.target.value = '';
  });

  // Cores
  const cores = q('pf-cores');
  const marcarCor = () => cores.querySelectorAll('.cor').forEach(b => b.classList.toggle('ativa', b.dataset.t === meu.theme));
  TEMAS.forEach(([id, cor, nome]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'cor'; b.dataset.t = id; b.title = nome;
    b.style.background = cor;
    b.addEventListener('click', async () => {
      const antes = meu.theme;
      meu.theme = id; aplicarTema(id); marcarCor();
      try { await api('salvar-perfil', { theme: id }); }
      catch (err) { meu.theme = antes; aplicarTema(antes); marcarCor(); st(err.message, true); }
    });
    cores.appendChild(b);
  });
  marcarCor();

  // Bloqueados
  renders.perfil = () => {
    const box = q('pf-bloq');
    box.innerHTML = '';
    if (!bloqueados.length) { box.innerHTML = '<div class="vazio">Ninguém bloqueado.</div>'; return; }
    bloqueados.forEach(n => {
      const l = document.createElement('div');
      l.className = 'item-linha';
      const s = document.createElement('span'); s.textContent = n;
      l.appendChild(s);
      l.appendChild(botao('Desbloquear', async () => { try { await acaoBuddy('unblock', n); } catch (err) { st(err.message, true); } }));
      box.appendChild(l);
    });
  };
  renders.perfil();

  q('pf-salvar').addEventListener('click', async () => {
    st('Salvando...');
    try {
      const nome = q('pf-nome').value.trim();
      if (nome && nome !== eu) { const r = await api('renomear', { name: nome }); eu = r.name; }
      await api('salvar-perfil', { bio: q('pf-bio').value, avatar: novoAvatar });
      meu.bio = q('pf-bio').value.trim().slice(0, 150);
      meu.avatar = novoAvatar;
      atualizarPerfilMini();
      st('Perfil salvo!');
    } catch (err) { st(err.message, true); }
  });
}

// ---------- Janela: denúncias (somente administradora) ----------
function abrirDenuncias() {
  const w = janela('denuncias', 'Denúncias (administradora)', 400);
  if (!w.nova) return;
  w.j.querySelector('.corpo').style.maxHeight = '70vh';
  renders.denuncias = async () => {
    try {
      const d = await api('admin-denuncias');
      marcarDenuncias(d.abertas);
      w.corpo.innerHTML = '';
      if (!d.reports.length) { w.corpo.innerHTML = '<div class="vazio">Nenhuma denúncia.</div>'; return; }
      d.reports.forEach(r => {
        const it = document.createElement('div');
        it.className = 'denuncia' + (r.status !== 'aberta' ? ' fechada' : '');
        it.innerHTML = '<div><b>#' + r.id + '</b> ' + esc(r.de) + ' denunciou <b>' + esc(r.alvo) + '</b></div>' +
          '<small>' + new Date(r.t).toLocaleString('pt-BR') + ' · ' + esc(r.status) + (r.banido ? ' · conta suspensa' : '') + '</small>' +
          '<div>Motivo: ' + esc(r.motivo) + '</div>';
        const conv = document.createElement('div');
        conv.className = 'conversa escondido';
        if (!r.conversa.length) conv.textContent = '(sem mensagens salvas)';
        r.conversa.forEach(m => {
          const l = document.createElement('div');
          l.innerHTML = '<b>' + esc(m.from) + '</b> (' + hora(m.t) + '): ' + esc(m.text);
          conv.appendChild(l);
        });
        const bt = document.createElement('div');
        bt.className = 'pedido-btns';
        bt.appendChild(botao('💬 Ler conversa', () => conv.classList.toggle('escondido')));
        const agir = async acao => { try { await api('admin-resolver', { id: r.id, acao }); renders.denuncias(); } catch (e) { alert(e.message); } };
        if (r.status === 'aberta') bt.appendChild(botao('Arquivar', () => agir('arquivar')));
        if (r.banido) bt.appendChild(botao('Desbanir', () => agir('desbanir')));
        else bt.appendChild(botao('Banir', () => { if (confirm('Suspender a conta de ' + r.alvo + '?')) agir('banir'); }));
        it.appendChild(bt);
        it.appendChild(conv);
        w.corpo.appendChild(it);
      });
    } catch (e) { w.corpo.textContent = e.message; }
  };
  renders.denuncias();
}

// ---------- Emoticons estilo MSN (desenhados em SVG) ----------
const OLHOS = "<ellipse cx='8.3' cy='9.3' rx='1.3' ry='2' fill='#222'/><ellipse cx='15.7' cy='9.3' rx='1.3' ry='2' fill='#222'/>";
const SORRISO = "<path d='M6.5 14 Q12 20.5 17.5 14' fill='none' stroke='#222' stroke-width='1.6' stroke-linecap='round'/>";
const TRISTE = "<path d='M7 18 Q12 12.5 17 18' fill='none' stroke='#222' stroke-width='1.6' stroke-linecap='round'/>";
function rosto(extra, c) {
  c = c || ['#fffbb0', '#ffd91a', '#e09b00', '#a66a00'];
  return "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><defs><radialGradient id='g' cx='38%' cy='30%' r='80%'>" +
    "<stop offset='0' stop-color='" + c[0] + "'/><stop offset='.55' stop-color='" + c[1] + "'/><stop offset='1' stop-color='" + c[2] + "'/></radialGradient></defs>" +
    "<circle cx='12' cy='12' r='10.8' fill='url(#g)' stroke='" + c[3] + "' stroke-width='1'/>" +
    "<ellipse cx='9' cy='5.5' rx='4.5' ry='2.2' fill='#fff' opacity='.35'/>" + extra + "</svg>";
}
const EMO_SVG = {
  ':)': rosto(OLHOS + SORRISO),
  ':(': rosto(OLHOS + TRISTE),
  ':D': rosto(OLHOS + "<path d='M6 13 Q12 22.5 18 13 Z' fill='#7a1010' stroke='#222' stroke-width='1.2' stroke-linejoin='round'/><path d='M7.6 13.8 Q12 15.6 16.4 13.8' fill='none' stroke='#fff' stroke-width='1.8'/>"),
  ';)': rosto("<ellipse cx='8.3' cy='9.3' rx='1.3' ry='2' fill='#222'/><path d='M13.8 9.8 Q15.7 7.8 17.6 9.8' fill='none' stroke='#222' stroke-width='1.7' stroke-linecap='round'/>" + SORRISO),
  ':P': rosto(OLHOS + "<path d='M6.8 14 Q12 17.5 17.2 14' fill='none' stroke='#222' stroke-width='1.6' stroke-linecap='round'/><path d='M10 15.8 Q9.8 21 13.2 20.6 Q15 20 14.4 15.6' fill='#ff6f91' stroke='#b0184f' stroke-width='.9'/>"),
  ':O': rosto(OLHOS + "<ellipse cx='12' cy='16.6' rx='2.5' ry='3' fill='#7a1010' stroke='#222' stroke-width='1'/>"),
  ":'(": rosto(OLHOS + TRISTE + "<path d='M7.4 12 Q5.6 15 6.8 17.6' fill='none' stroke='#2f8fff' stroke-width='1.8' stroke-linecap='round'/><path d='M16.6 12 Q18.4 15 17.2 17.6' fill='none' stroke='#2f8fff' stroke-width='1.8' stroke-linecap='round'/>"),
  '(H)': rosto("<rect x='3.6' y='7' width='7.6' height='5' rx='1.8' fill='#111'/><rect x='12.8' y='7' width='7.6' height='5' rx='1.8' fill='#111'/><path d='M11 8.6 H13' stroke='#111' stroke-width='1.4'/><path d='M4.8 8.3 L8 8.3' stroke='#999' stroke-width='.8'/>" + SORRISO),
  ':@': rosto("<path d='M5.3 6.3 L10.6 8.8' stroke='#222' stroke-width='1.9' stroke-linecap='round'/><path d='M18.7 6.3 L13.4 8.8' stroke='#222' stroke-width='1.9' stroke-linecap='round'/><ellipse cx='8.6' cy='10.8' rx='1.1' ry='1.4' fill='#222'/><ellipse cx='15.4' cy='10.8' rx='1.1' ry='1.4' fill='#222'/><path d='M7.5 18.2 Q12 13.6 16.5 18.2' fill='none' stroke='#222' stroke-width='1.7' stroke-linecap='round'/>", ['#ffc4b0', '#ff5a2a', '#c01800', '#7a0f00']),
  ':|': rosto(OLHOS + "<path d='M7.5 16 H16.5' fill='none' stroke='#222' stroke-width='1.7' stroke-linecap='round'/>"),
  '<3': "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><defs><radialGradient id='h' cx='35%' cy='30%' r='80%'><stop offset='0' stop-color='#ff9aa8'/><stop offset='.5' stop-color='#e8112d'/><stop offset='1' stop-color='#a00018'/></radialGradient></defs><path d='M12 21.5 C4 15 1.8 10.5 1.8 7.6 C1.8 4.7 4.1 3 6.5 3 C8.9 3 10.9 4.4 12 6.4 C13.1 4.4 15.1 3 17.5 3 C19.9 3 22.2 4.7 22.2 7.6 C22.2 10.5 20 15 12 21.5 Z' fill='url(#h)' stroke='#8a0010' stroke-width='1'/><ellipse cx='7.6' cy='7' rx='2.2' ry='1.3' fill='#fff' opacity='.45'/></svg>"
};
const EMO_URL = {};
Object.keys(EMO_SVG).forEach(k => { EMO_URL[k] = 'data:image/svg+xml,' + encodeURIComponent(EMO_SVG[k]); });
const EMO_CODIGOS = Object.keys(EMO_SVG).sort((a, b) => b.length - a.length);
const RE_EMO = new RegExp(EMO_CODIGOS.map(k => esc(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
function emoImg(k) {
  return '<img class="emo" src="' + EMO_URL[k] + '" alt="' + esc(k) + '" title="' + esc(k) + '">';
}

// ---------- Conversa ----------
function esc(t) {
  return String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function hora(t) {
  const d = new Date(t || Date.now());
  const hoje = new Date();
  const h = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === hoje.toDateString()) return h;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + h;
}
function formatar(texto, fmt) {
  let h = esc(texto).replace(RE_EMO, m => {
    const k = EMO_CODIGOS.find(c => esc(c).toLowerCase() === m.toLowerCase());
    return k ? emoImg(k) : m;
  });
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
function mostrar(c, m) {
  const chave = m.t + '|' + m.from.toLowerCase() + '|' + m.text;
  if (c.vistos.has(chave)) return;
  c.vistos.add(chave);
  const meuNome = m.from.toLowerCase() === eu.toLowerCase();
  const d = document.createElement('div');
  d.className = 'msg';
  d.innerHTML = '<span class="' + (meuNome ? 'eu' : 'ele') + '">' + esc(m.from) + '</span> (' + hora(m.t) + '): ' + formatar(m.text, m.fmt);
  c.hist.appendChild(d);
  c.hist.scrollTop = c.hist.scrollHeight;
}
function atualizarContato(c) {
  const a = amigos.find(x => x.name.toLowerCase() === c.chave);
  c.contato.innerHTML = miniAv(a && a.avatar) + '<b>' + esc(c.nome) + '</b>' + (a && a.bio ? ' <small>' + esc(a.bio) + '</small>' : '');
}
function fecharPops() {
  document.querySelectorAll('.menu-pop, .emo-pop').forEach(p => p.classList.add('escondido'));
}
document.addEventListener('click', fecharPops);

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
    '<div class="titulo"><span class="titulo-txt"></span>' +
    '<button class="btn-titulo" title="Fechar">X</button></div>' +
    '<div class="corpo">' +
      '<div class="menubar-chat"><span>Arquivo</span><span>Editar</span><span class="menu-pessoas">Pessoas ▾</span>' +
        '<div class="menu-pop escondido"></div></div>' +
      '<div class="contato"></div>' +
      '<div class="historico"></div>' +
      '<div class="barra-fmt">' +
        '<button class="botao" data-f="b"><b>B</b></button>' +
        '<button class="botao" data-f="i"><i>I</i></button>' +
        '<button class="botao" data-f="u"><u>U</u></button>' +
        '<button class="botao" data-emo title="Emoticons">' + emoImg(':)') + '</button>' +
      '</div>' +
      '<textarea maxlength="500" placeholder="Digite sua mensagem..." disabled></textarea>' +
      '<div class="chat-rodape"><small>Enter envia · Shift+Enter quebra linha</small>' +
      '<button class="botao" data-enviar>Enviar</button></div>' +
    '</div>' +
    '<div class="emo-pop escondido"></div>';
  j.querySelector('.titulo-txt').textContent = nome + ' - Mensagem Instantânea';
  $('janelas-chat').appendChild(j);
  arrastavel(j);

  const c = {
    janela: j, nome, chave,
    hist: j.querySelector('.historico'),
    input: j.querySelector('textarea'),
    contato: j.querySelector('.contato'),
    fmt: { b: false, i: false, u: false },
    vistos: new Set(), fila: [], pronto: false
  };
  chats[chave] = c;
  atualizarContato(c);

  // Menu "Pessoas"
  const menu = j.querySelector('.menu-pop');
  [['👁 Ver perfil', () => verPerfil(c.nome)], ['🚩 Denunciar', () => denunciar(c.nome)], ['🚫 Bloquear', () => bloquear(c.nome)]]
    .forEach(([t, fn]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = t;
      b.addEventListener('click', fn);
      menu.appendChild(b);
    });
  j.querySelector('.menu-pessoas').addEventListener('click', e => {
    e.stopPropagation();
    const abrir = menu.classList.contains('escondido');
    fecharPops();
    if (abrir) menu.classList.remove('escondido');
  });

  // Emoticons
  const pop = j.querySelector('.emo-pop');
  EMO_CODIGOS.slice().sort((a, b) => Object.keys(EMO_SVG).indexOf(a) - Object.keys(EMO_SVG).indexOf(b)).forEach(k => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'emo-btn'; b.title = k;
    b.innerHTML = emoImg(k);
    b.addEventListener('click', () => {
      const i = c.input.selectionStart || 0;
      const fim = c.input.selectionEnd || i;
      const t = k + ' ';
      c.input.value = c.input.value.slice(0, i) + t + c.input.value.slice(fim);
      c.input.focus();
      c.input.setSelectionRange(i + t.length, i + t.length);
    });
    pop.appendChild(b);
  });
  j.querySelector('[data-emo]').addEventListener('click', e => {
    e.stopPropagation();
    const abrir = pop.classList.contains('escondido');
    fecharPops();
    if (abrir) pop.classList.remove('escondido');
  });

  j.querySelectorAll('.barra-fmt .botao[data-f]').forEach(b => b.addEventListener('click', () => {
    c.fmt[b.dataset.f] = !c.fmt[b.dataset.f];
    b.classList.toggle('ativo');
    c.input.focus();
  }));

  // Histórico salvo no servidor
  api('history', { with: nome }).then(r => {
    if (r.msgs.length) sistema(c, '— Mensagens anteriores —');
    r.msgs.forEach(m => mostrar(c, m));
    if (r.msgs.length) sistema(c, '— Agora —');
  }).catch(e => {
    sistema(c, 'Não consegui carregar o histórico: ' + e.message);
  }).then(() => {
    c.pronto = true;
    c.fila.forEach(m => mostrar(c, m));
    c.fila = [];
    const a = amigos.find(x => x.name.toLowerCase() === chave);
    if (a && !a.online) sistema(c, nome + ' está offline. Suas mensagens serão entregues quando ele(a) entrar.');
    else if (a && a.away) sistema(c, 'Mensagem de ausência de ' + nome + ': ' + a.away);
    c.input.disabled = false;
    if (!semFoco) c.input.focus();
  });

  async function enviar() {
    const texto = c.input.value.trim();
    if (!texto || !c.pronto) return;
    c.input.value = '';
    try {
      const r = await api('send', { to: c.nome, text: texto, fmt: c.fmt });
      mostrar(c, r.msg);
      somEnvia();
      if (r.offline) sistema(c, c.nome + ' está offline. A mensagem será entregue quando ele(a) entrar.');
      else if (r.away) {
        const d = document.createElement('div');
        d.className = 'msg';
        d.innerHTML = '<span class="ele">' + esc(c.nome) + ' (resposta automática)</span> (' + hora() + '): ' + esc(r.away);
        c.hist.appendChild(d);
        c.hist.scrollTop = c.hist.scrollHeight;
      }
    } catch (e) {
      sistema(c, 'Não enviada: ' + e.message);
    }
  }
  j.querySelector('[data-enviar]').addEventListener('click', enviar);
  c.input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); }
  });
  j.querySelector('.btn-titulo').addEventListener('click', () => { j.remove(); delete chats[c.chave]; });
  j.addEventListener('mousedown', () => j.querySelector('.titulo').classList.remove('piscando'));

  return c;
}

// ---------- Receber mensagens ----------
let piscaTimer = null;
function avisarNova(c) {
  c.janela.querySelector('.titulo').classList.add('piscando');
}
function receber(m) {
  const c = abrirChat(m.from, true);
  if (c.pronto) mostrar(c, m); else c.fila.push(m);
  somRecebe();
  avisarNova(c);
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
