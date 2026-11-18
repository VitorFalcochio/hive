# Defesa em camadas

Parte da skill `systematic-debugging` (Superpowers, de Jesse Vincent, licença MIT), traduzida e adaptada para o Hive.

Quando você corrige um bug causado por dado inválido, validar num lugar só parece suficiente. Mas outro caminho do código, uma refatoração ou um mock pode passar por fora dessa checagem.

**Princípio:** valide em TODA camada por onde o dado passa. Torne o bug estruturalmente impossível.

- Uma validação: "corrigimos o bug".
- Várias camadas: "tornamos o bug impossível".

## As quatro camadas

### 1. Entrada

Recuse o que é obviamente inválido na fronteira (rota de API, função pública, formulário).

```ts
function criarProjeto(nome: string, pasta: string) {
  if (!pasta?.trim()) throw new Error('A pasta do projeto não pode ser vazia');
  if (!existsSync(pasta)) throw new Error(`A pasta não existe: ${pasta}`);
  // ...
}
```

### 2. Regra de negócio

Garanta que o dado faz sentido para esta operação.

```ts
function iniciarWorkspace(pasta: string) {
  if (!pasta) throw new Error('iniciarWorkspace precisa da pasta do projeto');
  // ...
}
```

### 3. Proteção de ambiente

Impeça operações perigosas em contextos específicos.

```ts
// Nos testes, recuse git init fora da pasta temporária.
if (process.env.NODE_ENV === 'test' && !path.resolve(pasta).startsWith(os.tmpdir()))
  throw new Error(`git init fora da pasta temporária durante os testes: ${pasta}`);
```

### 4. Registro para investigação

Guarde o contexto, para quando as outras camadas falharem.

```ts
logger.debug('Antes do git init', { pasta, cwd: process.cwd(), stack: new Error().stack });
```

## Como aplicar

1. **Rastreie o fluxo do dado:** de onde vem o valor errado e onde ele é usado?
2. **Liste todos os pontos** por onde ele passa.
3. **Valide em cada camada:** entrada, regra, ambiente, registro.
4. **Teste cada camada:** tente passar pela primeira e confira que a segunda pega.

Não pare num ponto de validação só. Cada camada pega casos que as outras deixam passar: outro caminho do código, um mock, uma diferença de plataforma.
