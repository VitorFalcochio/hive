# Padrões de blindagem

Parte da skill `security-and-hardening` (Addy Osmani, licença MIT), traduzida e adaptada para o Hive.

Exemplos de código para cada regra da skill. Abra só a seção de que precisar, quando chegar nesse código: não é para ler de cabo a rabo.

## Injeção

```ts
// ❌ SQL montado com texto: injeção
const sql = `SELECT * FROM usuarios WHERE id = '${usuarioId}'`;

// ✅ Consulta parametrizada
const usuario = await db.query('SELECT * FROM usuarios WHERE id = $1', [usuarioId]);
// ✅ ORM com entrada parametrizada
const usuario = await prisma.usuario.findUnique({ where: { id: usuarioId } });
```

## Login e sessão

```ts
import { hash, compare } from 'bcrypt';
const senhaHash = await hash(senha, 12);
const valida = await compare(senha, senhaHash);

const SEGREDO = process.env.SESSION_SECRET; // do ambiente, nunca do código
if (!SEGREDO) throw new Error('SESSION_SECRET não configurado');
app.use(
  session({
    secret: SEGREDO,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true, // o JavaScript da página não lê
      secure: true, // só em HTTPS
      sameSite: 'lax', // proteção contra CSRF
      maxAge: 24 * 60 * 60 * 1000, // 24 horas
    },
  }),
);
```

## XSS

```ts
// ❌ Entrada do usuário como HTML
elemento.innerHTML = textoDoUsuario;
// ✅ Escape automático do framework (o React faz por padrão)
return <div>{textoDoUsuario}</div>;
// ✅ Sem framework: textContent
elemento.textContent = textoDoUsuario;
// Se PRECISAR de HTML, sanitize antes
import DOMPurify from 'dompurify';
const limpo = DOMPurify.sanitize(textoDoUsuario);
```

## Controle de acesso

```ts
// Confira a permissão, não só o login
app.patch('/api/tarefas/:id', autenticar, async (req, res) => {
  const tarefa = await tarefas.buscar(req.params.id);
  if (!tarefa)
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tarefa não encontrada' } });
  if (tarefa.donoId !== req.usuario.id)
    return res
      .status(403)
      .json({ error: { code: 'FORBIDDEN', message: 'Sem permissão para alterar esta tarefa' } });
  return res.json(await tarefas.atualizar(req.params.id, req.body));
});
```

## Configuração (cabeçalhos e CORS)

```ts
import helmet from 'helmet';
app.use(helmet());
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // aperte se der
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
    },
  }),
);
// CORS só para origens conhecidas
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || 'http://localhost:3000',
    credentials: true,
  }),
);
```

## Vazamento de dados

```ts
// Nunca devolva campos sensíveis
function usuarioPublico(usuario: UsuarioDoBanco) {
  const { senhaHash, tokenRedefinicao, ...publico } = usuario;
  return publico;
}
```

## SSRF (servidor buscando URL do usuário)

```ts
// ❌ Busca qualquer coisa
await fetch(req.body.webhookUrl);

// ✅ Lista de hosts, recusa IP privado, proíbe redirecionamento
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
const PERMITIDOS = new Set(['hooks.exemplo.com']);

async function urlSegura(texto: string): Promise<URL> {
  const url = new URL(texto);
  if (url.protocol !== 'https:') throw new Error('só https');
  if (!PERMITIDOS.has(url.hostname)) throw new Error('host não permitido');
  const enderecos = await lookup(url.hostname, { all: true });
  if (enderecos.some((e) => ipaddr.parse(e.address).range() !== 'unicast'))
    throw new Error('IP privado ou reservado');
  return url;
}
await fetch(await urlSegura(req.body.webhookUrl), { redirect: 'error' });
```

`range() !== 'unicast'` cobre loopback, link-local `169.254.169.254` (os metadados da nuvem, o alvo número 1), redes privadas, em IPv4 e IPv6. Ainda sobra a brecha de "DNS rebinding": em superfícies de alto risco, conecte no IP já resolvido.

## Validação com esquema

```ts
import { z } from 'zod';
const CriarTarefa = z.object({
  titulo: z.string().trim().min(1).max(200),
  descricao: z.string().max(2000).optional(),
  prioridade: z.enum(['baixa', 'media', 'alta']).default('media'),
});
const resultado = CriarTarefa.safeParse(req.body);
if (!resultado.success)
  return res.status(422).json({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Dados inválidos',
      details: resultado.error.flatten(),
    },
  });
// daqui em diante, resultado.data é tipado e validado
```

## Upload de arquivos

```ts
const TIPOS = ['image/jpeg', 'image/png', 'image/webp'];
const MAXIMO = 5 * 1024 * 1024; // 5 MB
function validarUpload(arquivo: Arquivo) {
  if (!TIPOS.includes(arquivo.mimetype)) throw new ErroDeValidacao('Tipo de arquivo não permitido');
  if (arquivo.size > MAXIMO) throw new ErroDeValidacao('Arquivo grande demais (máximo 5 MB)');
  // não confie na extensão; confira os primeiros bytes quando importar
}
```

## Triagem da auditoria de dependências

```
A auditoria acusou uma vulnerabilidade
├── Crítica ou alta
│   ├── O código vulnerável é usado (em execução, build, teste ou deploy)?
│   │   ├── SIM → corrija já (atualize, aplique o patch ou troque a dependência)
│   │   └── NÃO (confirmado) → corrija em breve, não bloqueia
│   └── Existe correção? NÃO → contorno, troca da dependência, ou exceção com data de revisão
├── Moderada → em produção: próxima versão; só desenvolvimento: quando der
└── Baixa → nas atualizações de rotina
```

Ao adiar uma correção, registre o motivo e uma data de revisão.

## Limite de requisições

```ts
import rateLimit from 'express-rate-limit';
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use('/api/auth/', rateLimit({ windowMs: 15 * 60 * 1000, max: 10 })); // 10 tentativas / 15 min
```

O contador fica na memória do processo: com vários processos atrás de um balanceador, o limite real vira `max × processos`; em serverless, cada chamada começa do zero. Nesses casos, use um armazenamento compartilhado (Redis).

## Segredos

```
.env.example  → vai para o git (valores de exemplo)
.env          → NÃO vai (segredos reais)
.env.local    → NÃO vai

.gitignore precisa ter: .env, .env.local, .env.*.local, *.pem, *.key
```

Antes de commitar, procure segredos no que vai entrar (mostrando só os nomes dos arquivos, para o valor não aparecer no log):

```bash
git diff --cached -i -G'password|secret|api_key|token' --name-only
```

Se um segredo foi commitado, troque a chave: apagar a linha ou reescrever o histórico não basta.

## Classificação de dados pessoais

| Classe      | Exemplos                                                     | Cuidado                                                                                |
| ----------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Não pessoal | Totais, contagens anônimas                                   | Normal                                                                                 |
| Pessoal     | Nome, e-mail, IP, ID de dispositivo                          | Mínimo necessário, acesso controlado, entra na exportação e na exclusão                |
| Sensível    | Saúde, finanças, localização, biometria, documentos, menores | Base legal extra, acesso mais restrito, muitas vezes criptografia e registro de acesso |

## Saída de modelos de IA

```ts
// ❌ Confiar na saída como comando ou HTML
const sql = await ia.gerar(`Escreva o SQL para: ${pergunta}`);
await db.query(sql); // qualquer consulta
container.innerHTML = await ia.responder(mensagem); // XSS pelo modelo

// ✅ A saída é dado: interprete, valide, codifique
let intencao;
try {
  intencao = ComandoSchema.parse(JSON.parse(await ia.responderJson(mensagem)));
} catch {
  throw new ErroDeValidacao('resposta inesperada do modelo');
}
await executarAcaoPermitida(intencao.acao, intencao.parametros);
container.textContent = await ia.responder(mensagem);
```
