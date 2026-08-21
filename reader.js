(() => {
  "use strict";

  const root = document.getElementById("reader-root");
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const state = { current: null, snapshot: null, key: null, area: "cookbook", assets: new Map(), cleanups: [], narration: null };
  const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  const base64Bytes = (value) => { const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="); return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)); };
  const route = () => new URLSearchParams(location.hash.replace(/^#\/?/u, ""));
  const setRoute = (params) => { location.hash = params.toString(); };
  const normalize = (value) => String(value || "").toLowerCase().replaceAll("&", "and").replace(/[^a-z0-9]+/gu, " ").trim();
  const favoriteKey = (kind, id) => `mad-static-favorite:${kind}:${id}`;
  const isFavorite = (kind, id, fallback) => { const local = localStorage.getItem(favoriteKey(kind, id)); return local === null ? Boolean(fallback) : local === "1"; };
  const toggleFavorite = (kind, id, fallback) => { const next = !isFavorite(kind, id, fallback); localStorage.setItem(favoriteKey(kind, id), next ? "1" : "0"); return next; };

  function cleanupView() {
    state.cleanups.splice(0).forEach((cleanup) => cleanup());
    stopNarration();
  }

  async function deriveKey(secret, header) {
    const material = await crypto.subtle.importKey("raw", encoder.encode(secret.trim()), "PBKDF2", false, ["deriveKey"]);
    const wrapKey = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: base64Bytes(header.salt), iterations: header.iterations, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64Bytes(header.wrapIv) }, wrapKey, base64Bytes(header.wrappedDataKey));
    return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  }

  async function decryptFile(path, key) {
    const response = await fetch(`./${path}`, { cache: "no-store" });
    if (!response.ok) throw new Error("The encrypted reader file is unavailable.");
    const envelope = await response.json();
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: base64Bytes(envelope.iv), additionalData: encoder.encode(path) }, key, base64Bytes(envelope.ciphertext));
  }

  async function assetUrl(assetId, contentType) {
    if (!assetId || !state.snapshot.assetMap[assetId]) return "";
    if (state.assets.has(assetId)) return state.assets.get(assetId);
    const bytes = await decryptFile(state.snapshot.assetMap[assetId], state.key);
    const url = URL.createObjectURL(new Blob([bytes], { type: contentType || "image/webp" }));
    state.assets.set(assetId, url);
    return url;
  }

  function lockScreen(message = "") {
    cleanupView();
    document.body.className = "";
    root.innerHTML = `<section class="lock"><form class="lock-card"><div class="petal" aria-hidden="true">✣</div><p class="eyebrow">Muffins After Dark</p><h1>Your private reader.</h1><h2>The Buck & Muffin Marriage Cookbook · Story Time</h2><p>This encrypted copy contains only the finished recipes and stories chosen in the private library.</p><label><span>Shared passphrase</span><input type="password" autocomplete="current-password" minlength="16" required autofocus></label><button class="primary" type="submit">Open the reader</button>${message ? `<p class="error" role="alert">${esc(message)}</p>` : ""}<p><small>No ChatGPT or GitHub sign-in is needed. The passphrase stays on this device.</small></p></form></section>`;
    root.querySelector("form").addEventListener("submit", unlock);
  }

  async function unlock(event) {
    event.preventDefault();
    const input = event.currentTarget.querySelector("input");
    const button = event.currentTarget.querySelector("button");
    button.disabled = true; button.textContent = "Opening…";
    try {
      const response = await fetch("./library/current.json", { cache: "no-store" });
      if (!response.ok) throw new Error("No reader copy has been published yet.");
      const current = await response.json();
      if (!current.published) throw new Error("This reader copy is currently unpublished.");
      const key = await deriveKey(input.value, current.header);
      const snapshot = JSON.parse(decoder.decode(await decryptFile(current.snapshotPath, key)));
      if (snapshot.version !== 1 || !Array.isArray(snapshot.recipes) || !Array.isArray(snapshot.stories)) throw new Error("This reader copy is not valid.");
      snapshot.collections ||= [];
      state.current = current; state.snapshot = snapshot; state.key = key;
      render();
    } catch {
      lockScreen("That passphrase could not open this reader, or the published copy is unavailable.");
    }
  }

  function shell(content) {
    document.body.className = "";
    root.innerHTML = `<div class="shell"><header class="topbar"><div class="brand"><i aria-hidden="true">✣</i><span><strong>Muffins After Dark</strong><small>The Buck & Muffin Marriage Cookbook</small></span></div><nav class="switch" aria-label="Library"><button data-area="cookbook" class="${state.area === "cookbook" ? "active" : ""}">Cookbook</button><button data-area="story" class="${state.area === "story" ? "active" : ""}">Story Time</button></nav><div class="top-actions"><button data-action="home">Library</button><button data-action="lock">Lock</button></div></header>${content}</div>`;
    root.querySelectorAll("[data-area]").forEach((button) => button.addEventListener("click", () => setRoute(new URLSearchParams({ area: button.dataset.area }))));
    root.querySelector('[data-action="home"]').addEventListener("click", () => setRoute(new URLSearchParams({ area: state.area })));
    root.querySelector('[data-action="lock"]').addEventListener("click", () => { state.assets.forEach(URL.revokeObjectURL); state.assets.clear(); state.key = null; state.snapshot = null; history.replaceState(null, "", location.pathname); lockScreen(); });
  }

  function render() {
    cleanupView();
    if (!state.snapshot) return lockScreen();
    const params = route();
    state.area = params.get("area") === "story" ? "story" : "cookbook";
    if (params.get("recipe")) return void renderRecipe(params.get("recipe"));
    if (params.get("edition")) return void renderStory(params.get("edition"));
    if (params.get("collection")) return renderCollection(params.get("collection"));
    return state.area === "story" ? renderStorybook() : renderCookbook();
  }

  function collectionMatches(collection, values = []) {
    const names = [collection.title, collection.eyebrow, ...(collection.aliases || [])].map(normalize);
    return values.some((value) => names.includes(normalize(value)) || names.some((name) => normalize(value).startsWith(`${name} `)));
  }

  function recipeCard({ recipe, draft }, collectionTitle = "") {
    return `<button class="card recipe-card" data-recipe="${esc(recipe.id)}"><span class="heat heat--${esc(String(draft.heat || "sweet").toLowerCase())}">${esc(draft.heat)}</span><div><p class="card-kicker">${esc(collectionTitle || draft.collections?.[0] || "Cookbook")}</p><h2>${esc(draft.title)}</h2><p>${esc(draft.subtitle)}</p></div><footer><span>${esc(draft.duration || "Open timing")}</span><span>${isFavorite("recipe", recipe.id, recipe.favorite) ? "♥" : "→"}</span></footer></button>`;
  }

  function wireRecipeCards(collection = "") {
    root.querySelectorAll("[data-recipe]").forEach((button) => button.addEventListener("click", () => setRoute(new URLSearchParams({ area: "cookbook", recipe: button.dataset.recipe, ...(collection ? { from: collection } : {}) }))));
  }

  function renderCookbook() {
    const recipes = state.snapshot.recipes;
    const active = sessionStorage.getItem("mad-static-recipe-filter") || "All";
    const query = sessionStorage.getItem("mad-static-recipe-query") || "";
    const visible = recipes.filter(({ recipe, draft }) => {
      const filterMatch = active === "All" || (active === "Favorites" ? isFavorite("recipe", recipe.id, recipe.favorite) : draft.heat === active);
      return filterMatch && `${draft.title} ${draft.subtitle} ${(draft.tags || []).join(" ")} ${(draft.collections || []).join(" ")}`.toLowerCase().includes(query.toLowerCase());
    });
    const heatFilters = ["All", "Favorites", "Sweet", "Saucy", "Hot", "Filthy"];
    shell(`<main class="page cookbook-page"><section class="cookbook-hero"><div><p class="eyebrow">The private collection</p><h1>What sounds good <em>tonight?</em></h1><p>Open a finished adventure or browse the shelves by mood, heat, and occasion.</p><button class="ghost" data-browse-collections>Browse collections</button></div><aside><p>This reader copy</p><strong>${recipes.length} plated</strong><span>${recipes.filter(({ recipe }) => isFavorite("recipe", recipe.id, recipe.favorite)).length} favorites</span></aside></section><section class="browse-tools"><label class="search-field"><span aria-hidden="true">⌕</span><input value="${esc(query)}" placeholder="Search the cookbook" aria-label="Search the cookbook"></label><nav class="filters" aria-label="Filter recipes">${heatFilters.map((item) => `<button data-filter="${item}" class="${active === item ? "active" : ""}">${item === "Favorites" ? "♥ Favorites" : item}</button>`).join("")}</nav></section>${visible.length ? `<section class="grid">${visible.map((item) => recipeCard(item)).join("")}</section>` : `<section class="empty"><h2>Nothing matches these filters.</h2><p>Try another heat level or clear the search.</p></section>`}<section id="collection-grid" class="collection-section"><header><h2>Cookbook collections.</h2><p>Every collection is a browsing lens, not a forced recipe template.</p></header><div class="collection-grid">${state.snapshot.collections.map((collection, index) => `<button data-collection="${esc(collection.slug)}"><span>${String(index + 1).padStart(2, "0")}</span><span class="collection-name"><small>${esc(collection.eyebrow)}</small><strong>${esc(collection.title)}</strong></span><small>${recipes.filter(({ draft }) => collectionMatches(collection, draft.collections)).length} recipes</small></button>`).join("")}</div></section></main>`);
    root.querySelector("[data-browse-collections]")?.addEventListener("click", () => document.getElementById("collection-grid")?.scrollIntoView({ behavior: "smooth" }));
    root.querySelector(".search-field input").addEventListener("input", (event) => { sessionStorage.setItem("mad-static-recipe-query", event.target.value); window.clearTimeout(state.searchTimer); state.searchTimer = window.setTimeout(renderCookbook, 160); });
    root.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => { sessionStorage.setItem("mad-static-recipe-filter", button.dataset.filter); renderCookbook(); }));
    root.querySelectorAll("[data-collection]").forEach((button) => button.addEventListener("click", () => setRoute(new URLSearchParams({ area: "cookbook", collection: button.dataset.collection }))));
    wireRecipeCards();
  }

  function renderCollection(slug) {
    const collections = state.snapshot.collections;
    const collection = collections.find((item) => item.slug === slug);
    if (!collection) return renderCookbook();
    const index = collections.indexOf(collection);
    const recipes = state.snapshot.recipes.filter(({ draft }) => collectionMatches(collection, draft.collections));
    shell(`<main class="collection-page"><nav class="crumbs"><button data-back>Cookbook</button><span>›</span><strong>${esc(collection.title)}</strong></nav><header class="collection-hero"><div><p class="eyebrow">Collection ${String(index + 1).padStart(2, "0")} · ${esc(collection.eyebrow)}</p><h1>${esc(collection.title)}</h1><p>${esc(collection.description)}</p><button class="ghost" data-jump>${recipes.length ? `Browse ${recipes.length} ${recipes.length === 1 ? "recipe" : "recipes"}` : "See the empty shelf"}</button></div><aside><span>What belongs here</span>${collection.includes.map((item) => `<strong>${esc(item)}</strong>`).join("")}</aside></header><section id="collection-recipes" class="collection-body"><header><div><p class="eyebrow">On this shelf</p><h2>${recipes.length ? "Recipes ready to open." : "Nothing has been plated here yet."}</h2></div><p>${recipes.length ? "Open a recipe to read it, favorite it, schedule it, or print its booklet." : "This reader shelf will fill the next time a matching recipe is published."}</p></header>${recipes.length ? `<div class="grid">${recipes.map((item) => recipeCard(item, collection.title)).join("")}</div>` : ""}</section><nav class="collection-pagination"><div>${index > 0 ? `<button data-previous="${esc(collections[index - 1].slug)}"><span>← Previous collection</span><strong>${esc(collections[index - 1].title)}</strong></button>` : ""}</div><button data-all>All collections</button><div>${index < collections.length - 1 ? `<button data-next="${esc(collections[index + 1].slug)}"><span>Next collection →</span><strong>${esc(collections[index + 1].title)}</strong></button>` : ""}</div></nav></main>`);
    const goHome = () => setRoute(new URLSearchParams({ area: "cookbook" }));
    root.querySelector("[data-back]").addEventListener("click", goHome); root.querySelector("[data-all]").addEventListener("click", goHome);
    root.querySelector("[data-jump]").addEventListener("click", () => document.getElementById("collection-recipes")?.scrollIntoView({ behavior: "smooth" }));
    root.querySelector("[data-previous]")?.addEventListener("click", (event) => setRoute(new URLSearchParams({ area: "cookbook", collection: event.currentTarget.dataset.previous })));
    root.querySelector("[data-next]")?.addEventListener("click", (event) => setRoute(new URLSearchParams({ area: "cookbook", collection: event.currentTarget.dataset.next })));
    wireRecipeCards(collection.slug);
  }

  async function renderRecipe(id) {
    const item = state.snapshot.recipes.find(({ recipe }) => recipe.id === id);
    if (!item) return renderCookbook();
    const { recipe, draft } = item;
    const cover = draft.coverArt ? await assetUrl(draft.coverArt.assetId, draft.coverArt.contentType).catch(() => "") : "";
    const from = route().get("from");
    const invitation = (draft.invitations || []).map((entry) => `<li><strong>${esc(entry.tone)}:</strong> <q class="dialogue">${esc(entry.text.replace(/^[“"]|[”"]$/gu, ""))}</q></li>`).join("");
    const collectionLinks = (draft.collections || []).map((name) => { const match = state.snapshot.collections.find((collection) => collectionMatches(collection, [name])); return match ? `<button data-cover-collection="${esc(match.slug)}">${esc(match.title)}</button>` : `<span>${esc(name)}</span>`; }).join("<i>·</i>");
    shell(`<main class="detail"><header class="detail-tools"><button class="ghost" data-back>← ${esc(state.snapshot.collections.find((entry) => entry.slug === from)?.title || "Cookbook")}</button><div><button class="ghost" data-favorite>${isFavorite("recipe", recipe.id, recipe.favorite) ? "♥ Favorite" : "♡ Favorite"}</button><button class="ghost" data-print>Print booklet</button></div></header><section class="cover cover--${esc(String(draft.heat || "sweet").toLowerCase())}"><div class="cover-copy"><span class="heat heat--${esc(String(draft.heat || "sweet").toLowerCase())}">${esc(draft.heat)}</span><nav class="cover-collections">${collectionLinks}</nav><h1>${esc(draft.title)}</h1><h2>${esc(draft.subtitle)}</h2><div class="cover-meta"><span>${esc(draft.duration || "Open timing")}</span><span>${esc(draft.energy || "Flexible energy")}</span><span>${esc(draft.bookletPages || 8)} pages</span></div></div>${cover ? `<img class="cover-img" src="${cover}" alt="${esc(draft.coverArt.altText || "Recipe cover illustration")}" data-lightbox="${cover}">` : `<div class="cover-watermark" aria-hidden="true">✣</div>`}</section><section class="recipe-actions"><button class="primary" data-start>Start now</button><button class="ghost" data-calendar>Add to Meal Plan</button></section><section class="meal-panel" hidden><label>When?<input type="datetime-local" data-date></label><label>Neutral calendar title<input value="Private time" data-title></label><button class="primary" data-download>Download .ics</button></section><article class="recipe-copy"><section><p class="eyebrow">The invitation</p><p class="story-lead">${esc(draft.story)}</p></section><section class="move-card"><p class="eyebrow">Muffin’s Move</p><h2>The part she begins.</h2><p>${esc(draft.muffinMove)}</p></section><section class="buck-card"><p class="eyebrow">Buck’s Card</p><h2>What she asks from him.</h2><p>${esc(draft.buckCard)}</p></section>${listSection("Mise en place", draft.miseEnPlace, "Set the table.")}${invitation ? `<section><p class="eyebrow">Invitation variations</p><h2>Things to say.</h2><ul>${invitation}</ul></section>` : ""}<section class="steps"><p class="eyebrow">The method</p><h2>Follow the heat.</h2>${(draft.method || []).map((step) => `<div class="step"><small>${esc(step.owner)}${step.minutes ? ` · ${esc(step.minutes)} min` : ""}</small><h3>${esc(step.title)}</h3><p>${esc(step.body)}</p></div>`).join("")}</section>${listSection("Make it fit us", draft.makeItFitUs, "Keep what works.")}${listSection("Turn up the heat", draft.turnUpTheHeat, "Take it further.")}<section><p class="eyebrow">Finish & reset</p><h2>Land it well.</h2><p>${esc(draft.finishAndReset)}</p></section></article></main>`);
    root.querySelector("[data-back]").addEventListener("click", () => setRoute(new URLSearchParams({ area: "cookbook", ...(from ? { collection: from } : {}) })));
    root.querySelectorAll("[data-cover-collection]").forEach((button) => button.addEventListener("click", () => setRoute(new URLSearchParams({ area: "cookbook", collection: button.dataset.coverCollection }))));
    root.querySelector("[data-favorite]").addEventListener("click", (event) => { event.currentTarget.textContent = toggleFavorite("recipe", recipe.id, recipe.favorite) ? "♥ Favorite" : "♡ Favorite"; });
    root.querySelector("[data-print]").addEventListener("click", () => printBooklet(draft));
    root.querySelector("[data-start]").addEventListener("click", () => root.querySelector(".recipe-copy").scrollIntoView({ behavior: "smooth" }));
    root.querySelector("[data-calendar]").addEventListener("click", () => { const panel = root.querySelector(".meal-panel"); panel.hidden = !panel.hidden; });
    root.querySelector("[data-download]").addEventListener("click", () => downloadCalendar(draft, root.querySelector("[data-date]").value, root.querySelector("[data-title]").value));
    wireLightbox();
  }

  function listSection(label, values, title = "") { return values?.length ? `<section><p class="eyebrow">${esc(label)}</p>${title ? `<h2>${esc(title)}</h2>` : ""}<ul>${values.map((entry) => `<li>${esc(entry)}</li>`).join("")}</ul></section>` : ""; }

  function renderStorybook() {
    const stories = state.snapshot.stories;
    const active = sessionStorage.getItem("mad-static-story-filter") || "All";
    const tags = [...new Set(stories.flatMap(({ presentation }) => presentation.tags || []))].sort((a, b) => a.localeCompare(b));
    const visible = stories.filter(({ edition, presentation }) => active === "All" || (active === "Favorites" ? isFavorite("story", edition.id, presentation.favorite) : (presentation.tags || []).includes(active)));
    shell(`<main class="page storybook-page"><header class="hero"><div><p class="eyebrow">Muffins After Dark · Story Time</p><h1>The Storybook.</h1><p>Finished stories in a focused reading environment with a saved place, personal typography, narration, images, favorites, and printing.</p></div><span>${stories.length} stories</span></header><nav class="filters story-filters"><button data-story-filter="All" class="${active === "All" ? "active" : ""}">All stories</button><button data-story-filter="Favorites" class="${active === "Favorites" ? "active" : ""}">♥ Favorites</button>${tags.map((tag) => `<button data-story-filter="${esc(tag)}" class="${active === tag ? "active" : ""}">${esc(tag)}</button>`).join("")}</nav>${visible.length ? `<section class="grid">${visible.map(({ edition, presentation, seriesTitle, seriesSequence }) => `<button class="card story-card" data-edition="${esc(edition.id)}"><span class="heat">${seriesTitle ? `${esc(seriesTitle)} · ${esc(seriesSequence || "")}` : `Edition ${esc(edition.number)}`}</span><div><h2>${esc(edition.document.title)}</h2><p>${esc(presentation.description || edition.document.logline || edition.document.subtitle)}</p></div><footer><span>${wordCount(documentText(edition.document)).toLocaleString()} words</span><span>${isFavorite("story", edition.id, presentation.favorite) ? "♥" : "Read →"}</span></footer></button>`).join("")}</section>` : `<section class="empty"><h2>No stories on this shelf.</h2><p>Choose another tag or republish more finished stories.</p></section>`}</main>`);
    root.querySelectorAll("[data-story-filter]").forEach((button) => button.addEventListener("click", () => { sessionStorage.setItem("mad-static-story-filter", button.dataset.storyFilter); renderStorybook(); }));
    root.querySelectorAll("[data-edition]").forEach((button) => button.addEventListener("click", () => setRoute(new URLSearchParams({ area: "story", edition: button.dataset.edition }))));
  }

  const readerDefaults = { fontFamily: "editorial", fontSize: 19, lineHeight: 1.65, measure: 68, paragraphSpacing: 1.15, alignment: "left", columns: "single", columnGap: 40, theme: "paper", dialogueStyle: "traditional", speechRate: 1, speechVoice: "" };
  const readerId = () => sessionStorage.getItem("mad-static-reader-person") || "";
  function readerPrefs(person = readerId() || "buck") { try { return { ...readerDefaults, ...JSON.parse(localStorage.getItem(`mad-static-reader-prefs:${person}`) || "{}") }; } catch { return { ...readerDefaults }; } }
  function saveReaderPrefs(change, editionId) { const person = readerId() || "buck"; const prefs = { ...readerPrefs(person), ...change }; localStorage.setItem(`mad-static-reader-prefs:${person}`, JSON.stringify(prefs)); applyReaderPrefs(prefs); saveProgress(editionId); }
  function progressKey(editionId) { return `mad-static-progress:${readerId() || "buck"}:${editionId}`; }
  function saveProgress(editionId) { localStorage.setItem(progressKey(editionId), String(scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight))); }
  function applyReaderPrefs(prefs) {
    const reader = root.querySelector(".story-reader"); const article = root.querySelector(".story-article");
    if (!reader || !article) return;
    reader.className = `story-reader reader-theme--${prefs.theme} reader-font--${prefs.fontFamily} reader-columns--${prefs.columns} reader-align--${prefs.alignment} reader-dialogue-mode--${prefs.dialogueStyle}`;
    reader.style.setProperty("--reader-bg", prefs.theme === "white" ? "#fff" : prefs.theme === "sepia" ? "#e8d8b9" : prefs.theme === "midnight" ? "#14211c" : "#f5eedf");
    reader.style.setProperty("--reader-ink", prefs.theme === "midnight" ? "#e8e0cf" : prefs.theme === "sepia" ? "#352b22" : "#1d2822");
    article.style.setProperty("--reader-size", `${prefs.fontSize}px`); article.style.setProperty("--reader-leading", prefs.lineHeight); article.style.setProperty("--reader-measure", `${prefs.measure}ch`); article.style.setProperty("--reader-paragraph", `${prefs.paragraphSpacing}em`); article.style.setProperty("--reader-gap", `${prefs.columnGap}px`);
  }

  async function renderStory(id) {
    const item = state.snapshot.stories.find(({ edition }) => edition.id === id);
    if (!item) return renderStorybook();
    const { edition, presentation, images } = item;
    const imageMap = new Map(images.map((image) => [image.id, image]));
    const coverImage = presentation.coverImageId ? imageMap.get(presentation.coverImageId) : null;
    const coverUrl = coverImage ? await assetUrl(coverImage.assetId, coverImage.contentType).catch(() => "") : "";
    const prefs = readerPrefs();
    const headings = edition.document.richContent ? richHeadings(edition.document.richContent).filter((heading) => heading.level === 2 || heading.level === 3) : sectionHeadings(edition.document.sections || []);
    root.innerHTML = `<main class="story-reader"><header class="reader-bar"><button data-back>← Storybook</button><span class="reader-location"><strong>${esc(edition.document.title)}</strong><small data-progress-label>Saved place</small></span><div><button data-favorite aria-label="Favorite story">${isFavorite("story", edition.id, presentation.favorite) ? "♥" : "♡"}</button><button data-print>Print</button><button data-contents>Contents</button><button data-theme-toggle aria-label="Toggle light or dark theme">${prefs.theme === "midnight" ? "☀" : "☾"}</button><button data-settings>Aa</button><button data-focus>Focus</button>${"speechSynthesis" in window ? `<button data-listen>Listen</button>` : ""}</div></header><aside class="toc" aria-label="Table of contents"><header><div><strong>Table of Contents</strong><small>${wordCount(documentText(edition.document)).toLocaleString()} words</small></div><button data-close-contents>Close</button></header><nav>${headings.map((heading) => `<a href="#story-node-${esc(heading.id)}" data-heading="${esc(heading.id)}" class="level-${heading.level}"><span>${heading.level === 3 ? "Section" : "Chapter"}</span><strong>${esc(heading.title)}</strong></a>`).join("")}</nav></aside><aside class="reader-settings" hidden><header><strong>${esc((readerId() || "Your").replace(/^./u, (letter) => letter.toUpperCase()))} reading settings</strong><button data-close-settings>Done</button></header>${readerSettingsMarkup(prefs)}</aside><article class="story-article"><header class="story-opening">${coverUrl ? `<img class="story-cover-image" src="${coverUrl}" alt="${esc(coverImage.altText)}" data-lightbox="${coverUrl}">` : ""}<p class="eyebrow">Muffins After Dark · Story Time</p><h1>${esc(edition.document.title)}</h1><h2>${esc(edition.document.subtitle)}</h2><blockquote>${esc(edition.document.logline)}</blockquote><small>Edition ${edition.number} · ${wordCount(documentText(edition.document)).toLocaleString()} words</small></header><div class="story-body"></div><footer class="reader-end"><span>End</span><h2>${esc(edition.document.title)}</h2><button data-complete>Mark complete</button></footer></article>${readerId() ? "" : readerIdentityMarkup()}</main>`;
    const body = root.querySelector(".story-body");
    if (edition.document.richContent) await renderRich(edition.document.richContent, body, imageMap);
    else await renderSections(edition.document.sections || [], body, imageMap);
    applyReaderPrefs(prefs);
    wireStoryReader(edition, presentation, headings);
    wireLightbox();
  }

  function readerIdentityMarkup() { return `<div class="reader-person-backdrop" role="dialog" aria-modal="true"><section><p class="eyebrow">Separate places, one Storybook</p><h2>Who is reading?</h2><p>Your display preferences and place in each story stay separate on this device.</p><div><button data-reader="buck">Buck</button><button data-reader="muffin">Muffin</button></div></section></div>`; }
  function readerSettingsMarkup(prefs) { return `<label><span>Theme</span><select data-pref="theme"><option value="white">White</option><option value="paper">Paper</option><option value="sepia">Sepia</option><option value="midnight">Midnight</option></select></label><label><span>Font</span><select data-pref="fontFamily"><option value="editorial">Editorial Serif</option><option value="classic">Classic Book Serif</option><option value="sans">Clean Sans</option><option value="accessible">Accessible Sans</option></select></label><label><span>Font size · <output>${prefs.fontSize}px</output></span><input data-pref="fontSize" type="range" min="16" max="28" value="${prefs.fontSize}"></label><label><span>Line height · <output>${prefs.lineHeight}</output></span><input data-pref="lineHeight" type="range" min="1.35" max="2" step=".05" value="${prefs.lineHeight}"></label><label><span>Reading width · <output>${prefs.measure} characters</output></span><input data-pref="measure" type="range" min="42" max="82" value="${prefs.measure}"></label><label><span>Paragraph spacing · <output>${prefs.paragraphSpacing}</output></span><input data-pref="paragraphSpacing" type="range" min=".4" max="1.8" step=".1" value="${prefs.paragraphSpacing}"></label><label><span>Alignment</span><select data-pref="alignment"><option value="left">Left</option><option value="justify">Justified</option></select></label><label><span>Columns</span><select data-pref="columns"><option value="single">Single</option><option value="double">Two on wide screens</option></select></label><label><span>Column gap · <output>${prefs.columnGap}px</output></span><input data-pref="columnGap" type="range" min="24" max="64" value="${prefs.columnGap}"></label><label><span>Dialogue</span><select data-pref="dialogueStyle"><option value="traditional">Traditional</option><option value="accent">Accent highlighted</option><option value="indented">Indented</option><option value="blocks">Standalone blocks</option></select></label>${"speechSynthesis" in window ? `<label><span>Speech rate · <output>${prefs.speechRate}</output></span><input data-pref="speechRate" type="range" min=".7" max="1.5" step=".1" value="${prefs.speechRate}"></label><label><span>Voice</span><select data-pref="speechVoice"><option value="">Device default</option>${speechSynthesis.getVoices().map((voice) => `<option value="${esc(voice.voiceURI)}">${esc(voice.name)} · ${esc(voice.lang)}</option>`).join("")}</select></label>` : `<p class="reader-capability-note">Narration is not available in this browser.</p>`}`; }

  function wireStoryReader(edition, presentation, headings) {
    const settings = root.querySelector(".reader-settings"); const toc = root.querySelector(".toc");
    const prefs = readerPrefs();
    root.querySelectorAll("[data-pref]").forEach((control) => { control.value = prefs[control.dataset.pref]; control.addEventListener(control.tagName === "INPUT" ? "input" : "change", (event) => { const key = event.target.dataset.pref; const numeric = ["fontSize", "lineHeight", "measure", "paragraphSpacing", "columnGap", "speechRate"].includes(key); const value = numeric ? Number(event.target.value) : event.target.value; const output = event.target.closest("label")?.querySelector("output"); if (output) output.textContent = `${value}${key === "fontSize" || key === "columnGap" ? "px" : key === "measure" ? " characters" : ""}`; saveReaderPrefs({ [key]: value }, edition.id); }); });
    root.querySelector("[data-back]").addEventListener("click", () => setRoute(new URLSearchParams({ area: "story" })));
    root.querySelector("[data-favorite]").addEventListener("click", (event) => { event.currentTarget.textContent = toggleFavorite("story", edition.id, presentation.favorite) ? "♥" : "♡"; });
    root.querySelector("[data-print]").addEventListener("click", () => { document.body.dataset.printKind = "story"; print(); window.setTimeout(() => delete document.body.dataset.printKind, 600); });
    root.querySelector("[data-settings]").addEventListener("click", () => { settings.hidden = !settings.hidden; }); root.querySelector("[data-close-settings]").addEventListener("click", () => { settings.hidden = true; });
    root.querySelector("[data-contents]").addEventListener("click", () => toc.classList.toggle("open")); root.querySelector("[data-close-contents]").addEventListener("click", () => toc.classList.remove("open"));
    root.querySelector("[data-theme-toggle]").addEventListener("click", () => saveReaderPrefs({ theme: readerPrefs().theme === "midnight" ? "paper" : "midnight" }, edition.id));
    root.querySelector("[data-focus]").addEventListener("click", async () => { if (document.fullscreenElement) await document.exitFullscreen(); else await root.querySelector(".story-reader").requestFullscreen?.(); });
    root.querySelector("[data-listen]")?.addEventListener("click", (event) => toggleNarration(event.currentTarget, edition.id));
    root.querySelector("[data-complete]").addEventListener("click", () => { localStorage.setItem(progressKey(edition.id), "1"); toast("Marked complete for this reader."); });
    root.querySelectorAll("[data-reader]").forEach((button) => button.addEventListener("click", () => { sessionStorage.setItem("mad-static-reader-person", button.dataset.reader); render(); }));
    root.querySelectorAll(".toc a").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); document.getElementById(`story-node-${link.dataset.heading}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); toc.classList.remove("open"); }));
    const observer = new IntersectionObserver((entries) => { const active = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]; if (!active) return; const id = active.target.id.replace("story-node-", ""); root.querySelectorAll(".toc a").forEach((link) => link.classList.toggle("active", link.dataset.heading === id)); root.querySelector("[data-progress-label]").textContent = active.target.textContent; }, { rootMargin: "-18% 0px -72% 0px" });
    headings.forEach((heading) => { const element = document.getElementById(`story-node-${heading.id}`); if (element) observer.observe(element); }); state.cleanups.push(() => observer.disconnect());
    let saveTimer; const onScroll = () => { window.clearTimeout(saveTimer); saveTimer = window.setTimeout(() => saveProgress(edition.id), 500); }; addEventListener("scroll", onScroll, { passive: true }); state.cleanups.push(() => { removeEventListener("scroll", onScroll); window.clearTimeout(saveTimer); saveProgress(edition.id); });
    const progress = Number(localStorage.getItem(progressKey(edition.id)) || 0); if (progress > 0) requestAnimationFrame(() => scrollTo(0, Math.max(0, (document.documentElement.scrollHeight - innerHeight) * progress)));
  }

  async function renderRich(node, target, imageMap) {
    for (const child of node.content || []) {
      const id = String(child.attrs?.nodeId || "");
      if (child.type === "heading") { const level = Number(child.attrs?.level || 2); if (level === 1) continue; const heading = document.createElement(level === 3 ? "h3" : "h2"); heading.id = `story-node-${id}`; appendInline(heading, child.content || []); target.append(heading); }
      else if (child.type === "paragraph") { if (child.attrs?.storyRole === "subtitle") continue; const p = document.createElement("p"); p.dataset.blockId = id; if (child.attrs?.storyRole === "note") p.className = "reader-note"; appendInline(p, child.content || []); target.append(p); }
      else if (child.type === "blockquote") { const quote = document.createElement("blockquote"); quote.dataset.blockId = id; if (child.attrs?.storyRole === "dialogue") quote.className = "reader-dialogue-block"; appendNestedInline(quote, child.content || []); target.append(quote); }
      else if (child.type === "sceneBreak") target.insertAdjacentHTML("beforeend", "<hr aria-label=\"Scene break\">");
      else if (child.type === "bulletList" || child.type === "orderedList") { const list = document.createElement(child.type === "bulletList" ? "ul" : "ol"); (child.content || []).forEach((entry) => { const li = document.createElement("li"); appendNestedInline(li, entry.content || []); list.append(li); }); target.append(list); }
      else if (child.type === "storyImage") await appendFigure(target, imageMap.get(String(child.attrs?.imageId || "")), child.attrs || {});
    }
  }

  async function renderSections(sections, target, imageMap) { for (const section of sections) { const heading = document.createElement(section.kind === "section" ? "h3" : "h2"); heading.id = `story-node-${section.id}`; heading.textContent = section.title; target.append(heading); for (const block of section.blocks || []) { if (block.type === "sceneBreak") target.append(document.createElement("hr")); else if (block.type === "figure") await appendFigure(target, imageMap.get(block.imageId), { caption: block.caption, altText: block.altText }); else { const el = document.createElement(block.type === "dialogue" ? "blockquote" : "p"); el.dataset.blockId = block.id; if (block.type === "dialogue") el.className = "reader-dialogue-block"; (block.inlines || []).forEach((inline) => el.append(document.createTextNode(inline.text || ""))); target.append(el); } } await renderSections(section.children || [], target, imageMap); } }
  function appendInline(target, nodes) { nodes.forEach((node) => { if (node.type !== "text") return appendInline(target, node.content || []); let el = document.createTextNode(node.text || ""); (node.marks || []).forEach((mark) => { const wrapper = document.createElement(mark.type === "bold" ? "strong" : mark.type === "italic" ? "em" : mark.type === "underline" ? "u" : mark.type === "link" ? "a" : "span"); if (mark.type === "link" && /^https?:\/\//u.test(String(mark.attrs?.href || ""))) { wrapper.href = mark.attrs.href; wrapper.rel = "noreferrer"; } wrapper.append(el); el = wrapper; }); target.append(el); }); }
  function appendNestedInline(target, nodes) { nodes.forEach((node) => node.type === "text" ? appendInline(target, [node]) : appendNestedInline(target, node.content || [])); }
  async function appendFigure(target, image, attrs) { if (!image) return; const url = await assetUrl(image.assetId, image.contentType).catch(() => ""); if (!url) return; const figure = document.createElement("figure"); const img = document.createElement("img"); img.src = url; img.alt = String(attrs.altText || image.altText || "Story illustration"); img.dataset.lightbox = url; img.style.width = `${Number(attrs.width || 100)}%`; img.style.marginInline = attrs.align === "left" ? "0 auto" : attrs.align === "right" ? "auto 0" : "auto"; figure.append(img); if (attrs.caption) { const caption = document.createElement("figcaption"); caption.textContent = String(attrs.caption); figure.append(caption); } target.append(figure); }
  function richHeadings(node, output = []) { if (!node) return output; if (node.type === "heading") output.push({ id: String(node.attrs?.nodeId || ""), title: nodeText(node), level: Number(node.attrs?.level || 2) }); (node.content || []).forEach((child) => richHeadings(child, output)); return output; }
  function sectionHeadings(sections, output = []) { sections.forEach((section) => { output.push({ id: section.id, title: section.title, level: section.kind === "section" ? 3 : 2 }); sectionHeadings(section.children || [], output); }); return output; }
  function nodeText(node) { return node.text || (node.content || []).map(nodeText).join(""); }
  function documentText(documentValue) { return documentValue.richContent ? nodeText(documentValue.richContent) : (documentValue.sections || []).map((section) => `${section.title} ${(section.blocks || []).map((block) => (block.inlines || []).map((inline) => inline.text).join("")).join(" ")}`).join(" "); }
  function wordCount(text) { return String(text || "").trim().split(/\s+/u).filter(Boolean).length; }

  function toggleNarration(button, editionId) {
    if (!("speechSynthesis" in window)) return;
    if (state.narration) { stopNarration(); button.textContent = "Listen"; return; }
    const entries = [...root.querySelectorAll(".story-body h2,.story-body h3,.story-body p,.story-body blockquote")].map((node) => node.textContent.trim()).filter(Boolean);
    if (!entries.length) return;
    const prefs = readerPrefs(); let index = 0; state.narration = { button };
    const speakNext = () => { if (!state.narration || index >= entries.length) { stopNarration(); button.textContent = "Listen"; return; } const utterance = new SpeechSynthesisUtterance(entries[index++]); utterance.rate = prefs.speechRate; const voice = speechSynthesis.getVoices().find((item) => item.voiceURI === prefs.speechVoice); if (voice) utterance.voice = voice; utterance.onend = speakNext; utterance.onerror = () => { stopNarration(); button.textContent = "Listen"; }; state.narration.utterance = utterance; speechSynthesis.speak(utterance); };
    button.textContent = "Stop"; speakNext(); saveProgress(editionId);
  }
  function stopNarration() { if (state.narration && "speechSynthesis" in window) speechSynthesis.cancel(); state.narration = null; }

  function downloadCalendar(draft, startsAt, title) { const start = startsAt ? new Date(startsAt) : new Date(Date.now() + 86400000); const end = new Date(start.getTime() + 60 * 60000); const format = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/u, ""); const uid = `${crypto.randomUUID()}@muffins-after-dark`; const safe = String(title || "Private time").replace(/[\\,;]/g, " ").replace(/\n/g, " "); const content = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Muffins After Dark//Reader//EN", "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${format(new Date())}`, `DTSTART:${format(start)}`, `DTEND:${format(end)}`, `SUMMARY:${safe}`, "BEGIN:VALARM", "TRIGGER:-PT30M", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n"); download(new Blob([content], { type: "text/calendar" }), `${safe.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "private-time"}.ics`); toast("Calendar invitation downloaded."); }
  function download(blob, name) { const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 500); }
  function toast(text) { const element = document.createElement("div"); element.className = "toast"; element.textContent = text; document.body.append(element); window.setTimeout(() => element.remove(), 2400); }
  function wireLightbox() { root.querySelectorAll("[data-lightbox]").forEach((item) => item.addEventListener("click", () => { const box = document.getElementById("lightbox"); box.querySelector("img").src = item.dataset.lightbox; box.hidden = false; })); }
  document.getElementById("lightbox").addEventListener("click", (event) => { if (event.target.tagName !== "IMG") event.currentTarget.hidden = true; });

  function printBooklet(draft) {
    const count = [8, 12, 16].includes(Number(draft.bookletPages)) ? Number(draft.bookletPages) : 8;
    const split = (text) => { const words = String(text || "").split(/\s+/); const middle = Math.ceil(words.length / 2); return [words.slice(0, middle).join(" "), words.slice(middle).join(" ")]; };
    const [storyOne, storyTwo] = split(draft.story);
    const page = (label, title, content, className = "") => `<div class="${className}"><small class="folio-label">${esc(label)}</small><h2>${esc(title)}</h2>${content}</div>`;
    const list = (values) => `<ul>${(values || []).map((value) => `<li>${esc(value)}</li>`).join("")}</ul>`;
    const method = draft.method || [];
    const methodPages = (parts) => Array.from({ length: parts }, (_, chunk) => { const start = Math.floor(method.length * chunk / parts); const end = Math.floor(method.length * (chunk + 1) / parts); return page(`The method · ${chunk + 1} of ${parts}`, chunk === 0 ? "Begin here." : chunk === parts - 1 ? "Bring it home." : "Keep going.", method.slice(start, end).map((step, index) => `<article class="booklet-step"><b>${start + index + 1}</b><div><strong>${esc(step.title)}</strong><p>${esc(step.body)}</p></div></article>`).join("")); });
    const cover = `<div class="booklet-cover"><img src="./assets/muffins-move.png" alt=""><span>Muffins After Dark</span><h1>${esc(draft.title)}</h1><p>${esc(draft.subtitle)}</p><small>The Buck & Muffin Marriage Cookbook</small></div>`;
    const move = page("Muffin’s Move", "The part she begins.", `<p>${esc(draft.muffinMove)}</p><div class="print-meta"><span>${esc(draft.duration || "Open timing")}</span><span>${esc(draft.heat)}</span><span>${esc(draft.energy || "Flexible energy")}</span></div>`);
    const card = page("Buck’s Card", "What she asks from him.", `<p>${esc(draft.buckCard)}</p>`);
    const cardMise = page("Buck’s Card", "What she asks from him.", `<p>${esc(draft.buckCard)}</p><h3>Mise en place</h3>${list(draft.miseEnPlace)}`);
    const invitations = page("Invitations & dialogue", "Things to say.", list([...(draft.invitations || []).map((item) => `${item.tone}: ${item.text}`), ...(draft.wordsOnTheTongue || [])]));
    const fit = page("Make it fit us", "Keep what works.", list(draft.makeItFitUs)); const heat = page("Turn up the heat", "Take it further.", list(draft.turnUpTheHeat));
    const variations = page("Make it yours", "Fit, heat & reset.", `${list([...(draft.makeItFitUs || []), ...(draft.turnUpTheHeat || [])])}<p>${esc(draft.finishAndReset)}</p>`);
    const finish = page("Finish & reset", "Land it well.", `<p>${esc(draft.finishAndReset)}</p>`); const notes = page("Kitchen Table Review", "For next time.", `<div class="note-lines"></div><p>Buck ____★ &nbsp; Muffin ____★</p>`); const back = page("Muffins After Dark", "Buck & Muffin", "<p>Made for their table.</p>", "booklet-back");
    const pages = count === 16 ? [cover, page("The invitation · 1 of 2", draft.title, `<p class="booklet-story">${esc(storyOne)}</p>`), page("The invitation · 2 of 2", "Stay in the scene.", `<p class="booklet-story">${esc(storyTwo)}</p>`), move, card, page("Mise en place", "Set the table.", list(draft.miseEnPlace)), invitations, ...methodPages(4), fit, heat, finish, notes, back] : count === 12 ? [cover, page("The invitation · 1 of 2", draft.title, `<p class="booklet-story">${esc(storyOne)}</p>`), page("The invitation · 2 of 2", "Stay in the scene.", `<p class="booklet-story">${esc(storyTwo)}</p>`), move, cardMise, invitations, ...methodPages(2), variations, finish, notes, back] : [cover, page("The invitation", draft.title, `<p class="booklet-story">${esc(draft.story)}</p>`), move, cardMise, ...methodPages(2), variations, notes];
    const pairs = count === 16 ? [[16,1],[2,15],[14,3],[4,13],[12,5],[6,11],[10,7],[8,9]] : count === 12 ? [[12,1],[2,11],[10,3],[4,9],[8,5],[6,7]] : [[8,1],[2,7],[6,3],[4,5]];
    const section = document.createElement("section"); section.className = "print-root"; section.innerHTML = pairs.map(([left, right], index) => `<div class="print-sheet"><div class="booklet-page">${pages[left - 1]}<i>${left}</i></div><div class="booklet-page">${pages[right - 1]}<i>${right}</i></div>${index === 0 ? '<span class="fold-mark"></span>' : ""}</div>`).join(""); document.body.append(section); print(); window.setTimeout(() => section.remove(), 700);
  }

  addEventListener("hashchange", render);
  lockScreen();
})();
