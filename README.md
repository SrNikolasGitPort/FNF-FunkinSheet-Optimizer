# FNF FunkinSheet Optimizer

Site que otimiza sprites de **Friday Night Funkin'** (atlas Sparrow **PNG + XML**) de forma rápida e sem erros, e ajusta o config do personagem para ele continuar **do mesmo tamanho e alinhado** no jogo.

Tudo roda **100% no navegador** (nenhum arquivo é enviado para servidor) e funciona offline depois de carregado.

## O que faz

- **Corte inteligente**: remove as bordas transparentes de cada frame e ajusta `frameX/frameY` (o frame virtual original é preservado).
- **Escala de 0.1 a 1.0** (passo 0.01): cada frame é reduzido com amostragem em subpixel (filtros Área, Bilinear ou Lanczos3, em alpha pré-multiplicado). A escala efetiva é compensada pelo arredondamento do frame virtual.
- **Deduplicação**: frames idênticos passam a apontar para a mesma região do atlas (opcional: "quase idênticos", com tolerância).
- **Empacotador MaxRects** com busca do menor atlas, espaçamento e extrusão de bordas configuráveis, opção de potência de 2 e tamanho máximo.
- **PNG menor**: filtros adaptativos + deflate; paleta exata (PNG-8 sem perdas) quando o atlas tem até 256 cores; PNG-8 quantizado opcional (median-cut, com dithering).
- **Validação automática**: o resultado é decodificado de novo e comparado com o original. Com escala 1.0 e opções sem perdas, precisa ser **idêntico pixel a pixel**; com escala menor mostra o PSNR. Se a validação falhar, o site pede confirmação antes de baixar o ZIP.
- **Ajuste do config do personagem** (opcional), preservando a formatação original do arquivo (só os trechos necessários mudam):
  - **Psych Engine** (qualquer versão): `personagem.json`, campo `scale` = `scale / S`.
  - **Leather Engine 0.5.0 – 1.1.9**: `config.json` + `offsets.txt`, incluindo `imagePath` e `extraSheets` (todos os atlas do personagem usam a **mesma** escala efetiva).
- **Prévias**: visualizador de atlas (zoom, caixas, nomes ao passar o mouse) e player de animações com **original × otimizado** lado a lado ou sobrepostos, aplicando fps e offsets do config.
- **ZIP** com PNG, XML, configs e `relatorio.txt`, mantendo a estrutura de pastas.

## Como usar

1. Arraste o PNG + XML (e, se quiser, o JSON do Psych ou `config.json` + `offsets.txt` do Leather), ou a pasta inteira do personagem. Dá para testar sem arquivos com **Carregar exemplo (BF)**.
2. Escolha a escala e o perfil (Máxima qualidade / Equilibrado / Máxima leveza).
3. Clique em **Otimizar**, confira o Resumo, as prévias e o diff dos configs.
4. **Baixar tudo (.zip)**.

## Como o config é ajustado

Se o sprite foi reduzido por um fator `S`, o personagem precisa ser desenhado `1/S` maior para ficar igual no jogo:

| Engine | O que muda | O que NÃO muda |
| --- | --- | --- |
| Psych | `scale` (e `image` se você usar sufixo) | `offsets`, `position`, `camera_position`, `fps`, `indices` |
| Leather | `scale`, se existir; `imagePath`/`extraSheets` com sufixo | `offsets.txt` (byte a byte), flips, cores, animações |

Pontos importantes:

- Os offsets das animações ficam em pixels de tela e **não** são divididos por `S`. Há uma opção avançada para multiplicá-los no `offsets.txt` caso a sua engine se comporte diferente.
- O `config.json` do Leather dos exemplos **não tem campo de escala**. O site **não inventa** esse campo: avisa que o personagem ficará menor e oferece a opção avançada "adicionar `scale`" (confirme se a sua versão da engine lê esse campo).
- `animation_name` é o prefixo dos frames no XML: os nomes dos frames nunca são alterados.

## Limitações conhecidas

- Frames **rotacionados** (`rotated="true"`) não são suportados: o site recusa o atlas com uma mensagem clara, em vez de arriscar corromper.
- O atlas final precisa caber no tamanho máximo escolhido (até 16384 px); não há divisão em várias páginas.
- O PNG usa o deflate nativo do navegador (`CompressionStream`), que não tem o nível máximo de compressão de ferramentas como zopfli.
- Ao cortar frames, o XML costuma **crescer** (acrescenta `frameX/frameY`); o ganho no PNG compensa.

## Rodar / hospedar

É um site estático. Abra o `index.html` direto no navegador, ou publique no **GitHub Pages** (Settings → Pages → Deploy from a branch → `main` / root).

Em servidor, o processamento roda em um Web Worker. Se o navegador bloquear workers (por exemplo, ao abrir via `file://`), ele cai automaticamente para a thread principal.

## Testes

Precisam do Node 18+ (e, só para regenerar os arquivos de teste, Python com Pillow e numpy):

```bash
node tests/png.test.js        # decoder/encoder PNG (paleta, cinza, 16 bits, Adam7, quantização)
node tests/pipeline.test.js   # pipeline, escalas, dedup, configs Psych/Leather, ZIP
```

## Estrutura

```
index.html, css/style.css
js/png.js        decoder/encoder PNG, quantização
js/sparrow.js    parser/escritor do XML Sparrow
js/resample.js   redimensionamento em subpixel
js/pack.js       MaxRects
js/config.js     edição de JSON por trechos, Psych/Leather, pareamento de arquivos, ZIP
js/pipeline.js   pipeline de um atlas e lote com configs
js/worker.js     execução fora da thread da interface
js/demo.js       personagem de exemplo
js/app.js        interface
examples/BF/     config.json + offsets.txt de exemplo (Leather)
tests/           testes automáticos
```
