/**
 * prueba.js — prueba de Omitir carpetas sin Obsidian: `node prueba.js` (sale 0 si todo pasa).
 *
 * Arma un vault de juguete en una carpeta temporal y lo recorre con un adaptador falso que sigue la lógica del
 * FileSystemAdapter de Obsidian 1.14.5 (listRecursive → listRecursiveChild → reconcileFileInternal →
 * reconcileFolderCreation / reconcileFileCreation, en paralelo, saltando lo que empieza con punto).
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const Module = require("module");

const avisos = [];

class FileSystemAdapter {
    constructor(base) {
        this.basePath = base;
        this.fsPromises = fs.promises;
        this.path = path;
        this.files = {};
        this.vigiladas = new Set();
    }
    getFullRealPath(real) {
        return path.join(this.basePath, real);
    }
    async read(ruta) {
        return fs.promises.readFile(this.getFullRealPath(ruta), "utf8");
    }
    async listAll() {
        this.files = { "/": { type: "folder" } };
        await this.listRecursive("");
    }
    async listRecursive(ruta) {
        const nombres = await fs.promises.readdir(this.getFullRealPath(ruta));
        await Promise.all(nombres.map((n) => this.listRecursiveChild(ruta, n)));
    }
    async listRecursiveChild(padre, nombre) {
        const ruta = padre ? padre + "/" + nombre : nombre;
        if (ruta.split("/").some((s) => s.startsWith("."))) return;
        await this.reconcileFileInternal(ruta, ruta);
    }
    async reconcileFileInternal(real, ruta) {
        const st = await fs.promises.lstat(this.getFullRealPath(real));
        if (st.isFile()) await this.reconcileFileCreation(real, ruta, st);
        else if (st.isDirectory()) await this.reconcileFolderCreation(real, ruta);
    }
    async reconcileFileCreation(real, ruta) {
        this.files[ruta] = { type: "file" };
    }
    async reconcileFolderCreation(real, ruta) {
        if (this.files[ruta]) return;
        this.files[ruta] = { type: "folder" };
        this.vigiladas.add(ruta);
        await this.listRecursive(real);
    }
}

const obsidianFalso = {
    FileSystemAdapter,
    Plugin: class {
        constructor(app) {
            this.app = app;
        }
        async loadData() {
            return this.app.datos;
        }
        async saveData() {}
        addSettingTab() {}
    },
    PluginSettingTab: class {},
    Setting: class {},
    Notice: class {
        constructor(m) {
            avisos.push(m);
        }
    },
};
const cargarOriginal = Module._load;
Module._load = function (pedido, ...resto) {
    return pedido === "obsidian" ? obsidianFalso : cargarOriginal.call(this, pedido, ...resto);
};
const OmitirCarpetas = require("./main.js");

function escribir(base, ruta, texto = "") {
    const p = path.join(base, ruta);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, texto);
}

function armarVault(raizEsRepo) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omitir-carpetas-"));
    escribir(base, ".obsidian/app.json", JSON.stringify({ userIgnoreFilters: ["excluido/", "/^docs\\/(?!notas\\/)/"] }));
    escribir(base, "notas/a.md");
    escribir(base, "proyecto/.git/HEAD");
    escribir(base, "proyecto/src/b.md");
    escribir(base, "proyecto/node_modules/x/y.js");
    escribir(base, "proyecto/sub/.git/HEAD");          // submódulo con carpeta .git (como web/_pubs/*)
    escribir(base, "proyecto/sub/c.md");
    escribir(base, "proyecto/sub2/.git", "gitdir: ../.git/modules/sub2");   // submódulo clásico
    escribir(base, "proyecto/sub2/c.md");
    escribir(base, "excluido/d.md");
    escribir(base, "docs/notas/e.md");
    escribir(base, "docs/otro/f.md");
    escribir(base, "docs/g.md");
    if (raizEsRepo) escribir(base, ".git/HEAD");
    return base;
}

async function recorrer(datos, raizEsRepo = false) {
    const base = armarVault(raizEsRepo);
    const adaptador = new FileSystemAdapter(base);
    const app = {
        datos,
        vault: { adapter: adaptador, configDir: ".obsidian", getConfig: () => [] },
        workspace: { onLayoutReady: (f) => f() },
    };
    const plugin = new OmitirCarpetas(app);
    await plugin.onload();
    await adaptador.listAll();
    fs.rmSync(base, { recursive: true, force: true });
    return { plugin, adaptador, vistos: new Set(Object.keys(adaptador.files)) };
}

const casos = {
    async "omite node_modules y repos anidados; ve el resto"() {
        const { vistos, adaptador, plugin } = await recorrer({});
        for (const r of ["notas/a.md", "proyecto/src/b.md", "excluido/d.md", "docs/notas/e.md", "docs/otro/f.md"])
            assert(vistos.has(r), "falta " + r);
        for (const r of ["proyecto/node_modules", "proyecto/node_modules/x/y.js", "proyecto/sub", "proyecto/sub/c.md",
            "proyecto/sub2", "proyecto/sub2/c.md"])
            assert(!vistos.has(r), "sobra " + r);
        assert(!adaptador.vigiladas.has("proyecto/node_modules"), "vigila node_modules");
        assert.deepStrictEqual([...plugin.omitidas].sort(), ["proyecto/node_modules", "proyecto/sub", "proyecto/sub2"]);
    },
    async "con excluidos, omite lo filtrado y respeta la excepción de la regex"() {
        const { vistos } = await recorrer({ excluidos: true });
        assert(vistos.has("docs/notas/e.md"), "falta docs/notas/e.md");
        assert(vistos.has("notas/a.md"), "falta notas/a.md");
        for (const r of ["excluido", "excluido/d.md", "docs/otro", "docs/otro/f.md", "docs/g.md"])
            assert(!vistos.has(r), "sobra " + r);
    },
    async "con los filtros de un vault real, nunca omite lo que Obsidian mostraría"() {
        // Solo con OBSIDIAN_VAULT: una carpeta omitida no puede tener debajo (hasta tres niveles) nada que Obsidian
        // mostraría, es decir, ninguna subcarpeta que sus filtros dejen pasar.
        const vault = process.env.OBSIDIAN_VAULT;
        if (!vault) return "sin OBSIDIAN_VAULT";
        const app = JSON.parse(fs.readFileSync(path.join(vault, ".obsidian/app.json"), "utf8"));
        const filtros = OmitirCarpetas.compilarFiltros(app.userIgnoreFilters);
        const plugin = new OmitirCarpetas({});
        plugin.filtros = filtros;
        const obsidianOculta = (ruta) => filtros.some((f) => f.rx.test(ruta + "/"));
        const carpetas = (rel, nivel) => {
            if (nivel > 3) return [];
            let hijos = [];
            try {
                hijos = fs.readdirSync(path.join(vault, rel), { withFileTypes: true });
            } catch (e) {
                return [];
            }
            return hijos
                .filter((d) => d.isDirectory() && !d.name.startsWith("."))
                .flatMap((d) => {
                    const r = rel ? rel + "/" + d.name : d.name;
                    return [r, ...carpetas(r, nivel + 1)];
                });
        };
        const todas = carpetas("", 1);
        for (const c of todas.filter((c) => plugin.excluida(c, true)))
            for (const d of todas.filter((d) => d.startsWith(c + "/")))
                assert(obsidianOculta(d), `omite ${c}, pero Obsidian mostraría ${d}`);
    },
    async "sin repos anidados, entran los submódulos"() {
        const { vistos } = await recorrer({ reposAnidados: false });
        assert(vistos.has("proyecto/sub/c.md") && vistos.has("proyecto/sub2/c.md"), "faltan los submódulos");
        assert(!vistos.has("proyecto/node_modules"), "sobra node_modules");
    },
    async "si el vault es un repo, todo repo de dentro es anidado"() {
        const { vistos } = await recorrer({}, true);
        assert(!vistos.has("proyecto/src/b.md"), "sobra proyecto");
        assert(vistos.has("notas/a.md"), "falta notas/a.md");
    },
    async "un aviso profundo del vigilante dentro de lo omitido no entra"() {
        const { adaptador } = await recorrer({});
        await adaptador.reconcileFileCreation("proyecto/node_modules/x/z.js", "proyecto/node_modules/x/z.js", {});
        assert(!adaptador.files["proyecto/node_modules/x/z.js"], "entró z.js");
    },
    async "onunload devuelve los métodos de Obsidian"() {
        const { adaptador, plugin } = await recorrer({});
        plugin.onunload();
        assert(!Object.hasOwn(adaptador, "reconcileFolderCreation") && !Object.hasOwn(adaptador, "reconcileFileCreation"));
    },
    async "los borrados por lotes encolan lo mismo que deletePath de Obsidian"() {
        // Caché falsa con deletePath y updateRelatedLinks copiados de Obsidian 1.14.5 (BR incluido).
        const base = (r) => r.slice(r.lastIndexOf("/") + 1);
        const BR = (e, t) => !!t && Object.keys(t).some((r) => e.includes(base(r).toLowerCase()));
        class Cache {
            constructor() {
                this.fileCache = {};
                this.resolvedLinks = {};
                this.unresolvedLinks = {};
                this.cola = new Set();
                this.inProgressTaskCount = 0;
                this.terminados = 0;
                const archivos = {
                    "notas/a.md": { r: { "p/node_modules/x/README.md": 1 }, u: {} },
                    "notas/b.md": { r: {}, u: { readme: 1 } },
                    "notas/c.md": { r: { "notas/a.md": 1 }, u: { otra: 1 } },
                    "notas/d.md": { r: {}, u: { "guia.qmd": 1 } },
                    "p/node_modules/x/README.md": { r: { "notas/a.md": 1 }, u: {} },
                    "web/_pubs/s/guia.qmd": { r: {}, u: {} },
                };
                for (const [k, v] of Object.entries(archivos)) {
                    this.fileCache[k] = {};
                    this.resolvedLinks[k] = v.r;
                    this.unresolvedLinks[k] = v.u;
                }
                this.vivos = new Set(["notas/a.md", "notas/b.md", "notas/c.md", "notas/d.md"]);
            }
            saveFileCache(e, t) {
                if (!t) delete this.fileCache[e];
            }
            queueFileForLinkResolution(f) {
                this.cola.add(f && f.path);
            }
            didFinish() {
                this.terminados++;
            }
            updateRelatedLinks(e) {
                const t = [];
                for (const r of e.map((x) => x.toLowerCase())) {
                    if (r.endsWith(".md")) t.push(r.slice(0, -3));
                    t.push(r);
                }
                for (const c of Object.keys(this.fileCache))
                    if (BR(e.map((x) => x.toLowerCase()), this.resolvedLinks[c]) || BR(t, this.unresolvedLinks[c]))
                        this.vivos.has(c) && this.queueFileForLinkResolution({ path: c });
            }
            deletePath(e) {
                delete this.resolvedLinks[e];
                delete this.unresolvedLinks[e];
                this.saveFileCache(e, null);
                this.updateRelatedLinks([base(e)]);
                this.queueFileForLinkResolution(null);
                if (this.inProgressTaskCount === 0) this.didFinish();
            }
            async initialize() {
                for (const c of Object.keys(this.fileCache)) if (!this.vivos.has(c)) this.deletePath(c);
            }
        }
        const original = new Cache();
        await original.initialize();
        const lotes = new Cache();
        const plugin = new OmitirCarpetas({ vault: { getFileByPath: (p) => (lotes.vivos.has(p) ? { path: p } : null) } });
        plugin.envolverCache(lotes);
        await lotes.initialize();
        assert.deepStrictEqual([...lotes.cola].sort(), [...original.cola].sort());
        assert.deepStrictEqual(Object.keys(lotes.fileCache).sort(), Object.keys(original.fileCache).sort());
        assert(lotes.terminados === 1, "didFinish una sola vez");
        assert(!Object.hasOwn(lotes, "deletePath") && !Object.hasOwn(lotes, "initialize"), "no devolvió los métodos");
    },
    async "si faltan los métodos, avisa y no envuelve"() {
        const adaptador = new FileSystemAdapter(os.tmpdir());
        adaptador.reconcileFileCreation = undefined;
        const plugin = new OmitirCarpetas({ datos: {}, vault: { adapter: adaptador }, workspace: {} });
        avisos.length = 0;
        await plugin.onload();
        assert(avisos.length === 1 && plugin.originales === null);
    },
};

(async () => {
    let fallos = 0;
    for (const [nombre, caso] of Object.entries(casos)) {
        try {
            const nota = await caso();
            console.log("  ✓ " + nombre + (typeof nota === "string" ? ` (${nota})` : ""));
        } catch (e) {
            fallos++;
            console.log("  ✗ " + nombre + ": " + e.message);
        }
    }
    process.exit(fallos ? 1 : 0);
})();
