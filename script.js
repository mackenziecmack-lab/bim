'use strict';
const $ = id => document.getElementById(id);

// ---------- Estado ----------
const lerToken = () => { try { return localStorage.getItem('cb_token') || sessionStorage.getItem('cb_token') || ''; } catch (e) { return ''; } };
const guardarToken = t => {
  try {
    if (t) localStorage.setItem('cb_token', t);
    else { localStorage.removeItem('cb_token'); sessionStorage.removeItem('cb_token'); }
  } catch (e) {}
};
let token = lerToken();   // fica salvo no aparelho: fechar a aba não desloga
let eu = '';
let meu = { bio: '', avatar: '', theme: 'azul' };
let souAdmin = false;
let amigos = [];           // [{name, online, away, avatar, bio}]
let pedidos = [];          // pedidos de amizade recebidos
let bloqueados = [];       // nomes
let grupos = [];           // [{id, name, dono, members:[{name,avatar,online,admin}]}]
let selecionado = '';
let es = null;             // EventSource
let somAtivo = true;
let modoCadastro = false;
let zTopo = 10;
const chats = {};          // chave -> chat
const janelas = {};        // id -> elemento (janelas extras)
const renders = {};        // id -> função que redesenha a janela
const gruposAbertos = { online: true, offline: true, grupos: true };
let naoLidas = {};         // chave da conversa -> quantidade de mensagens novas
let jaIniciou = false;
let tentativasRec = 0, recTimer = null, ocultoDesde = 0;

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
  Object.keys(renders).forEach(k => {
    if (janelas[k] && (k === 'pedidos' || k === 'perfil' || k.startsWith('grupo-'))) renders[k]();
  });
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
  'Sem conexão com o servidor. Se ele estava dormindo, espere cerca de 1 minuto e tente de novo.';

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
    guardarToken(token);
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
  token = ''; eu = ''; amigos = []; pedidos = []; bloqueados = []; grupos = []; selecionado = ''; souAdmin = false;
  guardarToken('');
  Object.keys(chats).forEach(k => { chats[k].janela.remove(); delete chats[k]; });
  fecharTodasJanelas();
  clearTimeout(recTimer); tentativasRec = 0; jaIniciou = false; naoLidas = {};
  Object.keys(toasts).forEach(removerToast);
  $('lista-win').classList.add('escondido');
  $('login-win').classList.remove('escondido');
  document.title = 'BIM';
  status(msg || '', erro);
}

// ---------- Conexão em tempo real ----------
function mostrarReconectando(sim) {
  if (!eu) { status(sim ? 'Conectando... (se o servidor estava dormindo, pode levar até 1 minuto)' : ''); return; }
  $('lista-titulo').textContent = sim ? 'Reconectando...' : 'Lista de Amigos de ' + eu;
}
function agendarReconexao() {
  clearTimeout(recTimer);
  const espera = Math.min(30000, 2000 * Math.pow(2, Math.min(tentativasRec, 4)));
  tentativasRec++;
  recTimer = setTimeout(async () => {
    if (!token) return;
    try {
      const r = await fetch('/api/sessao?token=' + encodeURIComponent(token));
      if (r.status === 401) return voltarAoLogin('Sessão expirada. Entre novamente.', true);
    } catch (e) {}
    if (token) conectar();
  }, espera);
}
// Ao voltar para o site depois de um tempo, garante que a conexão está viva
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { ocultoDesde = Date.now(); return; }
  if (!token) return;
  const faz = ocultoDesde && Date.now() - ocultoDesde > 30000;
  if (!es || es.readyState !== EventSource.OPEN || faz) conectar();
});

function conectar() {
  clearTimeout(recTimer);
  if (es) es.close();
  let iniciou = false;
  es = new EventSource('/api/stream?token=' + encodeURIComponent(token));

  es.addEventListener('init', e => {
    iniciou = true;
    tentativasRec = 0;
    const d = JSON.parse(e.data);
    eu = d.me;
    carregarNaoLidas();
    meu = { bio: d.bio || '', avatar: d.avatar || '', theme: d.theme || 'azul' };
    souAdmin = !!d.admin;
    amigos = d.buddies; pedidos = d.requests; bloqueados = d.blocked; grupos = d.groups || [];
    aplicarTema(meu.theme);
    $('login-win').classList.add('escondido');
    $('lista-win').classList.remove('escondido');
    $('btn-denuncias').classList.toggle('escondido', !souAdmin);
    marcarDenuncias(d.abertas || 0);
    atualizarPerfilMini();
    desenharLista();
    atualizarBadgePedidos();
    if (!jaIniciou) somPorta();
    jaIniciou = true;
    // Mensagens que chegaram enquanto você estava fora viram avisos (nada abre sozinho)
    const contagem = {};
    (d.unread || []).forEach(n => {
      const k = n[0] === '#' ? 'g:' + n.slice(1) : n.toLowerCase();
      if (!chats[k]) contagem[k] = (contagem[k] || 0) + 1;
    });
    const novos = Object.keys(contagem);
    novos.forEach(k => { naoLidas[k] = (naoLidas[k] || 0) + contagem[k]; });
    if (novos.length) {
      salvarNaoLidas();
      somRecebe();
      const quem = novos.map(nomeDeChave).join(', ');
      mostrarToast('resumo', '💬 Mensagens novas', '', 'De: ' + quem, null);
      notificacaoSistema('BIM - mensagens novas', 'De: ' + quem);
    }
    desenharLista();
    atualizarTituloAba();
    Object.values(chats).forEach(recarregarHistorico);
    if ('Notification' in window && Notification.permission === 'default') {
      document.addEventListener('pointerdown', () => {
        try { if (Notification.permission === 'default') Notification.requestPermission(); } catch (err) {}
      }, { once: true });
    }
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
  es.addEventListener('gmsg', e => receberGrupo(JSON.parse(e.data)));
  es.addEventListener('groups', e => aplicarGrupos(JSON.parse(e.data)));

  es.addEventListener('renamed', e => {
    const d = JSON.parse(e.data);
    const velha = d.old.toLowerCase(), nova = d.name.toLowerCase();
    if (velha === eu.toLowerCase()) {
      eu = d.name;
      atualizarPerfilMini();
      return;
    }
    if (selecionado.toLowerCase() === velha) selecionado = d.name;
    if (naoLidas[velha] && velha !== nova) { naoLidas[nova] = naoLidas[velha]; delete naoLidas[velha]; salvarNaoLidas(); }
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
    if (!es) return;
    mostrarReconectando(true);
    if (es.readyState !== EventSource.CLOSED) return;  // o navegador tenta sozinho
    es.close();
    agendarReconexao();  // servidor acordando ou sem internet: tenta de novo, sem deslogar
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

function aplicarGrupos(l) {
  grupos = l || [];
  desenharLista();
  atualizarJanelas();
  Object.keys(chats).forEach(k => {
    const c = chats[k];
    if (!c.grupo) return;
    if (!grupos.some(g => g.id === c.id)) { c.janela.remove(); delete chats[k]; }
    else atualizarContato(c);
  });
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
  } else {
    grupo(box, 'online', 'Amigos Online (' + on.length + '/' + amigos.length + ')', on);
    grupo(box, 'offline', 'Offline (' + off.length + '/' + amigos.length + ')', off);
  }
  secaoGrupos(box);
}
function badgeNL(k) {
  return naoLidas[k] ? '<span class="badge-nl">' + naoLidas[k] + '</span>' : '';
}
function secaoGrupos(box) {
  const t = document.createElement('div');
  t.className = 'grupo-titulo';
  t.textContent = (gruposAbertos.grupos ? '▼ ' : '▶ ') + 'Grupos (' + grupos.length + ')';
  t.addEventListener('click', () => { gruposAbertos.grupos = !gruposAbertos.grupos; desenharLista(); });
  box.appendChild(t);
  if (!gruposAbertos.grupos) return;
  if (!grupos.length) {
    const v = document.createElement('div');
    v.className = 'vazio';
    v.textContent = 'Nenhum grupo ainda. Toque em "👥 Novo grupo" para criar um.';
    box.appendChild(v);
    return;
  }
  grupos.slice().sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })).forEach(g => {
    const l = document.createElement('div');
    l.className = 'amigo' + (naoLidas['g:' + g.id] ? ' nova' : '');
    l.innerHTML = '<span><span class="mini-av">👥</span>' + esc(g.name) + ' (' + g.members.length + ')</span>' + badgeNL('g:' + g.id);
    l.addEventListener('click', () => abrirGrupo(g.id));
    box.appendChild(l);
  });
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
      (a.name.toLowerCase() === selecionado.toLowerCase() ? ' sel' : '') +
      (naoLidas[a.name.toLowerCase()] ? ' nova' : '');
    const ausente = a.online && a.away;
    l.innerHTML = '<span>' + miniAv(a.avatar) + esc(a.name) + (ausente ? ' (ausente)' : '') + '</span>' + badgeNL(a.name.toLowerCase());
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
async function denunciar(nome, grupoId) {
  const motivo = prompt('Por que você está denunciando ' + nome + '?\n(A conversa de vocês será enviada para a administradora avaliar.)');
  if (motivo === null) return;
  if (!motivo.trim()) return alert('Escreva o motivo da denúncia.');
  try {
    await api('report', { name: nome, motivo: motivo.trim(), grupo: grupoId });
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
$('btn-grupo').addEventListener('click', abrirNovoGrupo);
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
        it.innerHTML = '<div><b>#' + r.id + '</b> ' + esc(r.de) + ' denunciou <b>' + esc(r.alvo) + '</b>' + (r.grupo ? ' (no grupo ' + esc(r.grupo) + ')' : '') + '</div>' +
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
// ---------- Mais emoticons (mesmo estilo brilhante dos de cima) ----------
const SVGW = (defs, corpo) => "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>" + (defs ? '<defs>' + defs + '</defs>' : '') + corpo + '</svg>';
const GRAD = (id, cores, v) => v
  ? "<linearGradient id='" + id + "' x1='0' y1='0' x2='0' y2='1'>" + cores.map((c, i) => "<stop offset='" + (i / (cores.length - 1)) + "' stop-color='" + c + "'/>").join('') + '</linearGradient>'
  : "<radialGradient id='" + id + "' cx='38%' cy='30%' r='80%'>" + cores.map((c, i) => "<stop offset='" + (i / (cores.length - 1)) + "' stop-color='" + c + "'/>").join('') + '</radialGradient>';
const TRACO = (d, cor, w) => "<path d='" + d + "' fill='none' stroke='" + (cor || '#222') + "' stroke-width='" + (w || 1.6) + "' stroke-linecap='round' stroke-linejoin='round'/>";
const CORACAO = "M12 21.5 C4 15 1.8 10.5 1.8 7.6 C1.8 4.7 4.1 3 6.5 3 C8.9 3 10.9 4.4 12 6.4 C13.1 4.4 15.1 3 17.5 3 C19.9 3 22.2 4.7 22.2 7.6 C22.2 10.5 20 15 12 21.5 Z";
const AMARELO = GRAD('y', ['#fffbb0', '#ffd91a', '#e09b00']);
const BOCA_ABERTA = "<path d='M6 13.2 Q12 23 18 13.2 Z' fill='#7a1010' stroke='#222' stroke-width='1.2' stroke-linejoin='round'/><path d='M7.4 14 Q12 15.8 16.6 14' fill='none' stroke='#fff' stroke-width='1.8'/>";
const LAGRIMA = (d) => "<path d='" + d + "' fill='#4aa3ff' stroke='#1c6fc9' stroke-width='.6'/>";
const MINI_CORACAO = (tr) => "<path transform='" + tr + "' d='M8.3 12 C5.3 9.8 5.6 7.2 7.4 7.2 C8 7.2 8.3 7.6 8.3 8 C8.3 7.6 8.6 7.2 9.2 7.2 C11 7.2 11.3 9.8 8.3 12Z' fill='#e8112d' stroke='#8a0010' stroke-width='.5'/>";
const RAIOS = [0, 1, 2, 3, 4, 5, 6, 7].map(i => { const a = i * Math.PI / 4, c = Math.cos(a), s = Math.sin(a); return TRACO('M' + (12 + 7.6 * c).toFixed(2) + ' ' + (12 + 7.6 * s).toFixed(2) + ' L' + (12 + 10.6 * c).toFixed(2) + ' ' + (12 + 10.6 * s).toFixed(2), '#ffb000', 1.9); }).join('');

Object.assign(EMO_SVG, {
  // ----- carinhas -----
  '(lol)': rosto(TRACO('M5.2 10.2 Q8.2 6.4 11.2 10.2', '#222', 1.7) + TRACO('M12.8 10.2 Q15.8 6.4 18.8 10.2', '#222', 1.7) + BOCA_ABERTA +
    LAGRIMA('M4.6 11.5 Q2.4 13 3.6 15.8 Q5.8 14.8 5.4 12.2Z') + LAGRIMA('M19.4 11.5 Q21.6 13 20.4 15.8 Q18.2 14.8 18.6 12.2Z')),
  '(love)': rosto(MINI_CORACAO('') + MINI_CORACAO('translate(7.4 0)') + SORRISO),
  ':*': rosto(OLHOS + "<ellipse cx='12' cy='16.3' rx='2.2' ry='1.8' fill='#e8112d' stroke='#8a0010' stroke-width='.8'/><path transform='translate(12.2 -4.4) scale(.7)' d='M8.3 12 C5.3 9.8 5.6 7.2 7.4 7.2 C8 7.2 8.3 7.6 8.3 8 C8.3 7.6 8.6 7.2 9.2 7.2 C11 7.2 11.3 9.8 8.3 12Z' fill='#ff4d6a' stroke='#8a0010' stroke-width='.6'/>"),
  '(cry)': rosto(OLHOS + "<path d='M7.6 19 Q12 12.6 16.4 19 Z' fill='#7a1010' stroke='#222' stroke-width='1.1' stroke-linejoin='round'/>" +
    TRACO('M7.4 11.4 Q4.8 15.4 6.2 20', '#2f8fff', 2.2) + TRACO('M16.6 11.4 Q19.2 15.4 17.8 20', '#2f8fff', 2.2)),
  '(zzz)': rosto(TRACO('M5.8 10 Q8.3 12.2 10.8 10', '#222', 1.6) + TRACO('M13.2 10 Q15.7 12.2 18.2 10', '#222', 1.6) +
    "<ellipse cx='12' cy='16.6' rx='1.7' ry='1.3' fill='#7a1010' stroke='#222' stroke-width='.8'/>" + TRACO('M15.4 2.2 H19.8 L15.4 6.8 H19.8', '#2060c0', 1.5)),
  ':S': rosto("<ellipse cx='8.3' cy='9.3' rx='1.3' ry='1.7' fill='#222'/><ellipse cx='15.7' cy='9' rx='1.7' ry='2.4' fill='#222'/>" + TRACO('M6.8 16.8 Q9.4 13.8 12 16.4 T17.2 16', '#222', 1.6)),
  '(blush)': rosto(OLHOS + "<ellipse cx='5.6' cy='13.4' rx='2.4' ry='1.6' fill='#ff5a5a' opacity='.65'/><ellipse cx='18.4' cy='13.4' rx='2.4' ry='1.6' fill='#ff5a5a' opacity='.65'/>" + TRACO('M8.8 15.8 Q12 18.4 15.2 15.8')),
  '(devil)': rosto("<path d='M4.2 7 L3.2 1.6 L8.4 4.4Z' fill='#d02a20' stroke='#7a0f00' stroke-width='.8' stroke-linejoin='round'/><path d='M19.8 7 L20.8 1.6 L15.6 4.4Z' fill='#d02a20' stroke='#7a0f00' stroke-width='.8' stroke-linejoin='round'/>" +
      TRACO('M5.3 7.6 L10.6 10', '#222', 1.9) + TRACO('M18.7 7.6 L13.4 10', '#222', 1.9) +
      "<ellipse cx='8.6' cy='11.4' rx='1.1' ry='1.4' fill='#222'/><ellipse cx='15.4' cy='11.4' rx='1.1' ry='1.4' fill='#222'/>" +
      "<path d='M6.2 15 Q12 21.4 17.8 15 Q12 17.2 6.2 15Z' fill='#222' stroke='#222' stroke-width='1' stroke-linejoin='round'/>", ['#e7b8ff', '#a64dff', '#6a1fb5', '#3d0f6b']),
  '(angel)': rosto("<ellipse cx='12' cy='2.6' rx='5.2' ry='1.7' fill='none' stroke='#f0b400' stroke-width='1.6'/>" + OLHOS + SORRISO),
  '(skull)': SVGW(GRAD('k', ['#ffffff', '#dcdcdc', '#9a9a9a']),
    "<path d='M12 1.8 C6.4 1.8 3.4 5.8 3.4 10.2 C3.4 13.2 5 15 6.8 16 V19.6 C6.8 20.4 7.4 21.2 8.2 21.2 H15.8 C16.6 21.2 17.2 20.4 17.2 19.6 V16 C19 15 20.6 13.2 20.6 10.2 C20.6 5.8 17.6 1.8 12 1.8Z' fill='url(#k)' stroke='#555' stroke-width='1'/>" +
    "<ellipse cx='8.6' cy='10.6' rx='2.5' ry='2.9' fill='#222'/><ellipse cx='15.4' cy='10.6' rx='2.5' ry='2.9' fill='#222'/><path d='M12 13.2 L10.7 15.6 H13.3Z' fill='#222'/>" +
    TRACO('M9.6 17.2 V21 M12 17.2 V21 M14.4 17.2 V21', '#555', .9) + "<ellipse cx='7.6' cy='5.2' rx='2.6' ry='1.4' fill='#fff' opacity='.7'/>"),
  '(sick)': rosto(TRACO('M5.8 9.6 H10.6', '#222', 1.9) + TRACO('M13.4 9.6 H18.2', '#222', 1.9) + TRACO('M6.6 17.2 Q9.3 14.4 12 17 T17.4 16.8', '#222', 1.6) +
    "<path d='M19.2 4.6 Q21 7.2 19.2 8.4 Q17.4 7.2 19.2 4.6Z' fill='#4aa3ff' stroke='#1c6fc9' stroke-width='.5'/>", ['#eaffb8', '#a6e02a', '#6a9b00', '#3d5c00']),
  '(roll)': rosto("<ellipse cx='8.3' cy='9.4' rx='2.4' ry='2.7' fill='#fff' stroke='#222' stroke-width='.9'/><circle cx='8.9' cy='8.2' r='1.2' fill='#222'/><ellipse cx='15.7' cy='9.4' rx='2.4' ry='2.7' fill='#fff' stroke='#222' stroke-width='.9'/><circle cx='16.3' cy='8.2' r='1.2' fill='#222'/>" + TRACO('M8 16.6 H16')),
  '(ghost)': SVGW(GRAD('f', ['#ffffff', '#dfe6ff', '#aab6f0']),
    "<path d='M12 1.8 C7.4 1.8 4.8 5.2 4.8 9.6 V21 L7.4 18.8 L9.7 21 L12 18.8 L14.3 21 L16.6 18.8 L19.2 21 V9.6 C19.2 5.2 16.6 1.8 12 1.8Z' fill='url(#f)' stroke='#5e6bb0' stroke-width='1' stroke-linejoin='round'/>" +
    "<ellipse cx='9.4' cy='9.4' rx='1.3' ry='2' fill='#222'/><ellipse cx='14.6' cy='9.4' rx='1.3' ry='2' fill='#222'/><ellipse cx='12' cy='14' rx='1.5' ry='2' fill='#222'/><ellipse cx='8' cy='5' rx='2.2' ry='1.2' fill='#fff' opacity='.8'/>"),
  '(poop)': SVGW(GRAD('p', ['#d9a05e', '#9a5a22', '#5e320e']),
    "<ellipse cx='12' cy='18.4' rx='9' ry='3.8' fill='url(#p)' stroke='#4a2408' stroke-width='1'/><ellipse cx='12' cy='13.2' rx='6.8' ry='3.6' fill='url(#p)' stroke='#4a2408' stroke-width='1'/>" +
    "<path d='M12.6 1.8 Q15 4 14.4 5.6 Q17 6.2 16.6 9.2 Q16 11.6 12 11.6 Q8 11.6 7.6 9.2 Q7.4 6.8 9.6 6 Q9.4 4.2 12.6 1.8Z' fill='url(#p)' stroke='#4a2408' stroke-width='1' stroke-linejoin='round'/>" +
    "<circle cx='9.8' cy='9.4' r='1.5' fill='#fff' stroke='#4a2408' stroke-width='.5'/><circle cx='14.2' cy='9.4' r='1.5' fill='#fff' stroke='#4a2408' stroke-width='.5'/><circle cx='10' cy='9.6' r='.7' fill='#222'/><circle cx='14' cy='9.6' r='.7' fill='#222'/>" + TRACO('M10 11.4 Q12 13 14 11.4', '#2a1204', 1.1)),

  // ----- coisas -----
  '(rose)': SVGW(GRAD('r', ['#ff8a9a', '#e8112d', '#8a0010']),
    TRACO('M12 13.6 Q12.8 18 11.2 23', '#2e8b2e', 1.9) +
    "<path d='M12 18.4 Q16.8 17 18.4 20.4 Q14.6 21.4 12 18.4Z' fill='#3fb83f' stroke='#1f6f1f' stroke-width='.7'/><path d='M11.9 16.4 Q7.4 15.2 5.8 18.4 Q9.6 19.6 11.9 16.4Z' fill='#3fb83f' stroke='#1f6f1f' stroke-width='.7'/>" +
    "<path d='M12 1.6 C16 1.6 18.6 4 18.4 7.6 C18.2 11.2 15.4 13.8 12 13.8 C8.6 13.8 5.8 11.2 5.8 7.6 C5.8 4 8 1.6 12 1.6Z' fill='url(#r)' stroke='#7a0010' stroke-width='1'/>" +
    TRACO('M12.2 4 Q15.6 4.8 15 8 Q14.4 11 11.2 10.6 Q8.4 10.2 8.8 7.6 Q9.2 5.8 11.2 6 Q12.8 6.2 12.6 7.8', '#7a0010', 1)),
  '(dog)': SVGW('',
    "<path d='M5.6 6 Q1.4 8.4 3 15.6 Q6.8 15.2 7.8 9.8Z' fill='#8a5a2b' stroke='#4a2c10' stroke-width='.9' stroke-linejoin='round'/><path d='M18.4 6 Q22.6 8.4 21 15.6 Q17.2 15.2 16.2 9.8Z' fill='#8a5a2b' stroke='#4a2c10' stroke-width='.9' stroke-linejoin='round'/>" +
    "<ellipse cx='12' cy='11.8' rx='7.6' ry='8.2' fill='#f3cd8c' stroke='#8a5a2b' stroke-width='1'/><ellipse cx='12' cy='15.6' rx='4.6' ry='3.8' fill='#fff1d6' stroke='#c79a5a' stroke-width='.6'/>" +
    "<circle cx='8.8' cy='9.8' r='1.3' fill='#222'/><circle cx='15.2' cy='9.8' r='1.3' fill='#222'/><circle cx='9.2' cy='9.4' r='.4' fill='#fff'/><circle cx='15.6' cy='9.4' r='.4' fill='#fff'/><ellipse cx='12' cy='13.4' rx='2' ry='1.4' fill='#222'/>" +
    TRACO('M12 14.6 V16.2 M12 16.2 Q10.4 17.8 9 16.6 M12 16.2 Q13.6 17.8 15 16.6', '#222', .9) + "<ellipse cx='12' cy='18.4' rx='1.3' ry='1.5' fill='#ff6f91'/><ellipse cx='8.6' cy='5.2' rx='3' ry='1.3' fill='#fff' opacity='.3'/>"),
  '(cat)': SVGW('',
    "<path d='M3.4 11 L4.4 2.2 L10.2 6Z' fill='#f6a64a' stroke='#a85a10' stroke-width='1' stroke-linejoin='round'/><path d='M20.6 11 L19.6 2.2 L13.8 6Z' fill='#f6a64a' stroke='#a85a10' stroke-width='1' stroke-linejoin='round'/>" +
    "<path d='M5.4 8.4 L5.8 5 L8.4 6.8Z' fill='#ff9ab0'/><path d='M18.6 8.4 L18.2 5 L15.6 6.8Z' fill='#ff9ab0'/>" +
    "<ellipse cx='12' cy='13.2' rx='9.2' ry='8' fill='#f6a64a' stroke='#a85a10' stroke-width='1'/>" + TRACO('M12 5.6 V8.2 M9.4 6.2 L9.9 8 M14.6 6.2 L14.1 8', '#a85a10', .9) +
    "<ellipse cx='8.4' cy='12.2' rx='1.3' ry='1.8' fill='#222'/><ellipse cx='15.6' cy='12.2' rx='1.3' ry='1.8' fill='#222'/><circle cx='8.8' cy='11.5' r='.45' fill='#fff'/><circle cx='16' cy='11.5' r='.45' fill='#fff'/>" +
    "<path d='M10.8 14.6 H13.2 L12 16Z' fill='#ff6f91' stroke='#b0184f' stroke-width='.4'/>" + TRACO('M12 16 Q10.6 17.6 9.2 16.8 M12 16 Q13.4 17.6 14.8 16.8', '#222', .9) +
    TRACO('M2.2 13.4 L7 14.2 M2.4 16.6 L7.2 15.6 M21.8 13.4 L17 14.2 M21.6 16.6 L16.8 15.6', '#a85a10', .7)),
  '(knife)': SVGW(GRAD('b', ['#ffffff', '#c9d0d8', '#8a94a0'], true),
    "<g transform='rotate(45 12 12) translate(0 .6)'><path d='M12 -1 C15.6 2.6 16.4 8.6 15.6 14.4 H11 Z' fill='url(#b)' stroke='#59636f' stroke-width='.9' stroke-linejoin='round'/>" +
    "<path d='M12.3 1.4 C14.2 4.4 14.6 8.6 14.2 12.6' fill='none' stroke='#fff' stroke-width='.8' opacity='.8'/>" +
    "<rect x='10.4' y='14.2' width='5.6' height='1.6' rx='.6' fill='#b4bcc6' stroke='#59636f' stroke-width='.6'/><rect x='10.8' y='15.6' width='4.8' height='9' rx='1.6' fill='#4a2f22' stroke='#1c0f08' stroke-width='.9'/>" +
    "<circle cx='13.2' cy='18' r='.7' fill='#c9d0d8'/><circle cx='13.2' cy='21.4' r='.7' fill='#c9d0d8'/></g>"),
  '(mf)': SVGW(AMARELO,
    "<path d='M5.4 13 Q5.4 11 7.4 11 H8.8 V11.4 H15.4 V11 H16.6 Q18.8 11 18.8 13.2 V17 Q18.8 22.4 13.4 22.4 H10.6 Q5.4 22.4 5.4 17Z' fill='url(#y)' stroke='#a66a00' stroke-width='1' stroke-linejoin='round'/>" +
    "<rect x='10.2' y='1.4' width='4' height='12.4' rx='2' fill='url(#y)' stroke='#a66a00' stroke-width='1'/>" +
    "<ellipse cx='8' cy='11.8' rx='2.2' ry='2.6' fill='url(#y)' stroke='#a66a00' stroke-width='1'/><ellipse cx='16.4' cy='12' rx='2.2' ry='2.6' fill='url(#y)' stroke='#a66a00' stroke-width='1'/>" +
    "<path d='M5.6 15.4 Q2.8 15.6 3 18 Q3.4 20.4 7 20' fill='url(#y)' stroke='#a66a00' stroke-width='1' stroke-linecap='round'/><ellipse cx='11.6' cy='4.4' rx='.9' ry='2' fill='#fff' opacity='.45'/>"),
  '(like)': SVGW(AMARELO + GRAD('m', ['#8fc3f4', '#3d86ea', '#1b5fd6'], true),
    "<rect x='1.8' y='10.2' width='4.6' height='11.8' rx='1' fill='url(#m)' stroke='#12307a' stroke-width='.9'/>" +
    "<path d='M7.8 10.6 L11.4 3.4 Q12.4 1.6 14 2.4 Q15.4 3.2 14.8 5 L13.8 8.4 H19.6 Q21.8 8.6 21.6 10.8 L20.6 18.6 Q20.2 21.4 17.6 21.4 H8.8 Q7.8 21.4 7.8 20.4Z' fill='url(#y)' stroke='#a66a00' stroke-width='1' stroke-linejoin='round'/>" +
    TRACO('M10 13.6 H19 M9.8 16.4 H18.6', '#a66a00', .8)),
  '(dislike)': SVGW(AMARELO + GRAD('m', ['#8fc3f4', '#3d86ea', '#1b5fd6'], true),
    "<g transform='translate(0 24) scale(1 -1)'><rect x='1.8' y='10.2' width='4.6' height='11.8' rx='1' fill='url(#m)' stroke='#12307a' stroke-width='.9'/>" +
    "<path d='M7.8 10.6 L11.4 3.4 Q12.4 1.6 14 2.4 Q15.4 3.2 14.8 5 L13.8 8.4 H19.6 Q21.8 8.6 21.6 10.8 L20.6 18.6 Q20.2 21.4 17.6 21.4 H8.8 Q7.8 21.4 7.8 20.4Z' fill='url(#y)' stroke='#a66a00' stroke-width='1' stroke-linejoin='round'/>" +
    TRACO('M10 13.6 H19 M9.8 16.4 H18.6', '#a66a00', .8) + '</g>'),
  '(broken)': SVGW(GRAD('h', ['#ff9aa8', '#e8112d', '#a00018']),
    "<path d='" + CORACAO + "' fill='url(#h)' stroke='#8a0010' stroke-width='1'/><ellipse cx='7.6' cy='7' rx='2.2' ry='1.3' fill='#fff' opacity='.45'/>" +
    TRACO('M12.4 5.2 L9.8 9.4 L13.8 12 L10.6 16 L12.6 20.4', '#5a0010', 2.6) + TRACO('M12.4 5.2 L9.8 9.4 L13.8 12 L10.6 16 L12.6 20.4', '#fff', 1)),
  '(star)': SVGW(GRAD('s', ['#fffbb0', '#ffd91a', '#e09b00']),
    "<path d='M12 1.6 L14.9 8.4 L22.2 9 L16.6 13.8 L18.4 21 L12 17.2 L5.6 21 L7.4 13.8 L1.8 9 L9.1 8.4Z' fill='url(#s)' stroke='#a66a00' stroke-width='1' stroke-linejoin='round'/><ellipse cx='9.6' cy='7.6' rx='2' ry='1' fill='#fff' opacity='.5'/>"),
  '(moon)': SVGW(GRAD('l', ['#fffbb0', '#ffd91a', '#e09b00']),
    "<path d='M15.6 2 A10.4 10.4 0 1 0 22 16.6 A8.6 8.6 0 0 1 15.6 2Z' fill='url(#l)' stroke='#a66a00' stroke-width='1' stroke-linejoin='round'/>"),
  '(cake)': SVGW('',
    "<path d='M2.8 14.2 H21.2 V20.4 Q21.2 22 19.6 22 H4.4 Q2.8 22 2.8 20.4Z' fill='#f5b07a' stroke='#b0683a' stroke-width='1'/><path d='M4.4 9 H19.6 Q20.4 9 20.4 9.8 V14.2 H3.6 V9.8 Q3.6 9 4.4 9Z' fill='#fff3f8' stroke='#d08aa8' stroke-width='1'/>" +
    TRACO('M3.8 12 Q5.8 14.4 7.8 12 T11.8 12 T15.8 12 T19.8 12', '#e8508c', 1.4) + "<rect x='11.2' y='4.6' width='1.6' height='4.6' fill='#3d86ea' stroke='#1b5fd6' stroke-width='.5'/><path d='M12 1 Q14.2 3.4 12 5 Q9.8 3.4 12 1Z' fill='#ffb000' stroke='#e06a00' stroke-width='.5'/>"),
  '(gift)': SVGW('',
    "<rect x='3.4' y='9.8' width='17.2' height='12' rx='1' fill='#e8112d' stroke='#8a0010'/><rect x='2.4' y='6.8' width='19.2' height='4.2' rx='1' fill='#ff3b50' stroke='#8a0010'/><rect x='10.6' y='6.8' width='2.8' height='15' fill='#ffd91a' stroke='#a66a00' stroke-width='.6'/>" +
    "<path d='M12 6.8 C8 6.8 6.2 1.8 9.4 2.2 C11.6 2.4 12 5 12 6.8Z' fill='#ffd91a' stroke='#a66a00' stroke-width='.7'/><path d='M12 6.8 C16 6.8 17.8 1.8 14.6 2.2 C12.4 2.4 12 5 12 6.8Z' fill='#ffd91a' stroke='#a66a00' stroke-width='.7'/>"),
  '(beer)': SVGW(GRAD('a', ['#ffe48a', '#f6b410', '#c47c00'], true),
    "<path d='M16.6 8.6 H19.4 Q21.6 8.6 21.6 11 V14.4 Q21.6 17 19.4 17 H16.6' fill='none' stroke='#a66a00' stroke-width='2'/>" +
    "<path d='M4.4 6 H16.6 V19.8 Q16.6 21.8 14.6 21.8 H6.4 Q4.4 21.8 4.4 19.8Z' fill='url(#a)' stroke='#a66a00' stroke-width='1'/>" +
    "<circle cx='6.8' cy='5.2' r='2.5' fill='#fff' stroke='#bbb' stroke-width='.7'/><circle cx='10.5' cy='3.8' r='3' fill='#fff' stroke='#bbb' stroke-width='.7'/><circle cx='14.2' cy='5.2' r='2.5' fill='#fff' stroke='#bbb' stroke-width='.7'/>" +
    TRACO('M7.2 10 V19 M10.6 10 V19', '#fff', 1.2).replace("stroke-linecap='round'", "stroke-linecap='round' opacity='.45'")),
  '(coffee)': SVGW('',
    TRACO('M7.6 7 Q6 5 7.8 3.4 Q9.2 2 8 .6', '#9a9a9a', 1.1) + TRACO('M12 7 Q10.4 5 12.2 3.4 Q13.6 2 12.4 .6', '#9a9a9a', 1.1) +
    "<path d='M16.8 11 H18.4 Q21.2 11 21.2 13.6 Q21.2 16.6 17.8 16.6 H16' fill='none' stroke='#555' stroke-width='1.6'/>" +
    "<ellipse cx='10' cy='21.4' rx='8.4' ry='1.5' fill='#ddd' stroke='#555' stroke-width='.7'/><path d='M3.4 9.6 H16.8 V14.6 Q16.8 20.6 10.1 20.6 Q3.4 20.6 3.4 14.6Z' fill='#fff' stroke='#555' stroke-width='1'/><ellipse cx='10.1' cy='9.6' rx='6.7' ry='1.7' fill='#7a4a21' stroke='#555' stroke-width='1'/>"),
  '(pizza)': SVGW('',
    "<path d='M2.8 6.8 L12 22.4 L21.2 6.8 Q12 2.2 2.8 6.8Z' fill='#ffd25a' stroke='#c27a00' stroke-width='1' stroke-linejoin='round'/>" +
    "<path d='M2.2 6.8 Q12 1.6 21.8 6.8 L20.6 9 Q12 4.6 3.4 9Z' fill='#e0a050' stroke='#a66a00' stroke-width='.9' stroke-linejoin='round'/>" +
    "<circle cx='8.8' cy='11.6' r='1.8' fill='#d02a20' stroke='#7a0f00' stroke-width='.6'/><circle cx='14.8' cy='11.2' r='1.8' fill='#d02a20' stroke='#7a0f00' stroke-width='.6'/><circle cx='11.9' cy='16' r='1.7' fill='#d02a20' stroke='#7a0f00' stroke-width='.6'/>"),
  '(fire)': SVGW(GRAD('fi', ['#ff3b1a', '#ff8a00', '#ffd91a'], true),
    "<path d='M12.4 1.2 C13.2 5.2 18.6 7.6 18.6 14 C18.6 18.8 15.8 22.4 12 22.4 C8.2 22.4 5.4 18.8 5.4 14.6 C5.4 11.8 6.8 10 8.2 8.6 C8.2 10.6 9 11.6 10 11.8 C9.6 8 10.6 4 12.4 1.2Z' fill='url(#fi)' stroke='#b02000' stroke-width='.9' stroke-linejoin='round'/>" +
    "<path d='M12 22.4 C9.8 22.4 8.4 20.4 8.4 18.2 C8.4 16.2 10 14.8 12 12.8 C14 14.8 15.6 16.2 15.6 18.2 C15.6 20.4 14.2 22.4 12 22.4Z' fill='#ffe85a'/>"),
  '(music)': SVGW('',
    "<ellipse cx='7.4' cy='18.4' rx='3.8' ry='2.9' fill='#2a5bd7' stroke='#12307a' stroke-width='.9' transform='rotate(-20 7.4 18.4)'/><rect x='10.4' y='3.4' width='1.7' height='14.6' fill='#2a5bd7' stroke='#12307a' stroke-width='.7'/>" +
    "<path d='M12 3.4 C14.8 4.4 18.6 5.4 18.8 10 C17.6 7.6 15 7.2 12 6.4Z' fill='#2a5bd7' stroke='#12307a' stroke-width='.7' stroke-linejoin='round'/><ellipse cx='6.4' cy='17.4' rx='1.3' ry='.7' fill='#fff' opacity='.5'/>"),
  '(sun)': SVGW(GRAD('u', ['#fffbb0', '#ffd91a', '#e09b00']),
    RAIOS + "<circle cx='12' cy='12' r='5.6' fill='url(#u)' stroke='#a66a00' stroke-width='1'/><ellipse cx='10.2' cy='9.8' rx='2' ry='1.1' fill='#fff' opacity='.5'/>"),
  '(kiss)': SVGW(GRAD('li', ['#ff8a9a', '#e8112d', '#a00018'], true),
    "<path d='M1.8 12 Q6 4.4 9.8 7.2 Q12 8.4 14.2 7.2 Q18 4.4 22.2 12 Q12 15.6 1.8 12Z' fill='url(#li)' stroke='#7a0010' stroke-width='1' stroke-linejoin='round'/>" +
    "<path d='M1.8 12 Q12 9 22.2 12 Q18.6 21 12 21 Q5.4 21 1.8 12Z' fill='url(#li)' stroke='#7a0010' stroke-width='1' stroke-linejoin='round'/><ellipse cx='12' cy='17.4' rx='4' ry='1.2' fill='#fff' opacity='.4'/>")
});

const EMO_URL = {};
Object.keys(EMO_SVG).forEach(k => { EMO_URL[k] = 'data:image/svg+xml,' + encodeURIComponent(EMO_SVG[k]); });

// Códigos alternativos (estilo MSN antigo) que mostram o mesmo desenho
const EMO_ALIAS = {
  '(F)': '(rose)', '(&)': '(dog)', '(@)': '(cat)', '(Y)': '(like)', '(N)': '(dislike)',
  '(U)': '(broken)', '(^)': '(cake)', '(K)': '(kiss)'
};
// Emojis do teclado do celular viram os desenhos do BIM
const EMO_UNI = {
  '😂': '(lol)', '🤣': '(lol)', '😍': '(love)', '🥰': '(love)', '😘': ':*', '😭': '(cry)', '😴': '(zzz)', '😕': ':S', '😟': ':S',
  '😳': '(blush)', '😈': '(devil)', '👿': '(devil)', '😇': '(angel)', '💀': '(skull)', '☠': '(skull)', '🤢': '(sick)', '🤮': '(sick)',
  '🙄': '(roll)', '👻': '(ghost)', '💩': '(poop)', '🌹': '(rose)', '🐶': '(dog)', '🐕': '(dog)', '🐱': '(cat)', '🐈': '(cat)',
  '🔪': '(knife)', '🖕': '(mf)', '👍': '(like)', '👎': '(dislike)', '💔': '(broken)', '⭐': '(star)', '🌟': '(star)',
  '🌙': '(moon)', '🎂': '(cake)', '🎁': '(gift)', '🍺': '(beer)', '🍻': '(beer)', '☕': '(coffee)', '🍕': '(pizza)',
  '🔥': '(fire)', '🎵': '(music)', '🎶': '(music)', '☀': '(sun)', '🌞': '(sun)', '💋': '(kiss)',
  '😀': ':)', '😃': ':D', '😄': ':D', '😁': ':D', '🙂': ':)', '😊': ':)', '😉': ';)', '😛': ':P', '😜': ':P', '😝': ':P',
  '😮': ':O', '😲': ':O', '😢': ":'(", '😥': ":'(", '😡': ':@', '😠': ':@', '😐': ':|', '😑': ':|',
  '❤': '<3', '♥': '<3', '💖': '<3', '😎': '(H)', '😞': ':(', '☹': ':(', '🙁': ':('
};
const EMO_BUSCA = {};   // texto (já escapado, minúsculo) -> código principal
Object.keys(EMO_SVG).forEach(k => { EMO_BUSCA[esc(k).toLowerCase()] = k; });
Object.keys(EMO_ALIAS).forEach(k => { EMO_BUSCA[esc(k).toLowerCase()] = EMO_ALIAS[k]; });
const EMO_CODIGOS = Object.keys(EMO_SVG).concat(Object.keys(EMO_ALIAS)).sort((a, b) => b.length - a.length);
const EMO_UNI_LISTA = Object.keys(EMO_UNI).sort((a, b) => b.length - a.length);
// Uma única passada, para um emoji não ser trocado duas vezes
const RE_EMO = new RegExp(
  EMO_CODIGOS.map(k => esc(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
  '|(?:' + EMO_UNI_LISTA.join('|') + ')\\uFE0F?', 'gi');
function emoDe(m) {
  m = m.replace(/\uFE0F/g, '');
  return EMO_BUSCA[m.toLowerCase()] || EMO_UNI[m] || null;
}
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
    const k = emoDe(m);
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
  if (c.grupo) {
    const g = grupos.find(x => x.id === c.id);
    if (g) {
      c.nome = g.name;
      c.janela.querySelector('.titulo-txt').textContent = g.name + ' - Grupo';
    }
    c.contato.innerHTML = '<span class="mini-av">👥</span><b>' + esc(c.nome) + '</b>' + (g ? ' <small>' + g.members.length + ' membros</small>' : '');
    return;
  }
  const a = amigos.find(x => x.name.toLowerCase() === c.chave);
  c.contato.innerHTML = miniAv(a && a.avatar) + '<b>' + esc(c.nome) + '</b>' + (a && a.bio ? ' <small>' + esc(a.bio) + '</small>' : '');
}
function fecharPops() {
  document.querySelectorAll('.menu-pop, .emo-pop').forEach(p => p.classList.add('escondido'));
}
document.addEventListener('click', fecharPops);

function montarJanela(rotuloMenu) {
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
      '<div class="menubar-chat"><span>Arquivo</span><span>Editar</span><span class="menu-pessoas">' + rotuloMenu + '</span>' +
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
  $('janelas-chat').appendChild(j);
  arrastavel(j);
  return j;
}

function ligarMenu(j, itens) {
  const menu = j.querySelector('.menu-pop');
  itens.forEach(([t, fn]) => {
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
}

function ligarBarra(j, c) {
  const pop = j.querySelector('.emo-pop');
  Object.keys(EMO_SVG).forEach(k => {
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
}

function ligarEnvio(c, enviar) {
  const j = c.janela;
  j.querySelector('[data-enviar]').addEventListener('click', enviar);
  c.input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); }
  });
  j.querySelector('.btn-titulo').addEventListener('click', () => { j.remove(); delete chats[c.chave]; });
  j.addEventListener('mousedown', () => j.querySelector('.titulo').classList.remove('piscando'));
}

// ---------- Grupos ----------
function abrirGrupo(id, semFoco) {
  const chave = 'g:' + id;
  if (chats[chave]) {
    limparNaoLidas(chave);
    chats[chave].janela.style.zIndex = ++zTopo;
    if (!semFoco) chats[chave].input.focus();
    return chats[chave];
  }
  const g = grupos.find(x => x.id === id);
  if (!g) return null;
  const j = montarJanela('Grupo ▾');
  const c = {
    janela: j, nome: g.name, chave, grupo: true, id,
    hist: j.querySelector('.historico'),
    input: j.querySelector('textarea'),
    contato: j.querySelector('.contato'),
    fmt: { b: false, i: false, u: false },
    vistos: new Set(), fila: [], pronto: false
  };
  chats[chave] = c;
  limparNaoLidas(chave);
  atualizarContato(c);
  ligarMenu(j, [['👥 Membros e administração', () => abrirGerenciar(id)], ['🚪 Sair do grupo', () => sairGrupo(id)]]);
  ligarBarra(j, c);

  api('grupo-historico', { id }).then(r => {
    if (r.msgs.length) sistema(c, '— Mensagens anteriores —');
    r.msgs.forEach(m => mostrar(c, m));
    if (r.msgs.length) sistema(c, '— Agora —');
  }).catch(e => {
    sistema(c, 'Não consegui carregar o histórico: ' + e.message);
  }).then(() => {
    c.pronto = true;
    c.fila.forEach(m => mostrar(c, m));
    c.fila = [];
    c.input.disabled = false;
    if (!semFoco) c.input.focus();
  });

  async function enviar() {
    const texto = c.input.value.trim();
    if (!texto || !c.pronto) return;
    c.input.value = '';
    try {
      const r = await api('grupo-enviar', { id, text: texto, fmt: c.fmt });
      mostrar(c, r.msg);
      somEnvia();
    } catch (e) {
      sistema(c, 'Não enviada: ' + e.message);
    }
  }
  ligarEnvio(c, enviar);
  return c;
}

function receberGrupo(m) {
  const c = chats['g:' + m.gid];
  if (c) {                       // conversa já aberta: só acrescenta a mensagem
    if (c.pronto) mostrar(c, m); else c.fila.push(m);
    somRecebe();
    avisarNova(c);
    piscarAba(m.from);
    return;
  }
  const g = grupos.find(x => x.id === m.gid);
  if (!g) return;
  novaNaoLida('g:' + m.gid, '👥 ' + g.name, m.from, m.text, () => abrirGrupo(m.gid));
}

async function grupoAcao(id, acao, extra) {
  const r = await api('grupo-acao', Object.assign({ id, acao }, extra || {}));
  aplicarGrupos(r.grupos);
  return r;
}
async function sairGrupo(id) {
  const g = grupos.find(x => x.id === id);
  if (!g || !confirm('Sair do grupo ' + g.name + '?')) return;
  try { await grupoAcao(id, 'leave'); } catch (e) { alert(e.message); }
}

function abrirNovoGrupo() {
  const w = janela('novo-grupo', 'Novo grupo', 300);
  if (!w.nova) return;
  w.corpo.innerHTML =
    '<label>Nome do grupo</label><input class="entrada" id="ng-nome" maxlength="24">' +
    '<label>Quem entra (seus amigos)</label><div class="entrada-inset bloq-lista" id="ng-lista" style="max-height:160px"></div>' +
    '<small>Você será a administradora do grupo.</small>' +
    '<div class="botoes-login"><button class="botao" id="ng-criar">Criar grupo</button></div>' +
    '<div class="status-login" id="ng-status"></div>';
  const q = id => w.corpo.querySelector('#' + id);
  const lista = q('ng-lista');
  if (!amigos.length) lista.innerHTML = '<div class="vazio">Você ainda não tem amigos. Dá para criar o grupo vazio e adicionar depois.</div>';
  amigos.slice().sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })).forEach(a => {
    const l = document.createElement('label');
    l.className = 'item-linha';
    l.style.fontWeight = 'normal';
    l.innerHTML = '<span>' + miniAv(a.avatar) + esc(a.name) + '</span><input type="checkbox">';
    l.querySelector('input').value = a.name;
    lista.appendChild(l);
  });
  q('ng-criar').addEventListener('click', async () => {
    const membros = [...lista.querySelectorAll('input:checked')].map(i => i.value);
    q('ng-status').textContent = 'Criando...';
    q('ng-status').className = 'status-login';
    try {
      const r = await api('grupo-criar', { name: q('ng-nome').value, members: membros });
      aplicarGrupos(r.grupos);
      fecharJanela('novo-grupo');
      abrirGrupo(r.id);
    } catch (e) {
      q('ng-status').textContent = e.message;
      q('ng-status').className = 'status-login erro';
    }
  });
}

function abrirGerenciar(id) {
  const key = 'grupo-' + id;
  const w = janela(key, 'Grupo', 320);
  if (!w.nova) return;
  renders[key] = () => {
    const g = grupos.find(x => x.id === id);
    if (!g) { fecharJanela(key); return; }
    w.j.querySelector('.titulo span').textContent = 'Grupo: ' + g.name;
    const meuNome = eu.toLowerCase();
    const souAdm = g.members.some(m => m.name.toLowerCase() === meuNome && m.admin);
    const souDono = g.dono.toLowerCase() === meuNome;
    const tentar = fn => async () => { try { await fn(); } catch (e) { alert(e.message); } };
    w.corpo.innerHTML = '';

    if (souAdm) {
      const linha = document.createElement('div');
      linha.className = 'pedido-btns';
      const inp = document.createElement('input');
      inp.className = 'entrada'; inp.maxLength = 24; inp.value = g.name; inp.style.flex = '1';
      linha.appendChild(inp);
      linha.appendChild(botao('Renomear', tentar(() => grupoAcao(id, 'rename', { novoNome: inp.value }))));
      w.corpo.appendChild(linha);
    }

    const tit = document.createElement('label');
    tit.textContent = 'Membros (' + g.members.length + ')';
    w.corpo.appendChild(tit);
    const box = document.createElement('div');
    box.className = 'entrada-inset bloq-lista';
    box.style.maxHeight = '230px';
    g.members.forEach(m => {
      const ehDono = m.name.toLowerCase() === g.dono.toLowerCase();
      const ehEu = m.name.toLowerCase() === meuNome;
      const l = document.createElement('div');
      l.className = 'item-linha';
      l.style.flexWrap = 'wrap';
      l.innerHTML = '<span>' + miniAv(m.avatar) + esc(m.name) + (ehDono ? ' 👑' : m.admin ? ' ⭐' : '') + '</span>';
      const bt = document.createElement('span');
      bt.className = 'pedido-btns';
      if (souAdm && !ehEu && !m.admin) bt.appendChild(botao('⭐ Promover', tentar(() => grupoAcao(id, 'promote', { name: m.name }))));
      if (souDono && !ehEu && m.admin && !ehDono) bt.appendChild(botao('Rebaixar', tentar(() => grupoAcao(id, 'demote', { name: m.name }))));
      if (souAdm && !ehEu && !ehDono && (!m.admin || souDono)) {
        bt.appendChild(botao('Remover', tentar(async () => {
          if (confirm('Remover ' + m.name + ' do grupo?')) await grupoAcao(id, 'remove', { name: m.name });
        })));
      }
      if (!ehEu) bt.appendChild(botao('🚩', () => denunciar(m.name, id)));
      l.appendChild(bt);
      box.appendChild(l);
    });
    w.corpo.appendChild(box);
    const legenda = document.createElement('small');
    legenda.textContent = '👑 dona do grupo · ⭐ administrador';
    w.corpo.appendChild(legenda);

    if (souAdm) {
      const disponiveis = amigos.filter(a => !g.members.some(m => m.name.toLowerCase() === a.name.toLowerCase()));
      const lab = document.createElement('label');
      lab.textContent = 'Adicionar amigo';
      w.corpo.appendChild(lab);
      const linha = document.createElement('div');
      linha.className = 'pedido-btns';
      if (!disponiveis.length) {
        linha.innerHTML = '<span class="vazio">Todos os seus amigos já estão aqui.</span>';
      } else {
        const sel = document.createElement('select');
        sel.className = 'entrada'; sel.style.flex = '1';
        disponiveis.forEach(a => { const o = document.createElement('option'); o.value = a.name; o.textContent = a.name; sel.appendChild(o); });
        linha.appendChild(sel);
        linha.appendChild(botao('Adicionar', tentar(() => grupoAcao(id, 'add', { name: sel.value }))));
      }
      w.corpo.appendChild(linha);
    }

    const fim = document.createElement('div');
    fim.className = 'pedido-btns';
    fim.style.marginTop = '8px';
    fim.appendChild(botao('🚪 Sair do grupo', () => sairGrupo(id)));
    if (souDono) {
      fim.appendChild(botao('🗑 Excluir grupo', tentar(async () => {
        if (confirm('Excluir o grupo ' + g.name + ' para todos? As mensagens serão apagadas.')) await grupoAcao(id, 'delete');
      })));
    }
    w.corpo.appendChild(fim);
  };
  renders[key]();
}

function abrirChat(nome, semFoco) {
  const chave = nome.toLowerCase();
  if (chats[chave]) {
    limparNaoLidas(chave);
    chats[chave].janela.style.zIndex = ++zTopo;
    if (!semFoco) chats[chave].input.focus();
    return chats[chave];
  }
  const j = montarJanela('Pessoas ▾');
  j.querySelector('.titulo-txt').textContent = nome + ' - Mensagem Instantânea';

  const c = {
    janela: j, nome, chave,
    hist: j.querySelector('.historico'),
    input: j.querySelector('textarea'),
    contato: j.querySelector('.contato'),
    fmt: { b: false, i: false, u: false },
    vistos: new Set(), fila: [], pronto: false
  };
  chats[chave] = c;
  limparNaoLidas(chave);
  atualizarContato(c);

  ligarMenu(j, [['👁 Ver perfil', () => verPerfil(c.nome)], ['🚩 Denunciar', () => denunciar(c.nome)], ['🚫 Bloquear', () => bloquear(c.nome)]]);
  ligarBarra(j, c);

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
  ligarEnvio(c, enviar);

  return c;
}

// ---------- Receber mensagens ----------
let piscaTimer = null;
function avisarNova(c) {
  c.janela.querySelector('.titulo').classList.add('piscando');
}
function receber(m) {
  const c = chats[m.from.toLowerCase()];
  if (c) {                       // conversa já aberta: só acrescenta a mensagem
    if (c.pronto) mostrar(c, m); else c.fila.push(m);
    somRecebe();
    avisarNova(c);
    piscarAba(m.from);
    return;
  }
  novaNaoLida(m.from.toLowerCase(), '💬 ' + m.from, '', m.text, () => abrirChat(m.from));
}

// ---------- Avisos de mensagem nova (pop-up, contador e título da aba) ----------
function carregarNaoLidas() {
  try { naoLidas = JSON.parse(localStorage.getItem('bim_nl_' + eu.toLowerCase()) || '{}') || {}; } catch (e) { naoLidas = {}; }
}
function salvarNaoLidas() {
  try { localStorage.setItem('bim_nl_' + eu.toLowerCase(), JSON.stringify(naoLidas)); } catch (e) {}
}
function totalNaoLidas() { return Object.values(naoLidas).reduce((s, n) => s + n, 0); }
function tituloBase() { const n = totalNaoLidas(); return n ? '(' + n + ') BIM' : 'BIM'; }
function atualizarTituloAba() { if (!piscaTimer) document.title = tituloBase(); }
function nomeDeChave(k) {
  if (k.startsWith('g:')) { const g = grupos.find(x => x.id === k.slice(2)); return g ? g.name : 'grupo'; }
  const a = amigos.find(x => x.name.toLowerCase() === k);
  return a ? a.name : k;
}
function limparNaoLidas(chave) {
  removerToast(chave);
  if (!naoLidas[chave]) return;
  delete naoLidas[chave];
  salvarNaoLidas();
  desenharLista();
  atualizarTituloAba();
}
function novaNaoLida(chave, titulo, quem, texto, abrir) {
  naoLidas[chave] = (naoLidas[chave] || 0) + 1;
  salvarNaoLidas();
  desenharLista();
  atualizarTituloAba();
  somRecebe();
  mostrarToast(chave, titulo, quem, texto, abrir);
  notificacaoSistema(titulo, (quem ? quem + ': ' : '') + texto);
  piscarAba(quem || titulo.replace(/^\S+\s/, ''));
}
const toasts = {};
function removerToast(chave) {
  const t = toasts[chave];
  if (!t) return;
  clearTimeout(t.timer);
  t.el.remove();
  delete toasts[chave];
}
function mostrarToast(chave, titulo, quem, texto, abrir) {
  let box = $('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  removerToast(chave);
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = '<div class="titulo"><span></span><button class="btn-titulo" title="Fechar">X</button></div><div class="toast-corpo"></div>';
  const n = naoLidas[chave] || 0;
  el.querySelector('.titulo span').textContent = titulo + (n > 1 ? ' (' + n + ')' : '');
  el.querySelector('.toast-corpo').innerHTML = (quem ? '<b>' + esc(quem) + ':</b> ' : '') + formatar(String(texto).slice(0, 90));
  el.querySelector('.btn-titulo').addEventListener('click', e => { e.stopPropagation(); removerToast(chave); });
  if (abrir) {
    el.classList.add('clicavel');
    el.addEventListener('click', () => { removerToast(chave); abrir(); });
  }
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  toasts[chave] = { el, timer: setTimeout(() => removerToast(chave), 8000) };
}
function notificacaoSistema(titulo, corpo) {
  try {
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      const n = new Notification(titulo, { body: String(corpo).slice(0, 120), tag: 'bim' });
      n.onclick = () => { window.focus(); n.close(); };
    }
  } catch (e) {}
}
// Depois de reconectar, busca de novo o histórico das conversas abertas (pode ter perdido algo)
function recarregarHistorico(c) {
  if (!c.pronto) return;
  const p = c.grupo ? api('grupo-historico', { id: c.id }) : api('history', { with: c.nome });
  p.then(r => r.msgs.forEach(m => mostrar(c, m))).catch(() => {});
}
function piscarAba(quem) {
  if (document.hidden && !piscaTimer) {
    let alt = false;
    piscaTimer = setInterval(() => {
      document.title = (alt = !alt) ? '💬 ' + quem + ' diz...' : tituloBase();
      if (!document.hidden) { clearInterval(piscaTimer); piscaTimer = null; document.title = tituloBase(); }
    }, 900);
  }
}

// ---------- Início ----------
if (token) {
  status('Reconectando...');
  conectar();
}
