// Single source of truth for the directories `lint` (oxlint) and
// `format`/`format:check` (oxfmt) cover. Add new source directories here,
// not in package.json — the three scripts all consume this list.
console.log(["engine", "ops", "bench", "cli", "scripts"].join(" "));
