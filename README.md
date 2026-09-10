# 021 TV

Aplicação Node.js com site público, cadastro de clientes, login administrativo e atendimento por chat. O backend usa Express, JWT em cookie `httpOnly`, bcrypt para senhas e Socket.io para atualização em tempo real.

## O que foi preparado

O fluxo de visitante, cadastro e chat agora funciona em conjunto: uma conversa iniciada antes do cadastro é migrada para o usuário recém-criado; o cliente pode continuar consultando o histórico; e o administrador pode responder pelo painel. Todas as conversas ficam persistidas no histórico do administrador, mesmo quando ele está offline. Cada conversa pode ser filtrada como aberta, fechada ou arquivada; conversas fechadas e arquivadas continuam disponíveis para leitura e resposta, e podem ser reabertas. A primeira mensagem do cliente recebe uma resposta automática informando que um atendente humano irá conversar em alguns minutos. Quando chega uma mensagem nova, o destinatário recebe um alerta visual no site, contador no botão do chat e um som curto; clicar no alerta abre a conversa correspondente. O chat também aceita imagens e arquivos de até 10 MB, com até cinco anexos por mensagem. No celular, o botão de câmera abre a câmera do aparelho quando o navegador oferece esse recurso; no computador, o mesmo botão abre o seletor de imagens. Os anexos são gravados em `DATA_DIR/uploads` e protegidos pelas mesmas permissões da conversa. O servidor também valida os dados recebidos, protege as salas do Socket.io, oferece `/healthz` e grava o JSON com escrita atômica para reduzir o risco de arquivo corrompido.

## Execução local

```bash
npm install
cp .env.example .env
# ajuste JWT_SECRET e ADMIN_PASSWORD no .env
npm start
```

Abra `http://localhost:3000`. O usuário administrativo é `admin`; a senha é o valor de `ADMIN_PASSWORD`.

Para executar os testes automatizados:

```bash
npm test
```

Os testes cobrem o health check, criação do visitante, envio de mensagem e imagem, cadastro com migração do histórico, login do administrador, leitura autorizada de anexos, listagem de conversas, fechamento, arquivamento, reabertura e resposta do admin.

## Deploy no Render

1. No GitHub, abra o repositório `matheusrjvendas/021tv` e conecte-o ao Render como **Web Service**.
2. Use **Node** com `Build Command: npm ci` e `Start Command: npm start`.
3. Configure as variáveis de ambiente:

   | Variável | Valor |
   | --- | --- |
   | `NODE_ENV` | `production` |
   | `JWT_SECRET` | uma chave aleatória longa; o Render pode gerar uma automaticamente |
   | `ADMIN_PASSWORD` | uma senha forte para o painel admin |
   | `DATA_DIR` | `./data` para o teste inicial |

4. O health check deve ser `/healthz`.
5. Depois do primeiro deploy, acesse a URL do serviço e valide cadastro, login e chat em duas janelas: uma como cliente e outra como admin.

O arquivo `render.yaml` já contém uma configuração inicial para Blueprint. Se o Render permitir o uso de **Persistent Disk** no seu plano, monte o disco em `/var/data` e troque `DATA_DIR` para `/var/data`. Sem armazenamento persistente, o arquivo `data/db.json` pode ser apagado quando o serviço for recriado ou sofrer um redeploy. Para produção com muitos clientes, substitua o armazenamento JSON por Postgres.

## Contas e segurança

Não publique `.env`, `data/db.json` nem tokens no repositório. Depois do deploy, use uma senha nova no `ADMIN_PASSWORD`; o valor padrão local só existe para facilitar o primeiro teste. O token do GitHub usado para publicar o repositório também deve ser revogado e recriado, porque credenciais enviadas em mensagens ou terminais devem ser consideradas expostas.

## Escopo atual

O botão de plano abre o atendimento e envia a intenção do cliente ao chat. Pagamento, ativação automática de IPTV, troca de senha pela interface e integração com um gateway ainda não fazem parte deste código.
