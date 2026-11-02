# Projeto919 — Monitoramento

Proposta para um repositório **público** separado, exclusivo de monitoramento.
Preparado localmente; criação, publicação e ativação ainda não autorizadas nesta etapa.

## Funcionamento

O workflow chama uma função técnica já provisionada no PostgreSQL do Supabase
oficial `fssrgbtlbuvgmnjfhrmx`, usando apenas a identidade `p919_health_reader`.
A função retorna um marcador e o horário do banco, sem acessar dados de usuários.
Scripts e certificado público foram reutilizados da implementação já testada.

O cliente usa TLS com validação de certificado/hostname, transação READ ONLY,
timeouts, até três tentativas em falhas transitórias e logs sem credenciais.
O agendamento é diário às 12h17 UTC, atualmente 9h17 de São Paulo; há também
acionamento manual. Falhas aparecem no GitHub Actions; notificações dependem
das preferências do responsável pela conta.

Este repositório não deve ser importado pela Vercel ou conectado ao projeto do
site. Não contém aplicação, comando de deploy, migrations ou provisionamento SQL.
Publicar aqui não exige publicar na branch do Projeto919 nem mudar sua produção.

## Custo e bloqueio de execução

O GitHub permite repositórios públicos no plano Free e não cobra pelo uso de
runners hospedados padrão nesses repositórios. O workflow usa `ubuntu-latest`,
sem runners maiores, cache, artefatos, GitHub Packages ou serviços pagos.

O job só aloca runner se todas estas condições forem atendidas:

- O repositório for exatamente `rosilacerdino/Projeto919-Monitoramento`.
- O evento informar explicitamente que o repositório é público.
- A variável `P919_MONITOR_ENABLED` tiver o valor `true`.

Se o repositório for criado como privado ou faltar a confirmação de ativação,
o job será ignorado. O custo zero considerado aqui é o da rotina com essa
configuração pública e runner padrão, não de outros produtos/serviços da conta.
Não alterar o runner ou a visibilidade sem nova avaliação de custos.

## Credenciais — somente GitHub Actions Secrets

Configurar no novo repositório, depois da autorização final:

- `P919_DB_HOST`: host do pooler oficial na região sa-east-1, sem usuário/senha.
- `P919_DB_PASSWORD`: senha exclusiva do login `p919_health_reader`.

Nunca cadastrar senha administrativa, `service_role`, chave secret Supabase,
credenciais de usuários, `.env.local` ou conexão administrativa completa.
O código fixa o projeto, o papel, o banco e a porta. O certificado `.crt` incluído
é uma CA pública, não uma credencial nem uma chave privada.

Secrets de outro repositório não são herdados nem recuperáveis em texto puro.
O cadastro da senha exige disponibilizá-la diretamente por canal seguro. Se a
senha existente não estiver disponível, sua troca exigirá autorização específica;
não há troca de senha ou alteração de Supabase embutida neste pacote.

## Ativação após aprovação final

1. Criar `Projeto919-Monitoramento` como **público**, sem integração Vercel,
   Pages, Codespaces ou complementos pagos.
2. Publicar somente os arquivos desta pasta na branch padrão do novo repositório.
   Manter `P919_MONITOR_ENABLED` ausente até os passos seguintes.
3. Cadastrar os dois Secrets acima, sem transcrever valores para arquivos ou logs.
4. Confirmar a disponibilidade da credencial técnica existente. Não alterar o
   Supabase para resolver uma credencial ausente sem autorização específica.
5. Após aprovação, definir `P919_MONITOR_ENABLED=true` nas Actions Variables,
   habilitar o workflow e executar `workflow_dispatch`.
6. Confirmar sucesso da etapa de leitura PostgreSQL e acompanhar o próximo
   agendamento. Não declarar ativação concluída apenas pelo commit dos arquivos.

Para suspender a rotina, definir `P919_MONITOR_ENABLED=false` ou desabilitar o
workflow. Nenhuma mudança no banco é necessária.

## Limitações

Agendamentos são executados na branch padrão e podem atrasar ou ser descartados.
Em repositórios públicos, podem ser desativados após 60 dias sem atividade no
repositório. A rotina não cria commits artificiais para contornar esse limite.
Conferir periodicamente o Actions e os avisos do Supabase.

Esta verificação é uma medida auxiliar e **não garante prevenção de pausas**,
não retoma automaticamente um projeto pausado e não substitui backups.

## Validação local

Os seis arquivos do cliente/testes/certificado foram copiados sem alterações.
As alterações para este repositório ficam apenas no workflow e na documentação.
Os testes locais do cliente usam respostas simuladas, sem conexão ao Supabase:

```sh
cd scripts/supabase-health
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

Não carregar `.env.local` da aplicação nem usar credenciais administrativas.

Referências oficiais:

- [Plano Free e repositórios](https://github.com/pricing)
- [Cobrança do GitHub Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [Agendamento e inatividade](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
