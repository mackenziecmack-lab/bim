# BIM - como colocar no ar (pelo celular)

Para outras pessoas usarem, o servidor precisa ficar ligado na internet.
O jeito mais fácil e gratuito é o Render (render.com). Os menus podem mudar um pouco com o tempo.

## 1. Subir os arquivos no GitHub
1. Crie uma conta em github.com e um repositório novo chamado `bim` (público ou privado).
2. No repositório, toque em "Add file" > "Upload files".
3. Envie os 5 arquivos: `server.js`, `package.json`, `index.html`, `style.css`, `script.js`.
4. Toque em "Commit changes".

## 2. Criar o servidor no Render
1. Crie uma conta em render.com e entre com o GitHub.
2. "New" > "Web Service" e escolha o repositório `bim`.
3. Preencha:
   - Runtime / Language: Node
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Instance Type: Free
4. Toque em "Create Web Service" e espere ficar "Live".
5. O Render mostra o endereço do site (algo como `https://bim-xxxx.onrender.com`). Mande esse link para seus amigos.

## Avisos importantes
- No plano gratuito o servidor "dorme" depois de uns minutos sem uso e demora cerca de 1 minuto para acordar no primeiro acesso.
- No plano gratuito os arquivos do servidor são apagados quando ele reinicia ou dorme. Isso significa que contas e mensagens guardadas podem sumir, e todo mundo precisa se cadastrar de novo. Para guardar as contas de forma permanente é preciso um disco pago ou um banco de dados externo.
- Não use uma senha que você usa em outros lugares.

## Testar no computador
Com o Node.js instalado, abra o terminal na pasta e rode `node server.js`. Depois acesse http://localhost:3000
