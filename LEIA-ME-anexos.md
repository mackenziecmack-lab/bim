# Envio de fotos, vídeos e arquivos

Troque no GitHub apenas estes 3 arquivos: `server.js`, `script.js` e `style.css`.
(`index.html`, `package.json` e a música continuam como estão.)

## Sem configurar nada
Já funciona: toque no 📎 na conversa (amigo ou grupo), ou arraste/cole um arquivo.
Limites: 15 MB por arquivo, 150 MB no total, arquivos somem em 30 dias.
Isso só guarda direito se o Upstash (Redis) estiver configurado, como já está no seu site.

## Para arquivos grandes: Cloudflare R2 (grátis até 10 GB)
Com ele: até 1 GB por arquivo, 9 GB no total, sem expirar. O arquivo vai direto do celular para o Cloudflare.
1. Crie conta em cloudflare.com > "R2 Object Storage" e ative (pede cartão, mas até 10 GB é grátis).
2. "Create bucket" com o nome `bim-arquivos`.
3. No bucket: "Settings" > "CORS Policy" > adicione (troque pelo endereço do seu site no Render, sem barra no final):
```
[{"AllowedOrigins":["https://SEU-SITE.onrender.com"],"AllowedMethods":["PUT","GET","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":3600}]
```
4. Na página inicial do R2 copie o "Account ID". Depois "Manage API Tokens" > "Create API Token" > permissão
   "Object Read & Write" só para o bucket `bim-arquivos`. Copie o "Access Key ID" e o "Secret Access Key" (aparece uma vez só).
5. No Render > seu serviço > "Environment", adicione:
   - `R2_ACCOUNT_ID` = o Account ID
   - `R2_ACCESS_KEY_ID` = o Access Key ID
   - `R2_SECRET_ACCESS_KEY` = o Secret Access Key
   - `R2_BUCKET` = `bim-arquivos`
6. Nos "Logs" do Render deve aparecer: "Arquivos: usando Cloudflare R2".

Opcionais (também em Environment): `MAX_ARQUIVO_MB` (padrão 1024 com R2, 15 sem), `TOTAL_MAX_GB` (padrão 9; quando enche, os mais
antigos são apagados) e `VALIDADE_DIAS` (padrão 0 = nunca expira com R2).

## Segurança
Não dá para enviar programas (.exe, .apk, .bat, .js e parecidos) e o servidor confere o conteúdo real de cada arquivo.
Se uma mensagem com arquivo for apagada, o arquivo também é apagado.
