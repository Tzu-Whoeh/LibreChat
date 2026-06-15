# Font Licensing Notice — PPT 助手 (pptx-mcp)

The PPT assistant renders decks using fonts installed into the API image. All
fonts used are free for commercial use under permissive open-font licenses.

## Installed via Alpine packages (apk)

| Family | Package | License |
| --- | --- | --- |
| Inter | font-inter | SIL OFL 1.1 |
| Roboto | font-roboto | Apache 2.0 |
| Noto Serif | font-noto | SIL OFL 1.1 |
| JetBrains Mono | font-jetbrains-mono | SIL OFL 1.1 |
| Noto Sans CJK SC / Noto Serif CJK SC (思源黑体/宋体) | font-noto-cjk | SIL OFL 1.1 |
| Caveat | font-caveat | SIL OFL 1.1 |
| Pacifico | font-pacifico | SIL OFL 1.1 |

## Bundled from google/fonts (downloaded in Dockerfile)

| Family | Source | License |
| --- | --- | --- |
| Zhi Mang Xing (钟齐志莽行书) | github.com/google/fonts → ofl/zhimangxing | SIL OFL 1.1 |

Zhi Mang Xing: Copyright 2018 The Zhi Mang Xing Project Authors
(https://github.com/googlefonts/zhimangxing). Licensed under the SIL Open Font
License, Version 1.1. The full OFL text is downloaded alongside the .ttf into
`/usr/share/fonts/zhimangxing/OFL.txt` in the image (see Dockerfile).

## Compliance notes

- These fonts are embedded/rendered into generated .pptx files and bundled in the
  application image — permitted under OFL/Apache.
- The fonts are NOT sold separately and are NOT modified.
- Under OFL 1.1, the license and copyright notice travel with the font; that is
  why OFL.txt is fetched next to the .ttf in the image, and this notice is kept
  in the repo.
