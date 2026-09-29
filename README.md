# Gerente iFood IA

Fundação da Fase 1 do sistema: multiempresa/multiloja, modo DEMO isolado, cálculo financeiro sem CMV, auditoria, bloqueio de custos e dashboard consolidado.

## Executar

Requer Node.js 20+. O modo DEMO não exige serviços externos; a persistência de produção usa PostgreSQL.

```bash
npm run check
npm test
npm run smoke:production
npm run verify:release
npm run dev
```

Abra `http://localhost:3000`.

Verifique o processo com `http://localhost:3000/healthz`, a prontidão com `http://localhost:3000/readyz` e consulte o contrato em `http://localhost:3000/api/openapi.json`.

Para usar outra porta: `PORT=3001 npm run dev`.

Se houver proxy reverso confiável, habilite `TRUST_PROXY=true`; mantenha `false` em acesso direto.

O modo DEMO usa dados determinísticos e fica separado de qualquer integração real. A integração iFood está representada somente por um contrato em `src/domain/ifood-integration.js`; nenhum endpoint real é chamado nesta fase.

## Integração iFood preparada

O cliente oficial fica em `src/integrations/ifood/client.js`. Por segurança, chamadas externas ficam desligadas por padrão. Para habilitar somente em ambiente controlado, configure `IFOOD_INTEGRATION_ENABLED=true`, `IFOOD_CLIENT_ID` e `IFOOD_CLIENT_SECRET`. Nunca coloque essas variáveis no frontend ou em logs.

O timeout das chamadas iFood é de 10 segundos por padrão e pode ser ajustado com `IFOOD_REQUEST_TIMEOUT_MS`.

O endpoint `POST /api/ifood/webhook` exige `application/json`, valida `X-IFood-Signature` sobre o corpo bruto antes do parsing, responde `202 Accepted` rapidamente e processa o evento de forma assíncrona com deduplicação por `event.id`.

O módulo financeiro em `src/domain/product-finance.js` rateia custos de pedido pela participação no valor bruto de cada item. O relatório identifica explicitamente o critério utilizado e ignora pedidos cancelados ou reembolsados.

## Documentação de projeto

- [Status atual e bloqueios externos](docs/project-status.md)
- [Matriz de autonomia](docs/decision-matrix.md)
- [Roadmap e critérios de produção](docs/roadmap.md)
- [Contratos da API](docs/api-contracts.md)
- [Checklist de produção iFood](docs/ifood-production-checklist.md)
- [Notas da documentação oficial iFood](docs/ifood-official-notes.md)
- [Próximas ações operacionais](docs/next-actions.md)
- [Runbook de testes independentes do iFood](docs/contract-test-runbook.md)
- [Revisão de segurança](docs/security-review.md)
- [Runbook de produção](docs/production-runbook.md)

O modo DEMO local usa persistência em memória. A instância publicada usa PostgreSQL e HTTPS, incluindo auditoria, eventos deduplicados e decisões de aprovação; a promoção para integração real ainda exige backup restaurável, credenciais homologadas, webhook registrado e aprovação do iFood.

## Persistência PostgreSQL

Configure `DATABASE_URL` apenas no ambiente protegido do servidor. Sem essa variável, o app permanece em `MEMORY/DEMO`.

```bash
npm run db:migrate
```

O comando aplica `src/db/schema.sql`. Depois, `GET /readyz` verifica a conexão e `/api/system/status` informa o modo de persistência.
