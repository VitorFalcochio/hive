# Padrões de otimização

Parte da skill `performance-optimization` (Addy Osmani, licença MIT), traduzida e adaptada para o Hive.

Correções prontas para os problemas do passo 3 da skill. Abra só a seção do gargalo que você já identificou: não é para ler de cabo a rabo.

## Consultas N+1 (backend)

```ts
// ❌ N+1: uma consulta por tarefa para buscar o dono
const tarefas = await db.tarefas.findMany();
for (const tarefa of tarefas)
  tarefa.dono = await db.usuarios.findUnique({ where: { id: tarefa.donoId } });

// ✅ Uma consulta só, com a relação incluída
const tarefas = await db.tarefas.findMany({ include: { dono: true } });
```

## Busca sem limite

```ts
// ❌ Todos os registros
const todas = await db.tarefas.findMany();
// ✅ Paginado, com limite e ordem estável
const tarefas = await db.tarefas.findMany({
  take: 20,
  skip: (pagina - 1) * 20,
  orderBy: { criadoEm: 'desc' },
});
```

## Consulta que ignora o índice

O plano da consulta é a medição:

```sql
EXPLAIN ANALYZE
SELECT id, titulo FROM tarefas
WHERE dono_id = 42 ORDER BY criado_em DESC LIMIT 20;
```

| O que aparece                                            | O que significa                                            |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `Seq Scan` numa tabela grande, onde você esperava índice | Não há índice que sirva para esse filtro                   |
| Estimativa de `rows=` muito diferente do real            | Estatísticas velhas: rode `ANALYZE` em vez de criar índice |
| Um `Sort` acima da leitura                               | O índice cobre o filtro, mas não o `ORDER BY`              |

Indexe pelo **formato da consulta**: no índice composto, colunas de igualdade primeiro, depois a de intervalo ou ordenação.

```sql
CREATE INDEX idx_tarefas_dono_criado ON tarefas (dono_id, criado_em DESC);
```

**Quando o índice não ajuda:**

- Filtro pelo valor dominante (`status` que é 95% `ativo`, filtrando `ativo`): a leitura sequencial é mesmo mais barata. Para o valor raro, um índice parcial.
- Curinga no começo (`LIKE '%termo'`): precisa de trigramas ou busca de texto.
- Função na coluna (`WHERE lower(email) = ?`): indexe a expressão.
- Tabela com muita escrita: cada índice custa em todo `INSERT`/`UPDATE`.

Rode o `EXPLAIN ANALYZE` de novo depois. Índice que não mudou o plano é desfeito.

## Pool de conexões esgotado

Sinal típico: **todas** as rotas ficam lentas ao mesmo tempo, esperando conexão, e o banco mostra a maioria das sessões paradas.

```ts
// ❌ Um pool por requisição ou por módulo
// ✅ Um pool por processo, dimensionado pelo limite do banco
const pool = new Pool({
  max: 10, // processos × max abaixo do max_connections do banco
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000, // falha rápido em vez de esperar para sempre
});
```

Pool maior não é mais rápido: só muda a fila de lugar. Com número de processos sem limite (serverless), use um proxy de conexões (pgbouncer).

## Imagens (frontend)

```html
<!-- ❌ Sem dimensões, sem formato moderno -->
<img src="/destaque.jpg" />

<!-- ✅ Imagem principal: formatos modernos, tamanhos certos, prioridade alta -->
<picture>
  <source
    srcset="/destaque-800.avif 800w, /destaque-1600.avif 1600w"
    sizes="(max-width: 1200px) 100vw, 1200px"
    type="image/avif"
  />
  <source
    srcset="/destaque-800.webp 800w, /destaque-1600.webp 1600w"
    sizes="(max-width: 1200px) 100vw, 1200px"
    type="image/webp"
  />
  <img
    src="/destaque.jpg"
    width="1200"
    height="600"
    fetchpriority="high"
    alt="Tênis de corrida azul sobre a pista"
  />
</picture>

<!-- ✅ Imagem abaixo da dobra: carrega quando chegar perto -->
<img
  src="/produto.webp"
  width="800"
  height="800"
  loading="lazy"
  decoding="async"
  alt="Tênis casual branco, vista lateral"
/>
```

## Renderizações demais (React)

```tsx
// ❌ Objeto novo a cada renderização: os filhos renderizam de novo
function Lista() {
  return <Filtros opcoes={{ ordenarPor: 'data', ordem: 'desc' }} />;
}
// ✅ Referência estável
const OPCOES = { ordenarPor: 'data', ordem: 'desc' } as const;
function Lista() {
  return <Filtros opcoes={OPCOES} />;
}
// React.memo e useMemo só onde a medição mostra que a renderização é cara
const Item = React.memo(function Item({ tarefa }: Props) {
  /* renderização pesada */
});
const resumo = useMemo(() => calcularResumo(tarefas), [tarefas]);
```

## Pacote JavaScript grande

Bundlers modernos (Vite, webpack 5+) já eliminam o que não é usado nos imports nomeados. O ganho real vem de dividir e carregar sob demanda:

```tsx
const Graficos = lazy(() => import('./Graficos')); // pesado e pouco usado
const Configuracoes = lazy(() => import('./pages/Configuracoes')); // por rota

function App() {
  return (
    <Suspense fallback={<Carregando />}>
      <Configuracoes />
    </Suspense>
  );
}
```

## Cache (backend)

Guarde em cache o que é caro de produzir e lido muito mais vezes do que muda.

| Camada                   | Quem vê             | Quando usar                                                 | Custo                                     |
| ------------------------ | ------------------- | ----------------------------------------------------------- | ----------------------------------------- |
| No processo (`Map`, LRU) | Um processo         | Pequeno, muito lido, tudo bem cada processo ter a sua cópia | Cada processo fica com um valor diferente |
| Compartilhado (Redis)    | Todos os processos  | Os processos precisam concordar, ou é caro recalcular       | Mais um serviço para rodar                |
| CDN                      | Todo mundo, por URL | Respostas públicas e iguais para todos                      | Desfazer uma resposta ruim é difícil      |

```ts
const VALIDADE = 5 * 60 * 1000; // 5 minutos
let configEmCache: Config | null = null;
let expiraEm = 0;
async function lerConfig(): Promise<Config> {
  if (configEmCache && Date.now() < expiraEm) return configEmCache;
  configEmCache = await db.config.findFirst();
  expiraEm = Date.now() + VALIDADE;
  return configEmCache;
}

// Arquivos estáticos com nome por conteúdo: cache longo
app.use('/static', express.static('public', { maxAge: '1y', immutable: true }));
```

- **A chave decide se o cache está certo:** tudo que muda a resposta entra nela (cliente, idioma, permissões).
- **Uma estratégia de invalidação só:** tempo de validade, invalidação por evento, ou chaves com versão.
- **Cuidado com a avalanche:** quando uma chave muito usada expira, todas as requisições recalculam juntas. Sirva o valor velho enquanto uma só recalcula, ou faça as requisições simultâneas esperarem a mesma promessa.
- **Não guarde em cache** o que não pode ficar velho (saldo, permissões, estoque no checkout).
