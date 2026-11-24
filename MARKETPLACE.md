# Hive Marketplace

Instale agentes, equipes e skills feitos pela comunidade e use nos seus projetos. Também dá para compartilhar os seus agentes.

Para abrir: menu lateral → **Marketplace**.

## Como usar

1. **Explorar**: busque, filtre por categoria e clique num card. A prévia mostra:
   - os agentes do pacote;
   - **cada ferramenta que ele pede**, com as sensíveis marcadas (alteram o projeto ou executam comandos);
   - as skills que entram, as que você já tem (a sua fica como está) e as que faltam;
   - as dependências.
2. **Instalar**: os agentes viram agentes comuns do Hive, **sem modelo**. Escolha o provedor e o modelo de cada um na aba **Agentes**. Daí em diante, a Queen passa a contar com eles nas suas missões, como com qualquer outro agente.
3. **Instalados**:
   - **Atualizar** quando houver versão nova. O que você personalizou (nome, instruções, ferramentas…) **é mantido**, e o resto acompanha o pacote.
   - **Voltar** à versão anterior.
   - **Desinstalar**, o que é recusado enquanto um agente do pacote estiver trabalhando. As skills ficam.
4. **Criar e exportar**: escolha um agente (vira um pacote de agente) ou vários (uma equipe), preencha os dados e salve o arquivo. Ele pode ser importado em outro Hive com **Importar arquivo**.
5. **Catálogo da comunidade**: informe o endereço https de um catálogo (por exemplo, o `raw.githubusercontent.com` de um repositório `hive-marketplace`) e clique em **Sincronizar**.

## Decisões de arquitetura

- **Só configurações declarativas.** Um pacote traz instruções, a lista de ferramentas que pede e skills em texto. Nada nele roda sozinho. Assim, um pacote da comunidade não executa código fora das ferramentas e aprovações normais do Hive.
- **Esquema estrito e versionado** (`schemaVersion: 1`, em `packages/core/src/marketplace.ts`). Qualquer campo a mais é recusado, então um pacote não consegue trazer `apiKey`, `autoApproveCommands`, `mcpServers`, provedor, modelo ou memórias.
- **Defesas em camadas**, nesta ordem:
  1. tamanho máximo de 1 MB;
  2. **SHA-256** igual ao do índice (pega pacote alterado depois de publicado);
  3. **nenhum texto em formato de chave ou token**, em qualquer campo;
  4. JSON válido e no esquema;
  5. todas as ferramentas dos agentes declaradas em `permissions`;
  6. compatibilidade com a versão do Hive;
  7. categoria instalável.

  Os pacotes recusados aparecem com o motivo.

- **Registro abstrato** (`MarketplaceRegistry`):
  - o catálogo **embutido** são os arquivos de `marketplace/` deste repositório, incluídos no build;
  - o catálogo **remoto** é qualquer endereço https com `index.json` e os pacotes. Não precisa de servidor, conta nem backend pago. O índice não pode apontar para fora da pasta do catálogo.
- **Exportar não vaza nada.** O pacote nunca leva provedor, modelo, chaves, comandos aprovados automaticamente, servidores MCP, ids nem memórias. Instruções com algo em formato de chave são **recusadas** em vez de exportadas. Skills com scripts ficam de fora.
- **Atualização em três vias.** Para cada campo: se você não mexeu, ele recebe o valor novo; se mexeu, fica o seu. Cada versão instalada fica guardada para poder voltar.

## Catálogo e contribuição

- `marketplace/index.json`: id, versão, arquivo e hash de cada pacote. É gerado com `node scripts/marketplace-index.mjs`.
- `marketplace/packages/*.json`: três pacotes iniciais da Equipe Hive: **QA de Interface** (testa no Hive Browser), **Revisor de Acessibilidade** e a equipe **Esquadrão Web**.
- `marketplace/CONTRIBUTING.md`: formato, regras e o processo por pull request.

Os arquivos de `marketplace/` são o conteúdo pronto do futuro repositório `hive-marketplace`. **Nenhum repositório externo foi criado.** O catálogo **não tem avaliações nem downloads**: o Hive não inventa números.

## Testes feitos

- **Unitários (9):**
  - o catálogo embutido é válido e confere com os hashes;
  - são recusados pacotes com campos proibidos, chave escondida, conteúdo alterado, versão incompatível, categoria não instalável, ferramenta não declarada, catálogo sem https e caminho fora do catálogo;
  - a instalação não traz nada pessoal;
  - a exportação sai sem credenciais e é importada noutra instalação;
  - instruções com chave são recusadas na exportação;
  - a atualização mantém a personalização, e dá para voltar;
  - a desinstalação é recusada com agente trabalhando.
- **No app real (6 de 6):** catálogo no build, prévia, instalação, skill aprovada pela validação real, recusa de reinstalar e desinstalação.

## Limitações reais

- **Workflows, templates e ferramentas** são aceitos no esquema, mas **ainda não são instaláveis**. A página diz isso em vez de oferecer um botão que não funciona. Ferramentas executáveis precisam de isolamento próprio antes de entrar.
- Os agentes instalados **chegam sem modelo**. É de propósito: cada pessoa usa os seus, e as camadas grátis variam.
- **Dependências** são mostradas, mas não são instaladas automaticamente.
- A exportação usa o diálogo de salvar do sistema, que não foi testado de ponta a ponta. A lógica foi testada com um diálogo falso.
- **Não foi rodada uma missão real com um agente instalado**, porque isso gasta tokens.
