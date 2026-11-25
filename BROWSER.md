# Hive Browser

Um navegador dentro do Hive, que você e os agentes usam para abrir e testar aplicações web. Ele usa o **Chromium que já vem no Electron**: não baixa nenhum navegador e não tem custo.

Para abrir: no **Workspace** (canvas da missão), adicione o bloco **Navegador** pelo menu de blocos (seção Testar o app) ou pela paleta de comandos. Quando a missão tem um QA que testa no Hive Browser, o bloco já entra sozinho, à esquerda do Diálogo. Ele saiu do menu lateral: o lugar dele é ao lado dos agentes que o usam.

## Decisões de arquitetura

1. **Sem Playwright, por segurança.** Para o Playwright controlar o Chromium do Hive, o app precisaria abrir uma porta de depuração na máquina. Qualquer programa local poderia usá-la para controlar **o próprio Hive**, inclusive a janela principal, que tem acesso a tudo. O Electron já oferece, de dentro do processo, o que é preciso: eventos reais de mouse e teclado (`sendInputEvent`, `insertText`), print (`capturePage`), console, rede e tamanho da tela. O Playwright continua sendo uma opção para scripts de teste dos próprios projetos, rodados por `run_command`.
2. **Cada aba é uma janela invisível renderizada fora da tela**, a 10 quadros por segundo, para gastar pouca CPU. O bloco **Navegador** mostra a aba como uma imagem atualizada a cada 1,2 s. Um clique na imagem vira um clique na página, e a roda do mouse rola.
3. **O mesmo padrão do `view_page`.** O pacote de agentes define o contrato (`BrowserDriver`) e as ferramentas, e o app desktop injeta a implementação. Isso permite testar as ferramentas com um navegador falso.
4. **Ferramentas só para quem testa interface.** As 13 ferramentas vão para agentes de **QA, frontend, integração** e personalizados que tenham a permissão `view_page`. Dar a todos custaria cerca de 1.500 tokens a mais por passo, o que estoura os limites por minuto das camadas grátis.

## Ferramentas dos agentes

`browser_open`, `browser_navigate` (ir, voltar, avançar, recarregar), `browser_click` (seletor CSS, texto visível ou coordenadas), `browser_type`, `browser_scroll`, `browser_screenshot`, `browser_inspect` (títulos, texto e elementos interativos com seletores prontos), `browser_console`, `browser_network`, `browser_evaluate`, `browser_wait`, `browser_resize` (desktop, tablet, celular) e `browser_close`.

As abas de um agente fecham quando a tarefa dele termina.

## Testes de QA e evidências

A Queen foi instruída a, num app com tela, dar à tarefa de QA ou de integração os passos:

1. subir o servidor (`run_command` em segundo plano);
2. abrir o app (`browser_open`);
3. percorrer os critérios de aceitação;
4. olhar o console;
5. tirar um print de cada funcionalidade.

Cada print que um agente tira é salvo como PNG em `<dados>/evidence/<missão>/` e listado com a missão. A **porta final de entrega** cita esses prints no veredito ("os agentes testaram o app no Hive Browser, 4 prints").

## Segurança

- **Sessão isolada e temporária** (`hive-browser`, sem `persist:`): nada vai para o disco, e não há cookies nem logins do seu navegador.
- Janelas com sandbox, isolamento de contexto, sem Node e sem preload.
- **Só http e https.** `file://`, `javascript:` e outros esquemas são recusados.
- **Sites fora do computador pedem a sua aprovação** quando um agente tenta abrir. No Modo Turno, sem ninguém olhando, a resposta é não. Uma página também não consegue levar a aba de um agente para um site que não foi aprovado.
- Pop-ups e downloads são bloqueados. Câmera, microfone, localização e notificações são sempre negados.
- O conteúdo da página chega ao modelo marcado como **informação, nunca instruções**.
- **Limites:** 4 abas por agente, 12 no total, 30 s para carregar uma página, 15 s por ação e 30 s de espera.
- **Interromper:** numa aba de agente, o botão **Interromper** faz as próximas ações dele falharem com o aviso "o usuário interrompeu". As abas ficam abertas para você olhar e usar.

## Testes feitos

- **De ponta a ponta, no Chromium de verdade (10 de 10):** uma instância isolada do Hive abriu um app local e passou em: print, console, localização negada, clique real, digitação com Enter, modo celular (390 px e user agent de celular), recusa do `file://`, voltar no histórico e fechar a aba.
- **Unitários:** endereço local abre direto, externo pede aprovação, recusado sem aprovação, print anexado como imagem, conteúdo marcado como não confiável, ferramentas só para QA, e as abas fecham no fim da tarefa.

## Limitações reais

- **Toque não é simulado.** O modo celular troca o tamanho e o user agent, o que basta para o CSS responsivo. O `enableDeviceEmulation` do Electron, que também simularia toque, **derruba o app** numa janela fora da tela (Electron 44, descoberto pelo teste de ponta a ponta), então não é usado.
- **A tela é uma imagem** atualizada a cada 1,2 s, não um navegador embutido a 60 quadros. Serve para ver e testar, não para navegar o dia todo.
- Digitação pela página: o texto vai para o campo em foco (clique nele primeiro). Atalhos de teclado não são enviados.
- `browser_evaluate` roda JavaScript na página, dentro da sessão isolada. A instrução diz ao agente para não usá-lo para forjar um teste, mas isso não é impedido tecnicamente.
- **Nenhuma missão real com um modelo** testou um app pelo Hive Browser ainda. Isso gasta tokens e fica para você rodar.

## Arquivos

- `packages/agents/src/browser.ts`: contrato, ferramentas e regras de endereço.
- `apps/desktop/src/main/browser/manager.ts`: as abas no Chromium do Electron.
- `apps/desktop/src/renderer/src/browser.tsx`: o Hive Browser (BrowserView), usado pelo bloco Navegador do canvas; o console e a digitação ficam atrás de um botão.
- `packages/core/src/ipc.ts`: `BrowserTabState`, `BrowserEvidence` e os canais `browser.*`.
- `apps/desktop/src/main/service.ts`: canais, evidências e `withScheme`.
- `apps/desktop/src/main/delivery.ts`: prints no veredito.
- `packages/orchestrator/src/queen.ts`: instrução de QA com o navegador.
