# Hive

Workspace desktop em Electron + React para coordenar agentes de desenvolvimento.

## Rodar no Windows

Instale o **Node.js 24** e o **Git**. Na pasta do projeto:

```powershell
npm run setup
npm run dev
```

Não é necessário instalar o pnpm globalmente. O comando de setup prepara a versão fixada no projeto e instala as dependências. A primeira instalação precisa de acesso à internet e baixa o Electron.

Para usar o build de produção local:

```powershell
npm run build
npm start
```

Os caches, arquivos temporários e dados do aplicativo ficam em `.local/`, na mesma unidade do projeto. Isso permite rodar mesmo quando a unidade C: está cheia. O banco fica em `.local/data/hive.sqlite`. Essa pasta não deve ser versionada nem apagada se quiser preservar suas configurações. Para usar outra pasta de dados, defina `HIVE_DATA_DIR` antes de iniciar.

## Primeiros passos

1. Abra uma pasta que já seja um repositório Git. Para criar missões, ela precisa ter pelo menos um commit.
2. Em **Rodar**, execute `npm run dev`, testes ou builds. O terminal simples mostra a saída ao vivo e detecta endereços locais para abrir o **Live Preview** dentro do Hive. Ele não aceita respostas interativas no stdin.
3. Em **Código**, abra um arquivo e use **IA no código** (`Ctrl+I`). Selecione um trecho para editar, explicar ou revisar. Alterações propostas aparecem como diff e só entram no editor depois de clicar em **Aceitar no editor**; salve normalmente com `Ctrl+S`.
4. Em **Provedores**, cadastre a URL da API. Salve a chave, quando necessária, e teste a conexão. Servidores locais compatíveis podem funcionar sem chave.
5. Em **Agentes**, clique em **Aplicar configuração recomendada**. O Hive escolhe um modelo para cada agente e testa cada um com uma chamada mínima, ignorando modelos que o provedor ainda lista mas já desativou (o erro `Not found (404) … Function … Not found for account` da NVIDIA). Também é possível escolher manualmente e usar **Testar modelo**.
6. Crie uma missão e clique em **Gerar plano com a Queen**. Essa ação chama a API escolhida e pode consumir créditos do provedor.
7. Clique em **Executar plano**. Cada tarefa roda numa worktree Git própria, fora do seu repositório (em `.local/data/worktrees`), numa branch `hive/…`. Comandos dos agentes pedem sua aprovação. Ao terminar, revise as alterações de cada tarefa e clique em **Aplicar no projeto** (merge na sua branch, exige repositório sem alterações não commitadas) ou **Descartar**.

O cadastro de repositórios, provedores e agentes, o catálogo de skills e a geração de planos estão conectados ao SQLite. As chaves usam o armazenamento criptográfico do sistema operacional e não voltam para a interface.

## Onde o código parou

Os pacotes de domínio, persistência SQLite, provedores, ferramentas dos agentes, worktrees Git e planejamento da Queen já existiam. A inicialização do Electron, preload, interface React, configurações de build, entrada do orquestrador e bootstrap local foram adicionados para tornar essa base executável.

A execução de missões está conectada: o `Scheduler` (`packages/orchestrator/src/scheduler.ts`) roda as tarefas em ordem de dependência e em paralelo (limite em `maxConcurrentTasks`), junta o trabalho das dependências na worktree de cada tarefa, pede aprovação de comandos, registra a atividade e guarda o resultado num commit da branch da tarefa. A aba **Código** traz explorador de arquivos com status do Git, editor Monaco com abas, tela dividida (Ctrl+\), busca de arquivos (Ctrl+P), diff das suas alterações e das tarefas dos agentes, e troca de branch (incluindo as branches `hive/…` das tarefas). Salvar detecta se o arquivo mudou por fora e nunca sobrescreve sem perguntar. O painel **IA no código** usa o provedor do agente escolhido para conversar sobre o arquivo e transformar pedidos de edição em propostas revisáveis, sem escrever no disco automaticamente. A aba **Rodar** mantém sessões de comandos, permite parar, reiniciar e limpar a saída, detecta URLs locais e atualiza o preview quando arquivos do projeto mudam. O **Design Mode** (botão de seta no cabeçalho do Live Preview) permite clicar em um elemento da página e ver seu seletor, texto, tamanho e estilos computados. Ele funciona em páginas de servidores locais (`localhost`, `127.0.0.1`). Em **Editar estilos**, você ajusta cor, fundo, tamanho da fonte, espaçamento e raio da borda, escolhe o arquivo do componente e pede uma proposta à IA. A proposta abre no painel **IA no código** para revisão; nada é gravado até você aceitar e salvar com `Ctrl+S`. Não é necessário configurar nenhuma API para abrir o aplicativo e explorar as telas.

## Verificação

```powershell
npm run typecheck
npm test
npm run build
npm run check
```

Os testes usam dados temporários e provedores simulados; não fazem chamadas pagas.
