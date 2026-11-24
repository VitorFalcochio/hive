# Contribuindo com o Hive Marketplace

O catálogo é um conjunto de arquivos JSON. Não existe servidor nem conta para criar: você contribui por **pull request**.

## Estrutura

```
marketplace/
  index.json          ← gerado: id, versão, arquivo e SHA-256 de cada pacote
  packages/<id>.json  ← um pacote por arquivo
```

## Criar um pacote

O jeito mais fácil é pelo próprio Hive: **Marketplace → Criar e exportar**. Escolha os seus agentes, preencha nome, versão e licença, e salve o arquivo. O Hive já monta o pacote no formato certo e deixa de fora tudo o que é pessoal.

Um pacote (`schemaVersion: 1`) tem estes campos:

| Campo                 | O que é                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `id`                  | único, minúsculas e hífens (`qa-de-interface`)                                                                         |
| `name`, `description` | o que aparece no card                                                                                                  |
| `author`              | `{ "name": "...", "url": "..." }`                                                                                      |
| `version`             | `1.2.3`; suba a cada mudança                                                                                           |
| `license`             | por exemplo `MIT`                                                                                                      |
| `category`            | `agent` (1 agente), `team` (2 ou mais), `skill` (só skills); `workflow`, `template` e `tool` ainda não são instaláveis |
| `tags`                | até 12                                                                                                                 |
| `minHiveVersion`      | a versão mais antiga do Hive que funciona                                                                              |
| `permissions`         | **todas** as ferramentas que os agentes usam, declaradas para o usuário ver antes de instalar                          |
| `agents`              | `key`, `name`, `role`, `description`, `instructions`, `tools`, `skills`, `recommendedModels`, `color`                  |
| `skills`              | `{ "name", "raw" }`, com o `SKILL.md` inteiro em `raw`                                                                 |
| `dependencies`        | outros pacotes necessários (`id` e `version`)                                                                          |

## O que um pacote nunca pode ter

O esquema é estrito: **qualquer campo a mais é recusado**. Por isso um pacote não consegue trazer:

- chaves de API, tokens ou senhas (o Hive também procura textos no formato de chave e recusa o pacote);
- provedor ou modelo escolhidos (cada pessoa usa os seus);
- comandos aprovados automaticamente;
- servidores MCP ou qualquer coisa que execute sozinha;
- memórias (Nectar) ou configurações pessoais.

Tudo num pacote é **declarativo**: instruções, a lista de ferramentas que o agente pede e skills em texto. Cada ferramenta continua sujeita às aprovações do Hive. `run_command`, por exemplo, segue pedindo autorização para comandos fora da lista segura.

## Enviar

1. Coloque o arquivo em `marketplace/packages/<id>.json`.
2. Rode `node scripts/marketplace-index.mjs` para atualizar o `index.json` com o hash.
3. Rode os testes (`npm test`). O teste do catálogo valida cada pacote e confere os hashes.
4. Abra o pull request contando o que o agente faz e como você testou.

## Revisão

Quem revisa confere:

- se as instruções fazem o que a descrição diz;
- se as `permissions` não pedem mais do que o necessário;
- se não há nada pessoal ou executável;
- se `name` e `author` são verdadeiros.

O catálogo **não tem avaliações nem contagem de downloads**: o Hive não inventa números.
