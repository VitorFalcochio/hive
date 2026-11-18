---
name: security-and-hardening
description: 'Use ao lidar com entrada do usuário, login, sessões, dados guardados, integrações externas, upload de arquivos, dependências ou dados pessoais (LGPD): protege o código contra as vulnerabilidades do OWASP Top 10, começando pelo modelo de ameaças.'
license: MIT
metadata:
  origin: Addy Osmani
  author: Addy Osmani
  source: https://github.com/addyosmani/agent-skills/tree/main/skills/security-and-hardening
  adapted: 'Traduzida para o português e adaptada às ferramentas do Hive'
---

# Segurança e blindagem

Trate toda entrada de fora como hostil, todo segredo como sagrado e toda checagem de permissão como obrigatória. Segurança não é uma fase: é uma restrição em cada linha que toca dados de usuário, login ou sistemas externos.

## Quando usar

- Qualquer coisa que recebe entrada do usuário.
- Login (autenticação) ou permissões (autorização).
- Guardar ou transmitir dados sensíveis.
- Integração com APIs ou serviços externos.
- Upload de arquivos, webhooks, callbacks.
- Pagamento ou dados pessoais.

## Primeiro, o modelo de ameaças

Proteção sem modelo de ameaças é chute. Antes de blindar, passe cinco minutos pensando como atacante:

1. **Mapeie as fronteiras de confiança.** Por onde dado não confiável entra? Requisições HTTP, campos de formulário, uploads, webhooks, APIs de terceiros, filas, **a saída de modelos de IA**, e valores que parecem internos mas foram escritos por outro (nome de arquivo numa pasta compartilhada, um caminho vindo num payload). A confiança segue **quem escreveu** o valor, não o canal por onde ele chegou.
2. **Nomeie o que vale proteger:** senhas, dados pessoais, pagamento, ações de administrador, dinheiro.
3. **Passe o STRIDE em cada fronteira** (uma lente rápida, não uma cerimônia):

| Ameaça                     | Pergunta                                                | Proteção típica                                           |
| -------------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| Falsificação de identidade | Alguém consegue se passar por outro usuário ou serviço? | Autenticação, assinatura                                  |
| Adulteração                | O dado pode ser alterado no caminho ou guardado?        | Consultas parametrizadas, HTTPS, checagem de integridade  |
| Repúdio                    | Alguém pode negar uma ação depois?                      | Registro de eventos de segurança                          |
| Vazamento de informação    | O dado pode vazar?                                      | Criptografia, lista de campos permitidos, erros genéricos |
| Negação de serviço         | Dá para derrubar?                                       | Limite de requisições, de tamanho e de tempo              |
| Elevação de privilégio     | Um usuário pode ganhar poderes que não devia?           | Checagem de permissão, menor privilégio                   |

4. **Escreva os casos de abuso ao lado dos casos de uso:** "como eu usaria isso de forma errada?". Esse vira o seu primeiro teste.

Se você não consegue nomear as fronteiras de confiança de uma funcionalidade, ainda não está pronto para protegê-la.

## As três faixas

### Sempre (sem exceção)

- **Valide toda entrada externa** na fronteira (rotas, formulários), com esquema.
- **Parametrize toda consulta ao banco.** Nunca concatene entrada do usuário em SQL.
- **Codifique a saída** contra XSS: use o escape automático do framework, não contorne.
- **HTTPS** em toda comunicação externa.
- **Senhas com hash** bcrypt, scrypt ou argon2. Nunca em texto puro.
- **Cabeçalhos de segurança** (CSP, HSTS, X-Frame-Options, X-Content-Type-Options).
- **Cookies de sessão** com `httpOnly`, `secure` e `sameSite`.

### Pergunte antes (precisa do usuário)

No Hive, não decida sozinho: registre a proposta no Nectar com `nectar_propose` ou explique no `finish` para o usuário decidir.

- Fluxo de login novo ou mudança na lógica de autenticação.
- Guardar uma categoria nova de dado sensível (pessoais, pagamento).
- Integração nova com serviço externo.
- Mudança na configuração de CORS.
- Upload de arquivos.
- Mudança no limite de requisições.
- Dar permissões ou papéis mais altos.

### Nunca

- **Nunca** coloque segredos no código ou no git (chaves de API, senhas, tokens).
- **Nunca** registre em log dados sensíveis (senhas, tokens, número completo de cartão).
- **Nunca** confie na validação do navegador como barreira de segurança.
- **Nunca** desligue cabeçalhos de segurança por conveniência.
- **Nunca** use `eval()` ou `innerHTML` com dados do usuário.
- **Nunca** guarde token de sessão em `localStorage`.
- **Nunca** mostre pilha de erro ou detalhes internos para o usuário.

## Proteções

Os exemplos de código de cada uma estão em `references/hardening-patterns.md` (abra com `read_skill_resource` só a seção que precisar, quando chegar nesse código).

- **Injeção, XSS e acesso:** parametrize toda consulta; nunca monte SQL, consulta NoSQL ou comando de terminal com texto de entrada. Saída pelo escape do framework; se HTML cru for inevitável, sanitize antes com lista de permitidos. Confira a **autorização** em toda requisição, não só a autenticação: o usuário logado precisa ser dono do recurso específico, ou ter permissão nele.
- **Login e sessão:** hash com bcrypt (12 rodadas ou mais), scrypt ou argon2. O segredo da sessão vem do ambiente, nunca do código. Cookie de sessão `httpOnly`, `secure`, `sameSite: 'lax'` ou `'strict'`, com validade limitada.
- **Cabeçalhos, CORS e respostas:** cabeçalhos de segurança em toda resposta; CSP começando por `default-src 'self'`. CORS só para uma lista explícita de origens; nunca `*` com credenciais. Tire campos sensíveis (`senhaHash`, tokens de redefinição) de qualquer resposta. Corpo de erro genérico; os detalhes vão só para o log do servidor.
- **Validação e upload:** valide com esquema (formato, tamanho, valores permitidos) e responda 422 com os detalhes. Em upload, lista de tipos permitidos, limite de tamanho e, quando importar, confira o conteúdo do arquivo: a extensão não prova nada.
- **Requisições do servidor para URLs do usuário (SSRF):** webhooks, "importar de URL", proxy de imagem, prévia de links podem ser apontados para serviços internos. Lista de esquemas e hosts permitidos, recuse qualquer endereço privado ou reservado (incluindo `169.254.169.254`) e proíba redirecionamentos.
- **Apagar ou mover arquivos por caminho calculado:** antes de apagar, confira que o alvo (com links simbólicos resolvidos) está dentro de uma pasta permitida, pelo menos um nível abaixo dela, e que é seu. Se recusar, registre e pare; nunca caia para um caminho mais amplo.
- **Limite de requisições:** na API em geral, e mais rígido no login (umas 10 tentativas a cada 15 minutos). Com mais de um processo servindo, o contador precisa ficar num armazenamento compartilhado.
- **Segredos:** vêm do ambiente. Um `.env.example` com valores de exemplo vai para o git; os `.env` reais e as chaves ficam no `.gitignore`. Um segredo que chegou a um repositório remoto está comprometido: troque a chave primeiro, depois limpe o histórico.
- **Dependências:** rode a auditoria do gerenciador de pacotes do projeto (`npm audit`, `pnpm audit`) e trate as críticas e altas conforme o código vulnerável é de fato usado. Nunca aplique correção forçada (`npm audit fix --force`) automaticamente. A auditoria só conhece vulnerabilidades já publicadas: revise toda dependência nova (quem mantém, idade, nome parecido com um pacote famoso).

## Dados pessoais (LGPD)

Blindar pergunta "um atacante consegue ler?". Privacidade pergunta "a gente devia mesmo guardar isso, e por quanto tempo?". O dado mais barato de proteger é o que você nunca coletou.

- **Classifique os campos ao criar:** não pessoal, pessoal (nome, e-mail, IP) ou sensível (saúde, finanças, localização, documentos, dados de menores).
- **Colete só com um propósito declarado.** "Pode ser útil depois" não é propósito.
- **Defina por quanto tempo guarda, e apague de verdade**, inclusive em backups, caches e cópias de análise.
- **Atenda aos direitos do titular:** exportar, corrigir e apagar os dados.
- **Mandar dados pessoais para serviço de análise, anúncio ou IA é compartilhar:** precisa de consentimento e contrato.

## Funcionalidades com IA

- **A saída do modelo é entrada não confiável.** Nunca em `eval`, SQL, terminal, `innerHTML` ou caminho de arquivo: interprete com cuidado, valide com esquema e codifique.
- **O prompt pode ser sequestrado.** Texto de fora no contexto (mensagem do usuário, página buscada, PDF) pode trazer instruções. O prompt de sistema não é barreira de segurança: imponha as permissões no código.
- **Não ponha segredos, dados de outros clientes nem o prompt de sistema inteiro no contexto.** Limite tokens, taxa e profundidade de chamadas.

## Desculpas comuns

| Desculpa                                       | Realidade                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| "É ferramenta interna, segurança não importa." | Ferramentas internas são invadidas. O atacante mira o elo mais fraco. |
| "Coloco segurança depois."                     | Encaixar segurança depois é dez vezes mais difícil.                   |
| "Ninguém vai tentar explorar isso."            | Robôs de varredura vão.                                               |
| "O framework cuida disso."                     | O framework dá as ferramentas, não a garantia.                        |
| "É só texto do modelo de IA."                  | Esse "texto" pode ser um SQL, uma tag de script ou um comando.        |

## Sinais de alerta

- Entrada do usuário indo direto para consulta, terminal ou HTML.
- Segredo no código ou no histórico do git.
- Rota sem checagem de login ou de permissão.
- CORS com `*`.
- Login sem limite de tentativas.
- Pilha de erro aparecendo para o usuário.
- Servidor buscando URL do usuário sem lista de permitidos.
- Saída de IA indo para consulta, página, terminal ou `eval`.
- Dado pessoal sem propósito, prazo ou forma de apagar.

## Antes de concluir

- [ ] A auditoria de dependências não tem crítica ou alta sem tratamento.
- [ ] Nenhum segredo no código nem no git.
- [ ] Toda entrada é validada na fronteira.
- [ ] Login e permissão são conferidos em toda rota protegida.
- [ ] Respostas de erro não mostram detalhes internos.
- [ ] O login tem limite de tentativas.
- [ ] Requisições do servidor para URLs externas passam por lista de permitidos.
- [ ] Dados pessoais estão classificados, têm propósito e prazo.
