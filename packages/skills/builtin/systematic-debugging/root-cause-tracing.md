# Rastrear a causa raiz

Parte da skill `systematic-debugging` (Superpowers, de Jesse Vincent, licença MIT), traduzida e adaptada para o Hive.

Bugs costumam aparecer fundo na pilha de chamadas: um `git init` na pasta errada, um arquivo criado no lugar errado, um banco aberto com o caminho errado. O instinto é corrigir onde o erro aparece, mas isso é tratar o sintoma.

**Princípio:** volte pela cadeia de chamadas até achar o gatilho original e corrija na origem.

## Quando usar

- O erro acontece fundo na execução, não na entrada.
- A pilha de chamadas é longa.
- Não está claro de onde veio o dado inválido.
- Você precisa descobrir qual teste ou trecho de código provoca o problema.

## O processo

1. **Observe o sintoma:** `Erro: git init falhou em ~/projeto/packages/core`.
2. **Ache a causa imediata:** que linha provoca isso diretamente? Ex.: `execFile('git', ['init'], { cwd: projectDir })`.
3. **Pergunte quem chamou:** `criarWorktree(projectDir)` ← `iniciarSessao()` ← `Sessao.criar()` ← o teste.
4. **Continue subindo e olhe os valores:** `projectDir = ''` (vazio!). Um `cwd` vazio vira a pasta atual: a pasta do código-fonte.
5. **Ache o gatilho original:** de onde veio a string vazia? O teste leu `contexto.tempDir` antes do `beforeEach` preenchê-lo.

**Correção na origem:** fazer `tempDir` falhar se for lido cedo demais, e não "tratar string vazia" lá no `git init`.

## Quando não dá para rastrear à mão

Registre o contexto **antes** da operação perigosa:

```ts
async function gitInit(directory: string) {
  console.error('DEPURAR git init:', {
    directory,
    cwd: process.cwd(),
    stack: new Error().stack,
  });
  await execFile('git', ['init'], { cwd: directory });
}
```

- Nos testes use `console.error()`: o logger pode estar silenciado.
- Registre antes de a operação falhar, não depois.
- Inclua o contexto: pasta, `cwd`, variáveis de ambiente.
- `new Error().stack` mostra a cadeia completa de chamadas.

Rode os testes com `run_command`, procure as linhas `DEPURAR` na saída e veja o nome do arquivo de teste e a linha que disparou a chamada.

## Qual teste causa a sujeira?

Se algo aparece durante os testes e você não sabe qual teste é o culpado, rode os arquivos de teste um por um (ou em metades, como numa busca binária) e veja depois de qual o problema surge.

## Depois de corrigir

Acrescente validação em mais de uma camada (veja `defense-in-depth.md`), para que o bug fique impossível e não apenas corrigido.

**NUNCA corrija só onde o erro aparece.** Volte até o gatilho original.
