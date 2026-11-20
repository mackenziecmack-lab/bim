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

## Avisos importantes
- No plano gratuito o servidor "dorme" depois de uns minutos sem uso e demora cerca de 1 minuto para acordar no primeiro acesso.
- No plano gratuito os arquivos do servidor são apagados quando ele reinicia ou dorme. Isso significa que contas, mensagens e denúncias podem sumir. Para guardar tudo de forma permanente é preciso um disco pago do Render (monte o disco em uma pasta, por exemplo `/dados`, e crie a variável `DB_FILE` = `/dados/data.json`) ou um banco de dados externo.
- Não use uma senha que você usa em outros lugares.
- Conversas denunciadas ficam visíveis para a administradora. Vale avisar isso para quem usa o site.

## Testar no computador
Com o Node.js instalado, abra o terminal na pasta e rode `CODIGO_ADMIN=teste node server.js`. Depois acesse http://localhost:3000
