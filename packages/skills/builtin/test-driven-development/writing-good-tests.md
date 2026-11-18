# Escrever bons testes

Parte da skill `test-driven-development` (Superpowers, de Jesse Vincent, licença MIT), traduzida e adaptada para o Hive.

**Abra esta referência quando:** escrever ou mudar testes, criar mocks ou criar funções de limpeza e auxiliares para testes.

Um teste existe para pegar uma quebra específica. Dois princípios governam tudo aqui:

```
1. Todo teste diz qual quebra ele pega.
2. Todo teste exercita a coisa de verdade.
```

## Princípio 1: diga qual quebra o teste pega

Antes de escrever o corpo do teste, responda: **que mudança no código de produção deve fazer este teste falhar, e essa mudança é um bug ou uma decisão?** Um teste merece existir quando pega um caminho errado, um efeito que faltou, um argumento errado, um caso de borda ou um contrato quebrado.

**Calcule o esperado por conta própria.** Use valores literais e exemplos conferidos à mão. Um valor esperado calculado pelo próprio código testado passa não importa o que o código faça:

```ts
// ❌ Espelho: o mesmo construtor calcula os dois lados, sempre igual
const esperado = montarBusca({ tag: 'urgente' });
expect(montarBusca({ tag: 'urgente' })).toBe(esperado);

// ✅ Literal conferido à mão
expect(montarBusca({ tag: 'urgente' })).toBe('tag:"urgente"');
```

**Nada de detector de mudança.** Se só decisões intencionais fazem o teste falhar (o valor de uma constante, o texto exato de uma mensagem, a estrutura privada), ele dispara em qualquer redesenho e dorme diante dos bugs. Teste o comportamento que depende da decisão: em vez de `expect(MAX_TENTATIVAS).toBe(5)`, "uma chamada que falha é tentada 5 vezes, e a sexta nunca acontece".

**Comportamento, não texto.** Conferir que um script ou configuração contém uma linha exata só prova que o arquivo é o arquivo. Rode o script com entradas controladas e confira a saída, os efeitos ou o código de saída.

**O seu código, não o framework.** Teste o contrato que o seu código faz nas fronteiras: a rota que você registra, a consulta que você monta, o payload que você produz. Conferir que o roteador chama o handler registrado é teste do framework, não seu. Construtores, getters e constantes só merecem teste quando validam, normalizam, calculam ou causam efeitos.

### O portão

```
ANTES de escrever o corpo do teste:
  Diga que mudança no código faria este teste falhar.

  Não consegue dizer          → redesenhe em torno de um comportamento observável
  "O texto do arquivo mudou"  → rode o artefato e confira os efeitos
  Só decisões intencionais    → detector de mudança: teste o comportamento

  Confirme que o esperado foi calculado sem o código testado.
```

## Princípio 2: exercite a coisa de verdade

**O mock não merece asserção.** Uma asserção sobre o mock passa quando o mock existe e falha quando ele some: não diz nada sobre o componente. Confira o comportamento do componente real.

```ts
// ✅ Comportamento real
expect(screen.getByRole('navigation')).toBeInTheDocument();
// ❌ Existência do mock
expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument();
```

**Mock no nível certo.** Conheça todos os efeitos do método real antes de substituí-lo. Mocke a parte lenta ou externa e mantenha real o que o teste usa. Na dúvida, rode o teste com a implementação real primeiro.

**Dublês específicos.** Quando argumentos, número de chamadas ou ordem fazem parte do contrato, confira. Um falso que aceita qualquer coisa não verifica nada. Dê a cada caminho (sucesso, erro, dado malformado) o seu próprio exemplo.

**Espelhe o dado real por completo.** Mocke a estrutura inteira como ela é na realidade, com todos os campos documentados. Mocks parciais falham em silêncio quando outro trecho lê o campo que faltou.

**Classe de produção só tem método de produção.** Limpeza que só os testes usam fica em utilitários de teste, nunca num `destroy()` da classe de produção.

**Prefira componentes reais a mocks complicados.** Quando a preparação do mock fica maior que a lógica do teste, troque por um teste de integração com os componentes reais.

## A conferência por mutação

Antes de terminar, imagine mudanças no código de produção. Para cada mudança realista, pelo menos um teste deve falhar:

- Constante ou argumento errado.
- Caminho errado num `if`.
- Mudança de estado ou efeito que faltou.
- Retorno vazio ou padrão.
- Validação que faltou para zero, vazio, nulo, sem permissão ou dado malformado.

Uma mutação que nenhum teste pega mostra um comportamento desprotegido, ou um teste que não testa nada.

## Sinais de alerta

- Preparação e asserção usam o mesmo objeto, garantindo a igualdade.
- O teste só falha com erro fatal ou seletor sumido.
- O teste falha em toda mudança intencional e nunca numa quebra acidental.
- Os valores esperados ficam escondidos atrás de laços ou funções auxiliares.
- O teste existe só para cobertura, sem conferir efeito nem resultado.
- Uma asserção confere o mock, ou falha se você tirar o mock.
- A preparação do mock é mais da metade do teste.
