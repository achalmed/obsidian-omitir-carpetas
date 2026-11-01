# Omitir carpetas

Complemento de Obsidian (solo escritorio) para que Obsidian **no lea ni vigile** lo que no son notas: `node_modules`,
los repos anidados (submódulos) y, si se pide, lo que ya está en «Archivos excluidos».

Obsidian recorre y vigila todo el vault, y solo se salta lo que empieza con punto. En un vault que también guarda
repos de código, eso son cientos de miles de archivos y un vigilante por carpeta. «Archivos excluidos» no ayuda:
solo oculta de la búsqueda, del grafo y del selector rápido, pero Obsidian lo sigue leyendo al arrancar y vigilando
mientras está abierto.

## Qué omite

| regla | qué omite | por defecto |
|---|---|---|
| nombres | toda carpeta con uno de esos nombres, en cualquier parte (la lista se edita; viene `node_modules`) | activa |
| repos anidados | toda carpeta con `.git` (archivo o carpeta) dentro de otro repo: submódulos y clones internos. Si el vault mismo es un repo, todo repo de dentro es anidado | activa |
| excluidos | lo que filtra «Archivos excluidos» (Ajustes → Archivos y enlaces) | apagada |

La tercera regla es la más rápida, pero cambia lo que hay en el vault: un enlace de una nota a un archivo omitido
queda sin resolver, y al pulsarlo Obsidian crea una nota vacía. Las regex con excepción, como
`/^docs\/(?!notas\/)/`, se respetan: `docs/` se recorre para que `docs/notas/` siga viéndose.

## Lo que se midió

En un vault real de unos 300 000 archivos, con Obsidian 1.14.5, arranque en frío con la caché al día:

| | sin el complemento | nombres y repos anidados | más excluidos |
|---|---|---|---|
| archivos en el vault | 296 585 | 130 172 | 3 646 |
| carpetas vigiladas | 31 185 | 19 574 | 705 |
| interfaz lista | 28,5 s | 21,8 s | 12,2 s |
| en reposo | 125 s | 70 s | 48 s |
| memoria | 4,3 GB | 2,5 GB | 1,3 GB |

## Cómo funciona

Obsidian activa los complementos antes de recorrer el vault: en `app.js` 1.14.5, `plugins.initialize()` va antes de
`vault.load()`, que espera el `onload` de cada complemento. En `onload` el complemento envuelve dos métodos del
adaptador de escritorio (`reconcileFolderCreation` y `reconcileFileCreation`), y una carpeta omitida nunca entra al
vault: no se lista, no se vigila, no se indexa. Si una versión de Obsidian no tiene esos métodos, el complemento lo
avisa y no omite nada. Al desactivarlo, Obsidian vuelve a leerlo todo tras recargar.

La primera vez que arranca con una regla nueva, la caché de metadatos todavía recuerda lo omitido, y
`MetadataCache.initialize` lo borra entrada por entrada. Cada `deletePath` recorre los enlaces de todo el vault
(`updateRelatedLinks`): con 166 413 entradas, Obsidian quedó al 100 % de CPU más de 20 minutos. Por eso, mientras
corre `initialize`, el complemento cambia `deletePath` por una versión que solo anota, y al final una sola pasada
encola los mismos archivos para resolver sus enlaces: esas 166 413 entradas se borraron en 0,3 s.

## Instalar

Desde una versión publicada: copia `main.js` y `manifest.json` de la
[última versión](https://github.com/achalmed/obsidian-omitir-carpetas/releases/latest) a
`<vault>/.obsidian/plugins/omitir-carpetas/`, o instálalo con [BRAT](https://github.com/TfTHacker/obsidian42-brat)
dando `achalmed/obsidian-omitir-carpetas`.

Desde este repo:

```bash
./instalar.sh <ruta-del-vault>            # simula
./instalar.sh <ruta-del-vault> --aplicar  # copia a <vault>/.obsidian/plugins/omitir-carpetas/
```

Después: Ajustes → Complementos de la comunidad → activar «Omitir carpetas» → recargar Obsidian. Las reglas se
cambian en la pestaña del complemento y se aplican al recargar. En la consola (`Ctrl+Shift+I`) aparece
`[omitir-carpetas] N carpetas omitidas`.

## Probar

```bash
npm test                                   # vault de juguete con un adaptador falso como el de Obsidian 1.14.5
OBSIDIAN_VAULT=<ruta-del-vault> npm test   # además, comprueba la regla de excluidos con los filtros de ese vault
```

## Licencia

MIT.
