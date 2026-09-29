# Runbook de testes independentes do iFood

Este projeto possui um simulador local determinístico em `src/integrations/ifood/mock-client.js`. Ele permite validar contratos e fluxos sem credenciais, sem rede externa e sem alterar dados reais.

## Executar

```bash
npm test
npm run check
npm run smoke:production
```

O relatório técnico também fica disponível em `GET /api/launch/compliance` e informa claramente o que está coberto localmente e o que ainda precisa de validação oficial.

## Evidências cobertas

- Merchant: consulta, status, pausas e horários.
- Orders/Events: polling, acknowledgment, deduplicação e ciclo do pedido.
- Catalog: leitura de catálogos e itens.
- Review: listagem e resposta assistida.
- Segurança: autenticação, isolamento, HMAC, rate limit, redaction e headers.
- Produção: health, readiness, PostgreSQL e bloqueio da integração real.

## Limite do simulador

O simulador não substitui homologação, credenciais, limites, permissões, payloads e respostas reais do iFood. Shipping e Financial permanecem pendentes até definição do escopo e validação específica.
