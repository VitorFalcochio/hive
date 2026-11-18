---
name: code-review-and-quality
description: 'Use ao revisar qualquer mudança (sua, de outro agente ou de uma pessoa) antes de ela entrar: revisão em cinco eixos (correção, legibilidade, arquitetura, segurança e desempenho), com cada achado classificado por gravidade.'
license: MIT
metadata:
  origin: Addy Osmani
  author: Addy Osmani
  source: https://github.com/addyosmani/agent-skills/tree/main/skills/code-review-and-quality
  adapted: 'Traduzida para o português e adaptada ao revisor do Hive'
---

# Revisão de código e qualidade

Toda mudança é revisada antes de entrar, sem exceção, em cinco eixos: correção, legibilidade, arquitetura, segurança e desempenho.

**O critério para aprovar:** aprove quando a mudança melhora com certeza a saúde geral do código, mesmo que não esteja perfeita. Código perfeito não existe. Não bloqueie só porque não está do jeito que você escreveria; se melhora o projeto e segue as convenções, aprove.

**No Hive** o revisor lê e não edita: você aponta os problemas com arquivo e linha, e quem escreveu corrige.

## Os cinco eixos

### 1. Correção

O código faz o que diz fazer?

- Atende à tarefa e aos critérios de aceite?
- Trata os casos de borda (nulo, vazio, valores-limite)?
- Trata os caminhos de erro, e não só o caminho feliz?
- Os testes testam a coisa certa?
- Há erro de um a mais ou a menos, condição de corrida, estado inconsistente?

### 2. Legibilidade e simplicidade

Outro engenheiro (ou agente) entende sem o autor explicar?

- Os nomes descrevem e seguem as convenções do projeto? (Nada de `temp`, `dados`, `resultado` sem contexto.)
- O fluxo é direto, sem ternários aninhados nem callbacks profundos?
- Há truque "esperto" que deveria ser simplificado?
- **Daria para fazer com menos linhas?** Mil linhas onde cem bastam é falha.
- **As abstrações pagam a complexidade que trazem?** Não generalize antes do terceiro caso de uso.
- Ficou código morto: variáveis que não fazem nada, comentários "// removido"?
- **Um `if` novo foi pendurado num fluxo que não tem nada a ver?** Isso é problema de design, não detalhe.

### 3. Arquitetura

A mudança combina com o desenho do sistema?

- Segue os padrões existentes ou cria um novo? Se novo, tem justificativa?
- Mantém as fronteiras entre módulos?
- Há duplicação que deveria ser compartilhada?
- As dependências vão na direção certa, sem ciclos?
- **A refatoração reduz a complexidade ou só muda de lugar?** Conte os conceitos que o leitor precisa guardar. Se continuam os mesmos, não ficou mais limpo.
- **Lógica de uma funcionalidade vazou para um módulo compartilhado?**
- **Os tipos nas fronteiras são explícitos?** Desconfie de `any`, conversões forçadas e valores padrão silenciosos que escondem uma regra confusa.

### 4. Segurança

Detalhes na skill `security-and-hardening`.

- A entrada do usuário é validada?
- Segredos ficam fora do código, dos logs e do git?
- Login e permissão são conferidos onde precisa?
- As consultas são parametrizadas?
- A saída é codificada contra XSS?
- Dados de fora (APIs, conteúdo de usuário, arquivos) são tratados como não confiáveis?

### 5. Desempenho

Detalhes na skill `performance-optimization`.

- Alguma consulta N+1?
- Laço ou busca sem limite?
- Lista sem paginação?
- Renderizações desnecessárias na interface?

## Proponha a solução, não só o problema

Uma revisão que diz só "isto está complexo" deixa o autor adivinhando. Proponha uma reestruturação com nome:

- Trocar uma cadeia de `if` por um modelo com tipos ou um despachante explícito.
- Juntar ramos duplicados num fluxo só, mais claro.
- Separar a orquestração da regra de negócio.
- Mover a lógica da funcionalidade para o módulo dono dela.
- Usar a função auxiliar que já existe em vez de uma quase igual.
- Apagar um invólucro que só repassa a chamada.
- Extrair uma função ou dividir um arquivo grande.

Prefira a solução que **remove** peças à que só espalha a mesma complexidade.

## Tamanho da mudança

```
~100 linhas alteradas  → bom, revisável de uma vez
~300 linhas            → aceitável, se for uma mudança lógica só
~1000 linhas           → grande demais: peça para dividir
```

Olhe também o tamanho do arquivo: perto de 1000 linhas no total, vale extrair antes de acrescentar mais. Refatoração e funcionalidade nova na mesma mudança são duas mudanças.

## O processo

1. **Entenda o contexto:** o que a mudança quer fazer, qual tarefa ela implementa, que comportamento deveria mudar. Leia a tarefa e os critérios de aceite.
2. **Leia os testes primeiro:** eles existem? Testam comportamento, não detalhes de implementação? Cobrem os casos de borda? Pegariam uma regressão? Teste mentalmente: se você invertesse uma condição que a mudança acrescenta, algum teste falharia? Se não, aponte o caso de teste que falta.
3. **Leia a implementação** arquivo por arquivo, pensando nos cinco eixos. Para interface, abra a página com `view_page` e olhe a tela e o console.
4. **Classifique os achados.** Antes de apontar algo, confira os chamadores, as proteções e os testes que chegam ao trecho; descarte o que eles já resolvem. Separe defeitos que já existiam das regressões que esta mudança trouxe. **Zero achados é um resultado válido: não invente.**

| Prefixo         | Significado     | O que o autor faz                                           |
| --------------- | --------------- | ----------------------------------------------------------- |
| **Crítico:**    | Bloqueia        | Falha de segurança, perda de dados, funcionalidade quebrada |
| _(sem prefixo)_ | Obrigatório     | Precisa resolver antes de entrar                            |
| **Considere:**  | Sugestão        | Vale pensar, não é obrigatório                              |
| **Detalhe:**    | Menor, opcional | Pode ignorar: formatação, preferência de estilo             |
| **Para saber:** | Só informação   | Nenhuma ação                                                |

**Comece pelo que importa:** correção e segurança primeiro, depois problemas de estrutura, depois o resto. Poucos comentários convictos valem mais que uma lista longa. Se há um problema estrutural e dez detalhes, o problema estrutural **é** a revisão.

5. **Confira a verificação do autor:** que testes rodaram? O build passou? Para interface, a tela foi conferida? Há comparação de antes e depois? Desconfie de "os testes passam" sem a saída do comando.

## Honestidade na revisão

- **Não carimbe.** "Aprovado" sem ter revisado de verdade não ajuda ninguém.
- **Não amenize problema real.** Chamar de "talvez uma pequena preocupação" um bug que vai estourar em produção é desonesto.
- **Quantifique quando der:** "esta consulta N+1 soma uns 50 ms por item da lista" é melhor que "pode ficar lento".
- **Discorde de abordagens com problema claro,** e proponha alternativas. Bajulação é uma falha de revisão.
- **Comente o código, não as pessoas.**

## Dependências

Antes de aceitar uma dependência nova: o que já existe no projeto resolve? Qual o tamanho? É mantida? Tem vulnerabilidade conhecida? A licença é compatível? Prefira a biblioteca padrão e o que já existe. Toda dependência é um passivo. Atualizações de dependência são mudanças de comportamento: uma por vez, com o changelog lido.

## Código morto

Depois de uma refatoração, liste o código que ficou sem uso e pergunte antes de apagar:

```
CÓDIGO SEM USO:
- formatarDataAntiga() em src/utils/data.ts, substituída por formatarData()
- CONSTANTE_API_ANTIGA em src/config.ts, sem referências
→ Pode remover?
```

## Desculpas comuns

| Desculpa                                  | Realidade                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| "Funciona, está bom."                     | Código que funciona mas é ilegível, inseguro ou mal desenhado vira dívida.                             |
| "Fui eu que escrevi, sei que está certo." | O autor não enxerga as próprias suposições.                                                            |
| "Arrumo depois."                          | Depois nunca chega. A revisão é o portão.                                                              |
| "Código de IA deve estar certo."          | Código de IA precisa de mais atenção, não menos: ele é confiante e plausível mesmo quando está errado. |
| "Os testes passam."                       | Testes não pegam problema de arquitetura, segurança nem legibilidade.                                  |

## O relato da revisão

No `finish`, entregue:

- O que você entendeu que a mudança faz.
- Os achados em ordem de gravidade, cada um com arquivo, linha, o problema e a solução proposta.
- O veredito: **aprovar** ou **pedir mudanças**.
- O que você não conseguiu conferir.
