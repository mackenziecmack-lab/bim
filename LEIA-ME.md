# BIM - como colocar no ar (pelo celular)

Para outras pessoas usarem, o servidor precisa ficar ligado na internet.
O jeito mais fácil e gratuito é o Render (render.com). Os menus podem mudar um pouco com o tempo.

## 1. Subir os arquivos no GitHub
1. Crie uma conta em github.com e um repositório novo chamado `bim` (público ou privado).
2. No repositório, toque em "Add file" > "Upload files".
3. Envie os arquivos: `server.js`, `package.json`, `index.html`, `style.css`, `script.js` e `nostalgia.mp3` (a música de fundo).
4. Toque em "Commit changes".

Sem o `nostalgia.mp3` o site funciona normalmente, só que sem música (o botão 🎵 some sozinho).

## 2. Criar o servidor no Render
1. Crie uma conta em render.com e entre com o GitHub.
2. "New" > "Web Service" e escolha o repositório `bim`.
3. Preencha:
   - Runtime / Language: Node
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Instance Type: Free
4. Antes de criar, abra "Environment" (variáveis de ambiente) e adicione:
   - `CODIGO_ADMIN` = uma senha secreta só sua (ex.: `minha-senha-secreta-123`)
5. Toque em "Create Web Service" e espere ficar "Live".
6. O Render mostra o endereço do site (algo como `https://bim-xxxx.onrender.com`). Mande esse link para seus amigos.

## 3. Criar a conta XxCreatorxX (administradora)
- No site, toque em "Cadastre-se grátis", digite o nome `XxCreatorxX` e a senha que quiser.
- Vai aparecer um campo "Código de administrador": digite o valor que você colocou em `CODIGO_ADMIN`.
- Só quem tem esse código consegue criar essa conta. Ninguém mais consegue pegar o nome.
- Só a XxCreatorxX vê o botão 🛡 Denúncias, onde dá para ler a conversa denunciada, arquivar ou suspender (banir) a conta.

## O que tem de novo
- Mensagens ficam salvas (últimas 300 de cada conversa) e aparecem quando a conversa é aberta.
- Pedidos de amizade: a pessoa aceita ou recusa em "📨 Pedidos". Também dá para bloquear e denunciar.
- Meu perfil: foto, bio, mudar nome de usuário e escolher a cor do site (azul, rosa, verde, vermelho, laranja, preto, branco).
- Grupos: botão "👥 Novo grupo". Quem cria vira dona e administradora; administradores adicionam amigos, removem membros, promovem outros e renomeiam. Só a dona rebaixa administradores e exclui o grupo. Quem quiser pode sair a qualquer momento.
- Emoticons estilo MSN (`:)` `:(` `:D` `;)` `:P` `:O` `:'(` `(H)` `:@` `:|` `<3`), com botão para escolher.
- Música de fundo bem baixinha (começa no primeiro toque na tela). O botão 🎵 no canto liga/desliga.

## 4. Guardar tudo de forma permanente (grátis) - IMPORTANTE
No plano gratuito do Render o disco é apagado sempre que o servidor reinicia ou dorme. Era isso que fazia
contas, amigos, grupos e conversas sumirem. A solução gratuita é o Upstash (um banco de dados na nuvem):

1. Crie uma conta em upstash.com e toque em "Create Database" (Redis). Nome: `bim`. Região: a mais perto
   (ex.: São Paulo), plano Free.
2. Na página do banco, role até a seção "REST API" e copie dois valores:
   `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`.
3. No Render, abra seu serviço > "Environment" e adicione as duas variáveis com esses valores. Salve (o site reinicia sozinho).
4. Pronto. Nos "Logs" do Render deve aparecer "Dados carregados do Redis" ou "Redis vazio: começando do zero".
   A partir daí contas, amigos, grupos, mensagens e logins ficam salvos mesmo se o servidor dormir.

Se as variáveis estiverem erradas o servidor se recusa a ligar (de propósito, para não apagar nada). Confira os Logs.
Dados que já tinham sido apagados antes disso não dá para recuperar.

## 5. (Opcional) Impedir que o servidor durma
Crie uma conta grátis em uptimerobot.com, "Add New Monitor", tipo HTTP(s), URL `https://SEU-SITE.onrender.com/health`,
intervalo de 5 minutos. Assim o site abre na hora, sem esperar 1 minuto para acordar.

## O que mudou nesta versão
- Login não cai mais: a sessão fica salva no aparelho e no servidor (90 dias). Se o servidor estiver dormindo ou a internet cair,
  o site tenta reconectar sozinho em vez de deslogar. Você só volta para a tela de login se sair ou se a conta for suspensa.
- Mensagem nova não abre mais a conversa na sua cara: aparece um pop-up no canto da tela (clique nele para abrir), um número
  vermelho ao lado de quem mandou (amigo ou grupo) e o título da aba mostra "(2) BIM". Com a aba em segundo plano, o navegador
  também pode mostrar uma notificação (ele pede permissão uma vez).
- A seção "Grupos" agora sempre aparece na lista de amigos.
- 33 emoticons novos no mesmo estilo dos antigos, com seletor que rola. Os emojis do teclado do celular (🐶 🌹 🔪 🖕 😂 ...)
  também viram esses desenhos. Códigos: (lol) (love) (cry) (zzz) (blush) (devil) (angel) (skull) (sick) (roll) (ghost) (poop)
  (rose) (dog) (cat) (knife) (mf) (like) (dislike) (broken) (star) (moon) (cake) (gift) (beer) (coffee) (pizza) (fire) (music)
  (sun) (kiss) :* :S - e os clássicos (F) (&) (@) (Y) (N) (U) (^) (K).

## Avisos importantes
- Sem o passo 4, os dados continuam sumindo quando o servidor reinicia.
- Não use uma senha que você usa em outros lugares.
- Conversas denunciadas ficam visíveis para a administradora. Vale avisar isso para quem usa o site.

## Testar no computador
Com o Node.js instalado, abra o terminal na pasta e rode `CODIGO_ADMIN=teste node server.js`. Depois acesse http://localhost:3000
