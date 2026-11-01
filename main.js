/**
 * main.js — Omitir carpetas, complemento de Obsidian (https://github.com/achalmed/obsidian-omitir-carpetas).
 *
 * Obsidian recorre y vigila todo el vault, y solo se salta lo que empieza con punto: en un vault con repos de código,
 * cientos de miles de archivos, la mayoría en node_modules. «Archivos excluidos» solo los oculta de la búsqueda y del
 * grafo; no evita que se lean al arrancar ni que tengan un vigilante por carpeta.
 *
 * Obsidian activa los complementos antes de recorrer el vault (app.js 1.14.5: plugins.initialize() y después
 * vault.load(), que espera el onload de cada uno). Por eso onload alcanza a envolver dos métodos del adaptador
 * de escritorio, y una carpeta omitida nunca se lista ni se vigila:
 *
 *   reconcileFolderCreation(real, ruta)  toda carpeta nueva pasa por aquí antes de vigilarse y listarse
 *   reconcileFileCreation(real, ruta, st) todo archivo nuevo pasa por aquí antes de entrar al vault
 *
 * Reglas, en este orden:
 *   1. nombres          una carpeta con uno de esos nombres (node_modules)
 *   2. repos anidados   una carpeta con .git dentro de otro repo: los submódulos (con archivo .git o con carpeta
 *                       .git) y cualquier clon dentro de un repo; un repo de primer nivel del vault se ve
 *   3. excluidos        lo que ya filtra «Archivos excluidos» (userIgnoreFilters de .obsidian/app.json): apagado por
 *                       defecto, porque un enlace de una nota a un archivo omitido queda sin resolver
 *
 * La primera vez que arranca con una regla nueva, la caché de metadatos todavía recuerda los .md y .qmd omitidos, y
 * MetadataCache.initialize los borra uno por uno: cada deletePath recorre los enlaces de todo el vault
 * (updateRelatedLinks), y con decenas de miles de borrados el arranque se cuelga. Por eso, mientras corre initialize,
 * deletePath solo anota, y al final una sola pasada encola los mismos archivos para resolver sus enlaces.
 *
 * Los cambios se aplican al recargar Obsidian. Si una versión nueva de Obsidian cambia esos métodos, el complemento
 * avisa y no toca nada.
 */
"use strict";

const { Plugin, PluginSettingTab, Setting, Notice, FileSystemAdapter } = require("obsidian");

const PREDETERMINADO = {
    nombres: ["node_modules"],
    reposAnidados: true,
    excluidos: false,
};

const METODOS = ["reconcileFolderCreation", "reconcileFileCreation"];
const METODOS_CACHE = ["initialize", "deletePath", "saveFileCache", "queueFileForLinkResolution", "didFinish"];

const nombreBase = (ruta) => ruta.slice(ruta.lastIndexOf("/") + 1);

/**
 * Los filtros de «Archivos excluidos» compilados como Obsidian (MetadataCache.updateUserIgnoreFilters), con lo que
 * cada uno deja ver. Obsidian solo oculta y prueba cada ruta; aquí omitir una carpeta omite todo lo de dentro, así
 * que `^docs\/(?!notas\/)` no puede omitir `docs`: se leen sus excepciones (`conserva`: «docs/notas/») y una
 * carpeta que contiene una se recorre. Una regex con `(?!` que no tenga esa forma solo omite archivos.
 */
function compilarFiltros(lista) {
    const salida = [];
    for (const crudo of lista || []) {
        const f = String(crudo).trim();
        if (!f) continue;
        const esRegex = f.length > 2 && f.startsWith("/") && f.endsWith("/");
        const fuente = esRegex ? f.slice(1, -1) : "^" + f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        let rx;
        try {
            rx = new RegExp(fuente, "i");
        } catch (e) {
            console.warn("[omitir-carpetas] filtro inválido en «Archivos excluidos»:", f);
            continue;
        }
        let conserva = [];
        let soloArchivos = false;
        if (fuente.includes("(?!")) {
            const m = /^\^((?:\\.|[^\\()[\]{}*+?|.$^])*)\(\?!((?:\\.|[^\\()[\]{}*+?.$^])*)\)$/.exec(fuente);
            const literal = (s) => s.replace(/\\(.)/g, "$1").toLowerCase();
            if (m) conserva = m[2].split("|").map((x) => literal(m[1]) + literal(x));
            else soloArchivos = true;
        }
        salida.push({ rx, conserva, soloArchivos });
    }
    return salida;
}

/** Las rutas que contienen a `ruta`, de la más cercana a la raíz (`""`). */
function* ancestros(ruta) {
    let i = ruta.lastIndexOf("/");
    while (i > 0) {
        ruta = ruta.slice(0, i);
        yield ruta;
        i = ruta.lastIndexOf("/");
    }
    yield "";
}

class OmitirCarpetas extends Plugin {
    async onload() {
        this.ajustes = Object.assign({}, PREDETERMINADO, await this.loadData());
        this.omitidas = new Set();   // carpetas que no entraron al vault en esta sesión
        this.repos = new Set();      // carpetas con .git ya vistas ("" si el vault mismo es un repo)
        this.originales = null;
        this.addSettingTab(new PestanaOmitirCarpetas(this.app, this));

        const adaptador = this.app.vault.adapter;
        if (!(adaptador instanceof FileSystemAdapter)) return;   // móvil: no hay nada que omitir
        if (METODOS.some((m) => typeof adaptador[m] !== "function")) {
            new Notice("Omitir carpetas: esta versión de Obsidian no tiene los métodos que envuelve; no omite nada.");
            return;
        }
        await this.prepararReglas(adaptador);
        this.envolver(adaptador);
        this.envolverCache(this.app.metadataCache);

        this.app.workspace.onLayoutReady(() => {
            console.info(`[omitir-carpetas] ${this.omitidas.size} carpetas omitidas`);
        });
    }

    onunload() {
        if (!this.originales) return;
        const adaptador = this.app.vault.adapter;
        for (const m of METODOS) delete adaptador[m];   // vuelve el método del prototipo
        const cache = this.app.metadataCache;
        if (cache) {
            delete cache.initialize;
            delete cache.deletePath;
        }
        this.originales = null;
    }

    onUserEnable() {
        new Notice("Omitir carpetas: recarga Obsidian para que el vault se lea sin las carpetas omitidas.");
    }

    async prepararReglas(adaptador) {
        this.nombres = new Set(this.ajustes.nombres.map((n) => n.trim()).filter(Boolean));
        this.filtros = [];
        if (this.ajustes.excluidos) {
            // app.json se lee directo: no depende de que la configuración del vault ya esté cargada.
            let filtros = this.app.vault.getConfig("userIgnoreFilters");
            try {
                filtros = JSON.parse(await adaptador.read(this.app.vault.configDir + "/app.json")).userIgnoreFilters;
            } catch (e) {
                // sin app.json legible, valen los filtros que ya tenga el vault en memoria
            }
            this.filtros = compilarFiltros(filtros);
        }
        if (this.ajustes.reposAnidados && (await this.tieneGit(adaptador, ""))) this.repos.add("");
    }

    async tieneGit(adaptador, real) {
        try {
            await adaptador.fsPromises.lstat(adaptador.path.join(adaptador.getFullRealPath(real), ".git"));
            return true;
        } catch (e) {
            return false;
        }
    }

    /** Si la ruta cuelga de una carpeta ya omitida (un aviso del vigilante puede llegar con una ruta profunda). */
    cuelgaDeOmitida(ruta) {
        if (!this.omitidas.size) return false;
        for (const a of ancestros(ruta)) if (this.omitidas.has(a)) return true;
        return false;
    }

    excluida(ruta, esCarpeta) {
        if (!esCarpeta) return this.filtros.some((f) => f.rx.test(ruta));
        // Obsidian prueba la carpeta con «/» al final: así «docs/notas/» escapa de /^docs\/(?!notas\/)/.
        const q = ruta + "/";
        const ql = q.toLowerCase();
        return this.filtros.some(
            (f) => !f.soloArchivos && f.rx.test(q) && !f.conserva.some((c) => c.startsWith(ql)),
        );
    }

    envolver(adaptador) {
        const plugin = this;
        this.originales = {};
        for (const m of METODOS) this.originales[m] = adaptador[m];
        const { reconcileFolderCreation, reconcileFileCreation } = this.originales;

        adaptador.reconcileFolderCreation = async function (real, ruta) {
            if (plugin.nombres.has(nombreBase(ruta)) || plugin.cuelgaDeOmitida(ruta) || plugin.excluida(ruta, true)) {
                plugin.omitidas.add(ruta);
                return;
            }
            if (plugin.ajustes.reposAnidados && (await plugin.tieneGit(this, real))) {
                for (const a of ancestros(ruta)) {
                    if (plugin.repos.has(a)) {
                        plugin.omitidas.add(ruta);
                        return;
                    }
                }
                plugin.repos.add(ruta);   // antes de listar sus hijos: un repo dentro de este ya lo encuentra
            }
            return reconcileFolderCreation.call(this, real, ruta);
        };

        adaptador.reconcileFileCreation = function (real, ruta, st) {
            if (plugin.cuelgaDeOmitida(ruta) || plugin.excluida(ruta, false)) return Promise.resolve();
            return reconcileFileCreation.call(this, real, ruta, st);
        };
    }

    /** Durante MetadataCache.initialize, los borrados de la caché se juntan y se cierran en una sola pasada. */
    envolverCache(cache) {
        if (!cache || METODOS_CACHE.some((m) => typeof cache[m] !== "function")) return;
        const plugin = this;
        const initialize = cache.initialize;
        cache.initialize = async function (...args) {
            const borrados = [];
            // lo mismo que deletePath de Obsidian 1.14.5, sin updateRelatedLinks ni la cola por cada archivo
            this.deletePath = function (ruta) {
                delete this.resolvedLinks[ruta];
                delete this.unresolvedLinks[ruta];
                this.saveFileCache(ruta, null);
                borrados.push(ruta);
            };
            try {
                return await initialize.apply(this, args);
            } finally {
                delete this.deletePath;
                delete this.initialize;
                if (borrados.length) plugin.cerrarBorrados(this, borrados);
            }
        };
    }

    /**
     * Encola para resolver sus enlaces los archivos que enlazan a algo borrado, como lo haría updateRelatedLinks una vez
     * por borrado: enlaces resueltos comparados por nombre de archivo; sin resolver, también sin «.md».
     */
    cerrarBorrados(cache, rutas) {
        const nombres = new Set();
        const sinResolver = new Set();
        for (const ruta of rutas) {
            const n = nombreBase(ruta).toLowerCase();
            nombres.add(n);
            sinResolver.add(n);
            if (n.endsWith(".md")) sinResolver.add(n.slice(0, -3));
        }
        const enlaza = (enlaces, conjunto) => {
            if (!enlaces) return false;
            for (const k of Object.keys(enlaces)) if (conjunto.has(nombreBase(k).toLowerCase())) return true;
            return false;
        };
        for (const ruta of Object.keys(cache.fileCache || {})) {
            if (enlaza(cache.resolvedLinks[ruta], nombres) || enlaza(cache.unresolvedLinks[ruta], sinResolver)) {
                const archivo = this.app.vault.getFileByPath(ruta);
                if (archivo) cache.queueFileForLinkResolution(archivo);
            }
        }
        cache.queueFileForLinkResolution(null);
        if (cache.inProgressTaskCount === 0) cache.didFinish();
        console.info(`[omitir-carpetas] caché: ${rutas.length} entradas borradas de una vez`);
    }
}

class PestanaOmitirCarpetas extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        const p = this.plugin;
        const guardar = async () => {
            await p.saveData(p.ajustes);
            this.aviso.setText("Cambios guardados: se aplican al recargar Obsidian.");
        };
        containerEl.empty();

        containerEl.createEl("p", {
            text:
                `Obsidian no lee ni vigila lo omitido. En esta sesión se omitieron ${p.omitidas.size} carpetas. ` +
                "Los cambios se aplican al recargar.",
        });

        new Setting(containerEl)
            .setName("Nombres de carpeta")
            .setDesc("Una por línea. Se omite toda carpeta con ese nombre, en cualquier parte del vault.")
            .addTextArea((t) =>
                t.setValue(p.ajustes.nombres.join("\n")).onChange(async (v) => {
                    p.ajustes.nombres = v.split("\n").map((x) => x.trim()).filter(Boolean);
                    await guardar();
                }),
            );

        new Setting(containerEl)
            .setName("Repos anidados")
            .setDesc("Omite toda carpeta con .git que esté dentro de otro repo: submódulos y clones internos.")
            .addToggle((t) =>
                t.setValue(p.ajustes.reposAnidados).onChange(async (v) => {
                    p.ajustes.reposAnidados = v;
                    await guardar();
                }),
            );

        new Setting(containerEl)
            .setName("Omitir de verdad los «Archivos excluidos»")
            .setDesc(
                "Lo que hoy solo se oculta deja de leerse. Es lo más rápido, pero un enlace de una nota a un " +
                    "archivo excluido queda sin resolver, y al pulsarlo Obsidian crea una nota vacía.",
            )
            .addToggle((t) =>
                t.setValue(p.ajustes.excluidos).onChange(async (v) => {
                    p.ajustes.excluidos = v;
                    await guardar();
                }),
            );

        new Setting(containerEl).addButton((b) =>
            b
                .setButtonText("Recargar Obsidian")
                .setCta()
                .onClick(() => this.app.commands.executeCommandById("app:reload")),
        );
        this.aviso = containerEl.createEl("p", { cls: "setting-item-description" });
    }
}

module.exports = OmitirCarpetas;
module.exports.compilarFiltros = compilarFiltros;   // para prueba.js
