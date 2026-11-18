# Esperar pela condição, não pelo relógio

Parte da skill `systematic-debugging` (Superpowers, de Jesse Vincent, licença MIT), traduzida e adaptada para o Hive.

Testes instáveis costumam adivinhar o tempo com esperas fixas. Isso cria condições de corrida: o teste passa numa máquina rápida e falha sob carga.

**Princípio:** espere pela condição que importa, não por um palpite de quanto tempo ela leva.

## Quando usar

- O teste tem espera fixa (`setTimeout`, `sleep`, `time.sleep()`).
- O teste é instável: às vezes passa, às vezes falha.
- O teste estoura o tempo quando roda em paralelo.
- Você está esperando uma operação assíncrona terminar.

**Não use** quando o teste mede tempo de verdade (debounce, intervalo de throttle). Nesse caso, explique em um comentário **por que** a espera fixa é necessária.

## O padrão

```ts
// ❌ Antes: adivinhando o tempo
await new Promise((r) => setTimeout(r, 50));
expect(getResultado()).toBeDefined();

// ✅ Depois: esperando a condição
await esperarAte(() => getResultado() !== undefined, 'o resultado');
expect(getResultado()).toBeDefined();
```

| Situação               | Padrão                                                    |
| ---------------------- | --------------------------------------------------------- |
| Esperar um evento      | `esperarAte(() => eventos.find((e) => e.tipo === 'FIM'))` |
| Esperar um estado      | `esperarAte(() => maquina.estado === 'pronta')`           |
| Esperar uma quantidade | `esperarAte(() => itens.length >= 5)`                     |
| Esperar um arquivo     | `esperarAte(() => existsSync(caminho))`                   |

## Implementação

```ts
async function esperarAte<T>(
  condicao: () => T | undefined | null | false,
  descricao: string,
  limiteMs = 5000,
): Promise<T> {
  const inicio = Date.now();
  while (true) {
    const resultado = condicao();
    if (resultado) return resultado;
    if (Date.now() - inicio > limiteMs)
      throw new Error(`Tempo esgotado esperando ${descricao} (${limiteMs} ms)`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
```

Muitos frameworks já trazem isso pronto (`vi.waitFor` no Vitest, `waitFor` na Testing Library, `expect.poll` no Playwright). Prefira o do projeto.

## Erros comuns

- **Verificar rápido demais** (a cada 1 ms): gasta CPU. Use uns 10 ms.
- **Sem limite de tempo:** o laço roda para sempre. Sempre tenha um limite com mensagem clara.
- **Dado velho:** ler o estado antes do laço. Leia dentro do laço, a cada volta.

## Quando a espera fixa é correta

Primeiro espere a condição que dispara o comportamento; depois, se precisar medir um tempo conhecido (ex.: duas batidas de um relógio de 100 ms), espere esse tempo e explique no comentário.

**No Hive:** o mesmo vale para servidores. Depois de subir um servidor com `run_command` e `background: true`, não espere um tempo fixo: tente abrir a página com `view_page` até ela responder.
