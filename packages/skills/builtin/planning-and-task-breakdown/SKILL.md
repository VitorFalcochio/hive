---
name: planning-and-task-breakdown
description: 'Use ao quebrar um objetivo em tarefas: divide o trabalho em fatias verticais pequenas, ordenadas pelas dependências, cada uma com critérios de aceite e verificação, aproveitando o trabalho em paralelo dos agentes.'
license: MIT
metadata:
  origin: Addy Osmani
  author: Addy Osmani
  source: https://github.com/addyosmani/agent-skills/tree/main/skills/planning-and-task-breakdown
  adapted: 'Traduzida para o português e adaptada ao planejamento da Queen no Hive'
---

# Planejamento e divisão de tarefas

Divida o trabalho em tarefas pequenas e verificáveis, com critérios de aceite explícitos. Uma boa divisão é a diferença entre agentes que entregam com confiança e uma bagunça emaranhada. Cada tarefa deve caber numa sessão focada de um agente: implementar, testar e conferir.

**Quando NÃO usar:** mudança num arquivo só, de escopo óbvio, ou quando o pedido já traz as tarefas bem definidas.

## O processo

### 1. Leia antes de planejar

Antes de qualquer tarefa, só leitura:

- Leia o pedido e as partes do projeto que ele toca.
- Identifique os padrões e convenções que já existem.
- Mapeie as dependências entre as partes.
- Anote riscos e incertezas.

Consulte o Nectar (`nectar_search`): decisões e contratos já aprovados valem para o plano.

### 2. Monte o grafo de dependências

```
Esquema do banco
    ├── Tipos/modelos da API
    │       ├── Rotas da API
    │       │       └── Cliente da API no frontend
    │       │               └── Componentes da interface
    │       └── Validação
    └── Dados iniciais / migrações
```

A ordem segue o grafo de baixo para cima: fundações primeiro.

### 3. Fatie na vertical

Em vez de fazer todo o banco, depois toda a API, depois toda a interface, entregue um caminho completo por vez.

**Ruim (fatias horizontais):**

```
1. Todo o esquema do banco
2. Todas as rotas da API
3. Todos os componentes
4. Ligar tudo
```

**Bom (fatias verticais):**

```
1. O usuário cria uma conta (esquema + API + tela de cadastro)
2. O usuário entra (esquema de login + API + tela de login)
3. O usuário cria um item (esquema + API + tela de criação)
4. O usuário vê a lista (consulta + API + tela da lista)
```

Cada fatia vertical entrega algo que funciona e pode ser testado.

### 4. Escreva cada tarefa

- **Título** curto e descritivo.
- **Descrição:** um parágrafo com o que a tarefa entrega.
- **Critérios de aceite:** condições específicas e testáveis (no máximo umas 3).
- **Verificação:** o comando de teste e de build do projeto que devem passar, e o que conferir na tela (com `view_page`, quando houver interface).
- **Dependências:** as tarefas de que esta precisa, ou nenhuma.
- **Arquivos que provavelmente muda.**
- **Tamanho estimado.**

### 5. Ordene e crie pontos de conferência

1. Dependências satisfeitas: fundação primeiro.
2. Cada tarefa deixa o sistema funcionando.
3. Tarefas de risco alto vão cedo, para falhar rápido.
4. Depois de cada 2 ou 3 tarefas, uma conferência: testes passam, o projeto compila, o fluxo principal funciona de ponta a ponta. No Hive, a tarefa de QA e a de revisão fazem esse papel.

## Tamanho das tarefas

| Tamanho | Arquivos | Escopo                               | Exemplo                       |
| ------- | -------- | ------------------------------------ | ----------------------------- |
| **XS**  | 1        | Uma função ou ajuste de configuração | Uma regra de validação        |
| **P**   | 1–2      | Um componente ou rota                | Uma rota nova da API          |
| **M**   | 3–5      | Uma fatia de funcionalidade          | O fluxo de cadastro           |
| **G**   | 5–8      | Funcionalidade com várias partes     | Busca com filtros e paginação |
| **GG**  | 8+       | **Grande demais: divida**            | —                             |

Os agentes rendem melhor em tarefas P e M. Divida uma tarefa quando:

- Ela passaria de uma sessão focada do agente.
- Você não consegue descrever os critérios de aceite em até 3 itens.
- Ela toca dois subsistemas independentes (ex.: login e pagamento).
- O título tem "e" (sinal de que são duas tarefas).

## Trabalho em paralelo

No Hive, tarefas sem dependência entre si rodam ao mesmo tempo, cada uma com o seu agente.

- **Pode ir em paralelo:** fatias independentes, testes de algo já implementado, documentação.
- **Tem que ser em sequência:** migrações de banco, mudanças em estado compartilhado, cadeias de dependência.
- **Precisa de coordenação:** funcionalidades que compartilham um contrato de API. Defina o contrato numa tarefa primeiro (ou registre no Nectar) e só então paralelize.
- **Nunca** duas tarefas em paralelo no mesmo arquivo.

## Desculpas comuns

| Desculpa                      | Realidade                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| "Vou descobrindo no caminho." | É assim que nasce a bagunça e o retrabalho. Dez minutos de plano poupam horas.              |
| "As tarefas são óbvias."      | Escreva mesmo assim: tarefas explícitas revelam dependências escondidas e casos esquecidos. |
| "Planejar é perda de tempo."  | Planejar é a tarefa. Implementar sem plano é só digitar.                                    |

## Sinais de alerta

- Tarefas do tipo "implementar a funcionalidade" sem critérios de aceite.
- Nenhum passo de verificação no plano.
- Todas as tarefas tamanho GG.
- Ordem de dependências ignorada.
- Duas tarefas paralelas no mesmo arquivo.

## Antes de entregar o plano

- [ ] Toda tarefa tem critérios de aceite.
- [ ] Toda tarefa tem como ser verificada.
- [ ] Dependências identificadas e na ordem certa.
- [ ] Nenhuma tarefa mexe em mais de uns 5 arquivos.
- [ ] Há pontos de conferência entre as fases (QA, revisão).
