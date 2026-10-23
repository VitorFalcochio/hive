/**
 * Skills that ship with Hive. They are copied into the user's library once, where they can be
 * edited like any other local skill; `restore` puts the original text back. Kept short because
 * an agent's skills go into its system prompt on every step.
 */
export interface BuiltinSkill {
  name: string;
  raw: string;
}

const skill = (name: string, description: string, body: string): BuiltinSkill => ({
  name,
  raw: `---
name: ${name}
description: ${JSON.stringify(description)}
license: MIT
metadata:
  origin: hive
---

${body.trim()}
`,
});

export const builtinSkills: BuiltinSkill[] = [
  skill(
    'planejar-tarefas',
    'Quebra um objetivo em tarefas pequenas, paralelas e verificáveis, com dependências e critérios de aceite. Use ao planejar uma missão.',
    `
# Planejar tarefas

## Antes de planejar
- Releia o objetivo e separe o que foi pedido do que seria só desejável. Planeje o pedido.
- Se você tem ferramentas, olhe a estrutura do projeto (\`list_dir\` na raiz, README, package.json) e os arquivos que o objetivo toca. Um plano que cita arquivos reais é muito melhor que um genérico.
- Sem acesso aos arquivos, descreva a área (ex.: "a tela de login", "a rota de pedidos") e deixe o agente encontrar os arquivos.

## Como dividir
- Cada tarefa entrega **uma** mudança que dá para verificar sozinha. Se a descrição precisa de "e também", provavelmente são duas.
- Tamanho certo: algo que um agente termina em 10 a 30 passos. Mais que isso, divida.
- Separe por arquivos: duas tarefas em paralelo não devem editar o mesmo arquivo. Se precisarem, crie uma dependência entre elas.
- Dependência só quando uma tarefa realmente precisa do resultado da outra (ex.: a API antes da tela que a consome). Dependências desnecessárias deixam tudo sequencial.
- Entregue cada tarefa ao agente cuja descrição combina com ela. Testes para o QA, revisão para o revisor.

## Critérios de aceite
Escreva critérios que um agente consegue checar com um comando ou lendo o código:
- Bom: "\`npm test\` passa e há um teste para o caso de e-mail inválido."
- Ruim: "O código está bom." / "Funciona corretamente."

## Evite
- Tarefas de "pesquisar" ou "entender o código" sem entrega. Explorar faz parte de cada tarefa.
- Reescritas grandes quando o objetivo pede uma mudança pequena.
- Inventar requisitos que o usuário não pediu.
`,
  ),
  skill(
    'verificar-antes-de-concluir',
    'Confere o próprio trabalho com os comandos do projeto antes de declarar a tarefa pronta, e relata o resultado com honestidade. Use em toda tarefa que altera código.',
    `
# Verificar antes de concluir

Uma tarefa só está pronta quando você **viu** que funciona, não quando o código parece certo.

## Descubra os comandos do projeto
Procure em package.json (scripts), Makefile, pyproject.toml, Cargo.toml, go.mod ou no README. Use os comandos do próprio projeto; não invente outros nem instale ferramentas novas.

## Ordem de verificação
1. **Tipos/compilação** (ex.: \`npm run typecheck\`, \`tsc --noEmit\`, \`cargo check\`).
2. **Testes ligados à mudança** primeiro; depois a suíte inteira, se for rápida.
3. **Lint/format**, se o projeto tiver.
Se um comando falhar, leia o erro inteiro, corrija e rode de novo. Não pare no primeiro "deve funcionar".

## Antes do finish, releia sua mudança
- Ficou algum código de depuração, \`console.log\`, TODO seu ou arquivo temporário?
- Mudou algo que a tarefa não pediu? Desfaça.
- O estilo (nomes, aspas, recuo, idioma dos comentários) bate com o resto do arquivo?

## Relato no finish
- O que mudou, por arquivo.
- Os comandos que rodou e o resultado **real** de cada um.
- O que não conseguiu verificar e por quê.
Nunca diga que testes passaram se você não os rodou. Falha relatada com clareza vale mais que sucesso inventado.
`,
  ),
  skill(
    'depurar-sistematicamente',
    'Encontra a causa raiz de um bug reproduzindo, levantando hipóteses e testando uma de cada vez antes de corrigir. Use quando algo falha ou se comporta errado.',
    `
# Depurar sistematicamente

## 1. Reproduza
Rode o teste, comando ou cenário que mostra o erro e guarde a mensagem exata. Sem reprodução, você está chutando. Se não houver como reproduzir, escreva um teste pequeno que mostre o problema.

## 2. Leia o erro de verdade
Stack trace: comece pela primeira linha que aponta para código do projeto, não da biblioteca. Leia a função inteira ali, não só a linha.

## 3. Hipóteses, uma por vez
Liste 2 ou 3 causas possíveis e comece pela mais provável e mais barata de checar. Para cada uma, diga o que você esperaria ver se ela fosse verdade e verifique (ler o código, buscar quem chama, rodar com um caso menor).

## 4. Corrija a causa, não o sintoma
- Um \`try/catch\` que engole o erro, um \`if (x)\` a mais ou um valor padrão que esconde o problema não são correção.
- Busque (\`search\`) outros lugares com o mesmo padrão defeituoso.

## 5. Prove
Rode a reprodução de novo: tem que passar. Se possível, deixe um teste que falharia sem a correção. Rode os testes próximos para garantir que nada quebrou.

## Se travar
Depois de três tentativas sem progresso, pare de mexer no código. Releia o erro, reveja as hipóteses descartadas e relate o que já sabe em vez de continuar tentando às cegas.
`,
  ),
  skill(
    'escrever-testes',
    'Escreve testes focados no comportamento, cobrindo casos de borda e erros, no estilo que o projeto já usa. Use ao criar ou revisar testes.',
    `
# Escrever testes

## Siga o projeto
1. Descubra o framework e onde os testes moram: procure arquivos \`*.test.*\`, \`*.spec.*\`, \`test_*.py\`, \`tests/\`.
2. Leia um ou dois testes vizinhos e copie o estilo: nomes, idioma das descrições, helpers e fixtures.
3. Rode só o arquivo de teste novo enquanto trabalha; a suíte inteira no fim.

## O que testar
- **Comportamento**, não implementação: entrada e saída, efeito visível. Um teste não deve quebrar só porque uma função interna mudou de nome.
- Para cada função alterada: o caso comum, os casos de borda (vazio, zero, um, limite, texto com acentos ou espaços) e o caso de erro (entrada inválida, falha de rede ou disco).
- Para um bug: um teste que falha **antes** da correção e passa depois.

## Testes bons
- Um comportamento por teste, com um nome que diz qual é ("rejeita e-mail sem @").
- Estrutura preparar → agir → conferir.
- Determinísticos: sem depender de horário, ordem aleatória, rede real ou testes anteriores. Fixe datas e use pastas temporárias.
- Mocks só nas bordas (rede, relógio, sistema de arquivos caro). Mockar o próprio código testado não testa nada.

## Relato
Informe o comando exato que rodou, quantos testes passaram e falharam, e o que ficou sem cobertura.
`,
  ),
  skill(
    'revisar-codigo',
    'Revisa mudanças procurando defeitos concretos, com arquivo, linha e cenário de falha, por ordem de gravidade. Use ao revisar código ou um diff.',
    `
# Revisar código

O objetivo é achar **problemas reais**, não comentar estilo. Uma revisão com três defeitos verdadeiros vale mais que vinte opiniões.

## Como ler
1. Entenda a intenção: o que a mudança tenta fazer?
2. Para cada função alterada, leia quem chama e o que ela chama (\`search\` pelo nome). Bugs moram nas bordas entre funções.
3. Pergunte em cada trecho: e se for vazio? nulo? muito grande? concorrente? falhar no meio?

## O que procurar, nesta ordem
1. **Correção:** lógica invertida, erro de um a mais ou a menos, caso não tratado, \`await\` faltando, estado que não é limpo, erro engolido.
2. **Segurança:** entrada do usuário em SQL, shell, HTML ou caminho de arquivo; segredos no código ou em logs; falta de checagem de permissão.
3. **Dados:** perda ou corrupção, migração irreversível, operação parcial sem transação.
4. **Desempenho:** consulta dentro de laço, trabalho repetido, leitura de arquivo inteiro sem necessidade.
5. **Manutenção:** duplicação de algo que já existe no projeto, nome enganoso. Só se for relevante.

## Antes de relatar, confirme
Releia o código para ter certeza: o caso já é tratado em outro lugar? O tipo impede isso? Descarte o que não se sustenta.

## Formato
Para cada problema, por gravidade:
- **[alta|média|baixa]** \`arquivo:linha\`: o defeito em uma frase.
- Cenário: entrada ou estado concreto → resultado errado.
- Sugestão de correção, curta.
Termine com o que está bom, em uma ou duas linhas. Se não achou nada grave, diga isso claramente.
`,
  ),
  skill(
    'seguranca-no-codigo',
    'Checklist das falhas de segurança mais comuns (injeção, segredos, autorização, uploads, dependências) para aplicar ao escrever ou revisar código.',
    `
# Segurança no código

Aplique ao escrever ou revisar qualquer código que lide com entrada externa, arquivos, banco, rede ou autenticação.

## Injeção
- **SQL:** sempre parâmetros/placeholders do driver ou ORM. Nunca monte SQL concatenando texto do usuário.
- **Shell:** prefira APIs que recebem argumentos em lista (\`execFile\`, \`subprocess.run([...])\`). Nunca passe texto do usuário para \`exec\` ou \`shell=True\`.
- **HTML:** deixe o framework escapar. \`innerHTML\`, \`dangerouslySetInnerHTML\` e \`v-html\` só com conteúdo sanitizado.
- **Caminhos:** resolva o caminho e confira que continua dentro da pasta permitida (evita \`../\`).

## Segredos
- Nada de chave, senha ou token no código, em testes ou em logs. Use variáveis de ambiente e confira se \`.env\` está no \`.gitignore\`.
- Mensagens de erro para o usuário não devem expor stack trace, SQL ou caminhos internos.

## Autenticação e autorização
- Toda rota que lê ou altera dados confere **quem** pede e **se pode** acessar aquele recurso específico, não só se está logado.
- Senhas com bcrypt/argon2/scrypt, nunca hash simples. Compare tokens em tempo constante.

## Entrada
- Valide no servidor: tipo, tamanho, formato e limites. Validação no cliente é só conforto.
- Uploads: limite de tamanho, tipo conferido pelo conteúdo, nome gerado pelo servidor, fora da pasta pública executável.

## Dependências e configuração
- Não adicione dependências sem necessidade. Se adicionar, prefira as conhecidas e mantidas.
- CORS, cookies (\`HttpOnly\`, \`Secure\`, \`SameSite\`) e cabeçalhos com o mínimo necessário, nunca \`*\` por conveniência.
`,
  ),
  skill(
    'interface-de-qualidade',
    'Constrói telas que seguem o padrão visual do projeto, tratam carregando, vazio e erro, e são acessíveis e responsivas. Use ao criar ou alterar interface.',
    `
# Interface de qualidade

## Siga o que existe
1. Antes de criar um componente, busque se já há um parecido (botão, modal, campo, lista). Reutilize.
2. Use os tokens do projeto (variáveis CSS, tema, classes utilitárias) em vez de cores e tamanhos soltos.
3. Copie o padrão dos componentes vizinhos: estrutura de arquivo, nomes, como buscam dados e tratam estado.

## Todo dado tem quatro estados
Para cada tela ou componente que carrega dados, trate: **carregando**, **vazio** (com uma frase útil, não só "Nenhum item"), **erro** (com o que o usuário pode fazer) e **sucesso**. Desabilite botões enquanto uma ação está em andamento, para evitar clique duplo.

## Acessibilidade básica
- Use o elemento certo: \`button\` para ações, \`a\` para navegação, \`label\` ligado a cada campo.
- Botão só com ícone precisa de \`aria-label\`. Imagem informativa precisa de \`alt\`.
- Tudo funciona pelo teclado, com foco visível. Modais fecham com Esc e devolvem o foco.
- Contraste suficiente; não comunique algo só pela cor.

## Responsivo
Confira a tela estreita (cerca de 360px): nada de rolagem horizontal, texto longo quebra ou é cortado com reticências, alvos de toque com pelo menos 32px.

## Texto
Mesmo idioma e tom do resto da interface. Rótulos curtos e diretos; mensagens de erro dizem o que aconteceu e o que fazer.

## Verifique
Rode o build, typecheck e testes de componente do projeto. Se não der para ver a tela, descreva no finish o que precisa ser conferido visualmente.
`,
  ),
  skill(
    'apis-e-dados',
    'Boas práticas para serviços, APIs e acesso a dados: validação, erros explícitos, transações, migrações e consultas eficientes. Use em trabalho de backend.',
    `
# APIs e dados

## Entrada e saída
- Valide toda entrada na borda (schema: zod, pydantic, etc.) e rejeite cedo, com status e mensagem claros (400 com o campo inválido, 404, 409, 422).
- Respostas com formato consistente com o resto da API. Não vaze campos internos (hash de senha, ids de outros usuários).
- Listas paginadas, com limite máximo.

## Erros
- Trate erros explicitamente: o que é erro do cliente (4xx) e o que é falha interna (5xx).
- Não engula exceções. Registre com contexto suficiente para investigar (id da operação, entidade), sem dados sensíveis.
- Chamadas externas com timeout. Repetição só em operações idempotentes.

## Banco de dados
- Operações que mudam várias tabelas ficam numa **transação**: ou tudo, ou nada.
- Evite consulta dentro de laço (N+1): busque em lote ou com join.
- Mudança de esquema sempre por **migração** nova, nunca editando uma já aplicada. Pense nos dados que já existem: coluna nova com padrão, ou permitindo nulo.
- Índice nas colunas usadas em filtros e joins frequentes.

## Estrutura
- Funções pequenas, com uma responsabilidade. Regra de negócio fora do handler HTTP, para poder testar sem servidor.
- Siga as camadas que o projeto já tem (rotas → serviços → repositórios, ou o que existir).
- Configuração por variável de ambiente, com valor padrão seguro e validação na inicialização.

## Verifique
Rode os testes do serviço. Para endpoint novo ou alterado, teste o sucesso, a entrada inválida e o recurso inexistente.
`,
  ),
  skill(
    'decisoes-de-arquitetura',
    'Toma decisões de estrutura com o menor impacto possível, respeitando as fronteiras do projeto, e registra o porquê. Use ao desenhar módulos, pastas ou integrações.',
    `
# Decisões de arquitetura

## Entenda antes de desenhar
1. Mapeie como o projeto está organizado hoje: pastas, camadas, como os módulos se comunicam, onde fica o estado.
2. Ache o exemplo mais parecido já existente e use como modelo. Consistência vale mais que a solução teoricamente ideal.

## Princípios
- **Menor mudança que resolve.** Não reestruture o que não está no caminho da tarefa.
- **Fronteiras claras:** cada módulo tem uma responsabilidade e uma interface pequena. Dependências apontam para dentro (UI → serviço → domínio), nunca ao contrário.
- **Sem abstração antecipada:** espere a terceira repetição antes de generalizar. Uma interface com uma única implementação raramente se paga.
- **Sem dependência nova** se a biblioteca padrão ou algo já instalado resolve.
- Pense em como testar: se é difícil testar, a fronteira provavelmente está no lugar errado.

## Ao propor
Para cada decisão relevante, registre em poucas linhas, no finish ou num arquivo de notas se o projeto tiver (ex.: \`docs/\`):
- **Contexto:** o problema.
- **Decisão:** o que foi escolhido.
- **Alternativas** consideradas e por que não.
- **Consequências:** o que fica mais fácil, o que fica mais difícil.

## Scaffolding
Ao criar a estrutura para outros agentes, deixe cada arquivo com o mínimo que compila e os tipos e assinaturas definidos, para que as tarefas seguintes possam trabalhar em paralelo sem conflito.
`,
  ),
];

export const builtinSkillNames = builtinSkills.map((item) => item.name);

export function builtinSkill(name: string): BuiltinSkill | undefined {
  return builtinSkills.find((item) => item.name === name);
}
