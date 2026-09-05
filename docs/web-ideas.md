# Saddle — direção visual e plano inicial

## Três direções possíveis

### 1. Signal & Ledger

Uma linguagem editorial de sistemas: papel quente, tinta quase preta, acentos de sinalização e diagramas como protagonistas. A sensação é de um manual técnico raro, transformado em produto digital.

**Probabilidade:** 0,07

### 2. Quiet Compute

Uma interface silenciosa e quase arquitetônica, com superfícies claras, tipografia precisa e muito espaço negativo. A tecnologia aparece como infraestrutura confiável, não como espetáculo.

**Probabilidade:** 0,03

### 3. Night Shift Console

Um ambiente operacional escuro, denso e imersivo, com trilhas de execução, estados de workers e sinais luminosos. A direção é apropriada para uma experiência de console, mas deve evitar o neon genérico.

**Probabilidade:** 0,09

## Direção escolhida: Signal & Ledger

### Design Movement

Brutalismo editorial contemporâneo combinado com design suíço de informação e referências de manuais de engenharia. A interface deve parecer um artefato operacional: rigorosa, legível, modular e com marcas de uso intencionais.

### Core Principles

1. **Infraestrutura visível:** transformar conceitos abstratos — storage, runners, memória, workflows — em estruturas, trilhas, mapas e relações legíveis.
2. **Contraste de registro:** combinar títulos expressivos com microcopy monoespaçada, como se cada tela fosse simultaneamente manifesto e console.
3. **Assimetria funcional:** usar colunas deslocadas, numeração lateral, blocos de evidência e cortes editoriais em vez de centralizar tudo em cartões iguais.
4. **Sinalização com propósito:** o laranja não é decoração; indica ação, fluxo ativo, calor computacional ou ponto de entrada.

### Color Philosophy

O fundo principal será um papel mineral levemente quente, próximo de um documento técnico impresso. O texto será um preto-azulado profundo para preservar leitura e autoridade. O laranja **Saddle Ember** funcionará como sinal de operação — raro, específico e imediatamente reconhecível. Verdes e azuis aparecerão apenas como estados semânticos, nunca como gradientes decorativos.

### Layout Paradigm

As páginas usarão uma malha editorial com trilho lateral numerado, conteúdo principal deslocado e módulos de evidência que invadem a coluna adjacente. A home começa com um split assimétrico: manifesto à esquerda, um mapa visual de runtime à direita. As páginas internas mantêm o mesmo cabeçalho e uma faixa de contexto com o número da seção, permitindo que o usuário saiba onde está sem depender de um menu pesado.

### Signature Elements

- **Rail de execução:** uma linha vertical fina com marcadores numerados que acompanha as seções e simula a sequência de boot do sistema.
- **Cards de evidência:** painéis com borda, rótulo monoespaçado, pequenos dados e uma ação explícita, como se fossem registros de execução.
- **Diagrama de sela:** o símbolo visual nasce de dois suportes curvos que conectam armazenamento e processamento, repetido como watermark, favicon e detalhe de transição.

### Interaction Philosophy

As interações devem parecer comandos que respondem imediatamente. Hover revela contexto e desloca o elemento poucos pixels; cliques confirmam com compressão breve; abas e filtros mudam o foco sem apagar o contexto. Links para áreas ainda não implementadas devem usar feedback discreto e honesto, nunca fingir uma ação concluída.

### Animation

Entradas de página usam fade e deslocamento vertical de 12–18px, com stagger de 40–60ms entre blocos. Diagramas desenham suas linhas apenas uma vez, em 260–420ms, e os indicadores ativos pulsam com baixa amplitude. Estados de hover ficam entre 140–190ms e usam easing de saída forte. Toda animação não essencial é desativada em `prefers-reduced-motion`.

### Typography System

- **Display:** `Space Grotesk`, pesos 500–700, para títulos curtos e assertivos.
- **Body:** `DM Sans`, pesos 400–500, para explicações e navegação.
- **Technical:** `IBM Plex Mono`, pesos 400–600, para rótulos, métricas, paths e estados.

Os títulos devem ser compactos, com largura de linha controlada e quebras deliberadas. Labels técnicos usam caixa alta, tracking de 0.12em e tamanho reduzido. O corpo nunca deve parecer código.

### Brand Essence

**Saddle é uma camada de execução distribuída para transformar armazenamento de terceiros em memória e trabalho computacional publicável, sem exigir uma máquina local do operador.**

Personalidade: **inventiva, operacional, indisciplinada**.

### Brand Voice

Headlines são curtas, concretas e levemente provocativas. CTAs descrevem o próximo movimento em vez de prometer resultados vagos. Microcopy trata o usuário como alguém capaz de entender sistemas complexos.

> “A máquina não está na sua mesa. Está na cadeia.”

> “Mapeie os bytes. Dispare o trabalho.”

### Wordmark & Logo

O logotipo será composto por um símbolo sem texto: dois arcos horizontais incompletos, conectados por um eixo vertical deslocado, formando uma sela abstrata e sugerindo uma ponte entre bucket e runner. O wordmark “SADDLE” será tipográfico em caixa alta, com espaçamento controlado e um corte sutil no segundo D para lembrar uma porta de entrada de dados.

### Signature Brand Color

**Saddle Ember — `#E86F2D`**, um laranja queimado de alta visibilidade, usado para ações, nós ativos e pontos de passagem do sistema.

## Plano de páginas

| Prioridade | Rota | Papel | Conteúdo previsto |
|---|---|---|---|
| 1 | `/` | Landing / manifesto | Hero assimétrico, tese Storage = Compute, mapa de arquitetura, superfícies do produto, sequência de funcionamento e CTA para explorar a documentação. |
| 2 | `/architecture` | Arquitetura | Camadas do sistema, cadeia de providers, storage backends, fluxo repo → CI → Pages e notas de limites físicos. |
| 3 | `/agent-browser` | Agent Browser | Captura e replay, eventos de sessão, replay determinístico, stealth e evidências. |
| 4 | `/compute` | Compute & memory | Virtual memory, runners, farm, provider chain e estados de execução. |
| 5 | `/integrations` | Integrações | Superfícies de pacote, plataformas suportadas e caminhos de adoção. |
| 6 | `/docs` | Documentação | Índice navegável de conceitos, quick start editorial e links para os próximos guias. |

## Ordem de implementação

1. Criar o shell global, a navegação e o sistema tipográfico.
2. Implementar a home com o manifesto e o mapa de runtime.
3. Criar o conjunto de componentes reutilizáveis para rails, métricas, cards e diagramas.
4. Implementar as páginas de arquitetura e agent browser, que validam a linguagem do produto.
5. Adicionar compute, integrações e docs com o mesmo shell.
6. Verificar rotas, responsividade, foco de teclado, contrastes e estados de interação.
