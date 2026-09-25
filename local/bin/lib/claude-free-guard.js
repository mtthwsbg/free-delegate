// claude-free settings guard: save / restore settings.json model + modelSettings.
// Usage: node claude-free-guard.js save|restore <settings.json> <saved.json>
const fs = require("fs"); const [mode, p, s] = process.argv.slice(2);
const j = JSON.parse(fs.readFileSync(p, "utf8"));
if (mode === "save") { fs.writeFileSync(s, JSON.stringify({ model: j.model, modelSettings: j.modelSettings })); process.exit(0); }
const o = JSON.parse(fs.readFileSync(s, "utf8"));
if (JSON.stringify([j.model, j.modelSettings]) === JSON.stringify([o.model, o.modelSettings])) { console.log("settings.json untouched"); process.exit(0); }
for (const k of ["model", "modelSettings"]) { if (o[k] === undefined) delete j[k]; else j[k] = o[k]; }
fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
console.log("claude-free: restored model settings in settings.json (a pick in this session had changed them)");
