(() => {
  "use strict";
  const root = document.getElementById("reader-root");
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const state = { current: null, snapshot: null, key: null, area: "cookbook", assets: new Map(), theme: localStorage.getItem("mad-static-theme") || "paper" };
  const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  const base64Bytes = (value) => { const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="); return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)); };
  const route = () => new URLSearchParams(location.hash.replace(/^#\/?/u, ""));
  const setRoute = (params) => { location.hash = params.toString(); };
  const favoriteKey = (kind, id) => `mad-static-favorite:${kind}:${id}`;
  const isFavorite = (kind, id, fallback) => { const local = localStorage.getItem(favoriteKey(kind, id)); return local === null ? Boolean(fallback) : local === "1"; };
  const toggleFavorite = (kind, id, fallback) => { const next = !isFavorite(kind, id, fallback); localStorage.setItem(favoriteKey(kind, id), next ? "1" : "0"); return next; };

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
    root.innerHTML = `<section class="lock"><form class="lock-card"><div class="petal" aria-hidden="true">✣</div><p class="eyebrow">Muffins After Dark</p><h1>Your private reader.</h1><h2>The Buck & Muffin Marriage Cookbook · Story Time</h2><p>This is a reader-only encrypted copy. Enter the same shared passphrase you use for the private library.</p><label><span>Shared passphrase</span><input type="password" autocomplete="current-password" minlength="16" required autofocus></label><button class="primary" type="submit">Open the reader</button>${message ? `<p class="error" role="alert">${esc(message)}</p>` : ""}<p><small>No ChatGPT or GitHub sign-in is needed. The passphrase stays on this device.</small></p></form></section>`;
    root.querySelector("form").addEventListener("submit", unlock);
  }
  async function unlock(event) {
    event.preventDefault();
    const input = event.currentTarget.querySelector("input"); const button = event.currentTarget.querySelector("button");
    button.disabled = true; button.textContent = "Opening…";
    try {
      const response = await fetch("./library/current.json", { cache: "no-store" });
      if (!response.ok) throw new Error("No reader copy has been published yet.");
      const current = await response.json();
      if (!current.published) throw new Error("This reader copy is currently unpublished.");
      const key = await deriveKey(input.value, current.header);
      const plaintext = await decryptFile(current.snapshotPath, key);
      const snapshot = JSON.parse(decoder.decode(plaintext));
      if (snapshot.version !== 1 || !Array.isArray(snapshot.recipes) || !Array.isArray(snapshot.stories)) throw new Error("This reader copy is not valid.");
      state.current = current; state.snapshot = snapshot; state.key = key;
      render();
    } catch { lockScreen("That passphrase could not open this reader, or the published copy is unavailable."); }
  }

  function shell(content) {
    root.innerHTML = `<div class="shell"><header class="topbar"><div class="brand"><i aria-hidden="true">✣</i><span><strong>Muffins After Dark</strong><small>Reader-only library</small></span></div><nav class="switch" aria-label="Library"><button data-area="cookbook" class="${state.area === "cookbook" ? "active" : ""}">Cookbook</button><button data-area="story" class="${state.area === "story" ? "active" : ""}">Story Time</button></nav><div class="top-actions"><button data-action="home">Library</button><button data-action="lock">Lock</button></div></header>${content}</div>`;
    root.querySelectorAll("[data-area]").forEach((button) => button.addEventListener("click", () => { state.area = button.dataset.area; setRoute(new URLSearchParams({ area: state.area })); }));
    root.querySelector('[data-action="home"]').addEventListener("click", () => setRoute(new URLSearchParams({ area: state.area })));
    root.querySelector('[data-action="lock"]').addEventListener("click", () => { state.assets.forEach(URL.revokeObjectURL); state.assets.clear(); state.key = null; state.snapshot = null; history.replaceState(null, "", location.pathname); lockScreen(); });
  }

  function render() {
    if (!state.snapshot) return lockScreen();
    const params = route(); state.area = params.get("area") === "story" ? "story" : "cookbook";
    const recipeId = params.get("recipe"); const editionId = params.get("edition");
    if (recipeId) return renderRecipe(recipeId);
    if (editionId) return renderStory(editionId);
    return state.area === "story" ? renderStorybook() : renderCookbook();
  }

  function renderCookbook() {
    const recipes = state.snapshot.recipes;
    const heats = ["All", "Favorites", "Sweet", "Saucy", "Hot", "Filthy"];
    const active = sessionStorage.getItem("mad-static-recipe-filter") || "All";
    const visible = recipes.filter(({ recipe, draft }) => active === "All" || active === "Favorites" ? active === "All" || isFavorite("recipe", recipe.id, recipe.favorite) : draft.heat === active);
    shell(`<main class="page"><header class="hero"><div><p class="eyebrow">The Cookbook</p><h1>Choose what sounds good.</h1><p>A focused, reader-only shelf of finished recipes. Favorite, schedule, and print without exposing the creative workspace.</p></div><span>${recipes.length} recipes</span></header><nav class="filters">${heats.map((item) => `<button data-filter="${item}" class="${active === item ? "active" : ""}">${item === "Favorites" ? "♥ Favorites" : item}</button>`).join("")}</nav>${visible.length ? `<section class="grid">${visible.map(({ recipe, draft }) => `<button class="card" data-recipe="${esc(recipe.id)}"><span class="heat">${esc(draft.heat)}</span><h2>${esc(draft.title)}</h2><p>${esc(draft.subtitle)}</p><footer><span>${esc(draft.duration || "Open timing")}</span><span>${isFavorite("recipe", recipe.id, recipe.favorite) ? "♥" : "→"}</span></footer></button>`).join("")}</section>` : `<section class="empty"><h2>Nothing on this shelf yet.</h2><p>Try another filter.</p></section>`}</main>`);
    root.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => { sessionStorage.setItem("mad-static-recipe-filter", button.dataset.filter); renderCookbook(); }));
    root.querySelectorAll("[data-recipe]").forEach((button) => button.addEventListener("click", () => setRoute(new URLSearchParams({ area: "cookbook", recipe: button.dataset.recipe }))));
  }

  async function renderRecipe(id) {
    const item = state.snapshot.recipes.find(({ recipe }) => recipe.id === id);
    if (!item) return renderCookbook();
    const { recipe, draft } = item;
    const cover = draft.coverArt ? await assetUrl(draft.coverArt.assetId, draft.coverArt.contentType).catch(() => "") : "";
    const invitation = (draft.invitations || []).map((entry) => `<li><strong>${esc(entry.tone)}:</strong> <span class="dialogue">${esc(entry.text)}</span></li>`).join("");
    shell(`<main class="detail"><header class="detail-tools"><button class="ghost" data-back>← Cookbook</button><div><button class="ghost" data-favorite>${isFavorite("recipe", recipe.id, recipe.favorite) ? "♥ Favorite" : "♡ Favorite"}</button><button class="ghost" data-print>Print booklet</button></div></header><section class="cover"><div class="cover-copy"><p class="eyebrow">${esc(draft.heat)} · ${(draft.collections || []).map(esc).join(" · ")}</p><h1>${esc(draft.title)}</h1><h2>${esc(draft.subtitle)}</h2><div class="cover-meta"><span>${esc(draft.duration)}</span><span>${esc(draft.energy)}</span><span>${esc(draft.bookletPages)} pages</span></div></div><div class="cover-img" ${cover ? `style="background-image:url('${cover}')" data-lightbox="${cover}"` : ""}></div></section><section class="recipe-actions"><button class="primary" data-start>Start now</button><button class="ghost" data-calendar>Add to Meal Plan</button></section><section class="meal-panel" hidden><label>When?<input type="datetime-local" data-date></label><label>Neutral calendar title<input value="Private time" data-title></label><button class="primary" data-download>Download .ics</button></section><article class="recipe-copy"><section><p class="eyebrow">The invitation</p><p class="story-lead">${esc(draft.story)}</p></section><section><p class="eyebrow">Muffin’s Move</p><h2>The part she begins.</h2><p>${esc(draft.muffinMove)}</p></section><section><p class="eyebrow">Buck’s Card</p><h2>What she asks from him.</h2><p>${esc(draft.buckCard)}</p></section>${(draft.miseEnPlace || []).length ? `<section><p class="eyebrow">Mise en place</p><h2>Set the table.</h2><ul>${draft.miseEnPlace.map((entry) => `<li>${esc(entry)}</li>`).join("")}</ul></section>` : ""}${invitation ? `<section><p class="eyebrow">Invitation variations</p><ul>${invitation}</ul></section>` : ""}<section class="steps"><p class="eyebrow">The method</p><h2>Follow the heat.</h2>${(draft.method || []).map((step) => `<div class="step"><small>${esc(step.owner)}${step.minutes ? ` · ${esc(step.minutes)} min` : ""}</small><h3>${esc(step.title)}</h3><p>${esc(step.body)}</p></div>`).join("")}</section>${listSection("Make it fit us", draft.makeItFitUs)}${listSection("Turn up the heat", draft.turnUpTheHeat)}<section><p class="eyebrow">Finish & reset</p><p>${esc(draft.finishAndReset)}</p></section></article></main>`);
    root.querySelector("[data-back]").addEventListener("click", () => setRoute(new URLSearchParams({ area: "cookbook" })));
    root.querySelector("[data-favorite]").addEventListener("click", (event) => { const next = toggleFavorite("recipe", recipe.id, recipe.favorite); event.currentTarget.textContent = next ? "♥ Favorite" : "♡ Favorite"; });
    root.querySelector("[data-print]").addEventListener("click", () => printBooklet(draft));
    root.querySelector("[data-start]").addEventListener("click", () => root.querySelector(".recipe-copy").scrollIntoView({ behavior: "smooth" }));
    root.querySelector("[data-calendar]").addEventListener("click", () => { const panel = root.querySelector(".meal-panel"); panel.hidden = !panel.hidden; });
    root.querySelector("[data-download]").addEventListener("click", () => downloadCalendar(draft, root.querySelector("[data-date]").value, root.querySelector("[data-title]").value));
    wireLightbox();
  }
  function listSection(title, values) { return values?.length ? `<section><p class="eyebrow">${esc(title)}</p><ul>${values.map((entry) => `<li>${esc(entry)}</li>`).join("")}</ul></section>` : ""; }

  function renderStorybook() {
    const stories = state.snapshot.stories;
    const favorites = sessionStorage.getItem("mad-static-story-filter") === "favorites";
    const visible = favorites ? stories.filter(({ edition, presentation }) => isFavorite("story", edition.id, presentation.favorite)) : stories;
    shell(`<main class="page"><header class="hero"><div><p class="eyebrow">Story Time</p><h1>The Storybook.</h1><p>Finished stories in a focused reading environment with adjustable type, saved place, favorites, images, and printing.</p></div><span>${stories.length} stories</span></header><nav class="filters"><button data-story-filter="all" class="${favorites ? "" : "active"}">All stories</button><button data-story-filter="favorites" class="${favorites ? "active" : ""}">♥ Favorites</button></nav>${visible.length ? `<section class="grid">${visible.map(({ edition, presentation, seriesTitle, seriesSequence }) => `<button class="card" data-edition="${esc(edition.id)}"><span class="heat">${seriesTitle ? `${esc(seriesTitle)} · ${esc(seriesSequence || "")}` : `Edition ${esc(edition.number)}`}</span><h2>${esc(edition.document.title)}</h2><p>${esc(presentation.description || edition.document.logline || edition.document.subtitle)}</p><footer><span>${wordCount(documentText(edition.document)).toLocaleString()} words</span><span>${isFavorite("story", edition.id, presentation.favorite) ? "♥" : "Read →"}</span></footer></button>`).join("")}</section>` : `<section class="empty"><h2>No stories on this shelf.</h2></section>`}</main>`);
    root.querySelectorAll("[data-story-filter]").forEach((button) => button.addEventListener("click", () => { sessionStorage.setItem("mad-static-story-filter", button.dataset.storyFilter); renderStorybook(); }));
    root.querySelectorAll("[data-edition]").forEach((button) => button.addEventListener("click", () => setRoute(new URLSearchParams({ area: "story", edition: button.dataset.edition }))));
  }

  async function renderStory(id) {
    const item = state.snapshot.stories.find(({ edition }) => edition.id === id);
    if (!item) return renderStorybook();
    const { edition, presentation, images } = item;
    const imageMap = new Map(images.map((image) => [image.id, image]));
    const coverImage = presentation.coverImageId ? imageMap.get(presentation.coverImageId) : null;
    const coverUrl = coverImage ? await assetUrl(coverImage.assetId, coverImage.contentType).catch(() => "") : "";
    const prefs = readerPrefs();
    document.body.className = `theme-${prefs.theme}`;
    const headings = richHeadings(edition.document.richContent).filter((heading) => heading.level === 2 || heading.level === 3);
    root.innerHTML = `<main class="story-reader"><header class="reader-bar"><button class="ghost" data-back>← Storybook</button><strong>${esc(edition.document.title)}</strong><button class="ghost" data-favorite>${isFavorite("story", edition.id, presentation.favorite) ? "♥" : "♡"}</button><button class="ghost" data-print>Print</button></header><section class="reader-settings"><label>Theme<select data-theme><option value="paper">Paper</option><option value="white">White</option><option value="sepia">Sepia</option><option value="midnight">Midnight</option></select></label><label>Font size<input type="range" min="16" max="28" value="${prefs.fontSize}" data-font></label><label>Line height<input type="range" min="1.35" max="2" step=".05" value="${prefs.lineHeight}" data-leading></label></section><div class="reader-layout"><nav class="toc" aria-label="Table of contents">${headings.map((heading) => `<a href="#story-node-${esc(heading.id)}">${esc(heading.title)}</a>`).join("")}</nav><article class="story-article" style="--reader-size:${prefs.fontSize}px;--reader-leading:${prefs.lineHeight};--reader-align:${prefs.alignment}"><header class="story-opening">${coverUrl ? `<img class="story-cover-image" src="${coverUrl}" alt="${esc(coverImage.altText)}" data-lightbox="${coverUrl}">` : ""}<p class="eyebrow">Muffins After Dark · Story Time</p><h1>${esc(edition.document.title)}</h1><h2>${esc(edition.document.subtitle)}</h2><blockquote>${esc(edition.document.logline)}</blockquote><small>Edition ${edition.number} · ${wordCount(documentText(edition.document)).toLocaleString()} words</small></header><div class="story-body"></div></article></div></main>`;
    root.querySelector("[data-theme]").value = prefs.theme;
    const body = root.querySelector(".story-body");
    if (edition.document.richContent) await renderRich(edition.document.richContent, body, imageMap);
    else await renderSections(edition.document.sections || [], body, imageMap);
    const progress = Number(localStorage.getItem(`mad-static-progress:${edition.id}`) || 0);
    if (progress > 1) requestAnimationFrame(() => scrollTo(0, Math.max(0, (document.documentElement.scrollHeight - innerHeight) * progress)));
    let saveTimer; addEventListener("scroll", () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => localStorage.setItem(`mad-static-progress:${edition.id}`, String(scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight))), 400); }, { passive: true, once: false });
    root.querySelector("[data-back]").addEventListener("click", () => { document.body.className = ""; setRoute(new URLSearchParams({ area: "story" })); });
    root.querySelector("[data-favorite]").addEventListener("click", (event) => { event.currentTarget.textContent = toggleFavorite("story", edition.id, presentation.favorite) ? "♥" : "♡"; });
    root.querySelector("[data-print]").addEventListener("click", () => { document.body.dataset.printKind = "story"; print(); setTimeout(() => delete document.body.dataset.printKind, 500); });
    root.querySelector("[data-theme]").addEventListener("change", (event) => updateReaderPrefs({ theme: event.target.value }, edition.id));
    root.querySelector("[data-font]").addEventListener("input", (event) => updateReaderPrefs({ fontSize: Number(event.target.value) }, edition.id));
    root.querySelector("[data-leading]").addEventListener("input", (event) => updateReaderPrefs({ lineHeight: Number(event.target.value) }, edition.id));
    wireLightbox();
  }

  async function renderRich(node, target, imageMap) {
    for (const child of node.content || []) {
      const id = String(child.attrs?.nodeId || "");
      if (child.type === "heading") { const level = Number(child.attrs?.level || 2); if (level === 1) continue; const heading = document.createElement(level === 3 ? "h3" : "h2"); heading.id = `story-node-${id}`; appendInline(heading, child.content || []); target.append(heading); }
      else if (child.type === "paragraph") { if (child.attrs?.storyRole === "subtitle") continue; const p = document.createElement("p"); appendInline(p, child.content || []); target.append(p); }
      else if (child.type === "blockquote") { const quote = document.createElement("blockquote"); appendNestedInline(quote, child.content || []); target.append(quote); }
      else if (child.type === "sceneBreak") target.insertAdjacentHTML("beforeend", "<hr aria-label=\"Scene break\">");
      else if (child.type === "bulletList" || child.type === "orderedList") { const list = document.createElement(child.type === "bulletList" ? "ul" : "ol"); (child.content || []).forEach((entry) => { const li = document.createElement("li"); appendNestedInline(li, entry.content || []); list.append(li); }); target.append(list); }
      else if (child.type === "storyImage") await appendFigure(target, imageMap.get(String(child.attrs?.imageId || "")), child.attrs || {});
    }
  }
  async function renderSections(sections, target, imageMap) { for (const section of sections) { const heading = document.createElement(section.kind === "section" ? "h3" : "h2"); heading.id = `story-node-${section.id}`; heading.textContent = section.title; target.append(heading); for (const block of section.blocks || []) { if (block.type === "sceneBreak") target.append(document.createElement("hr")); else if (block.type === "figure") await appendFigure(target, imageMap.get(block.imageId), { caption: block.caption, altText: block.altText }); else { const el = document.createElement(block.type === "dialogue" ? "blockquote" : "p"); (block.inlines || []).forEach((inline) => el.append(document.createTextNode(inline.text || ""))); target.append(el); } } await renderSections(section.children || [], target, imageMap); } }
  function appendInline(target, nodes) { nodes.forEach((node) => { if (node.type !== "text") return appendInline(target, node.content || []); let el = document.createTextNode(node.text || ""); (node.marks || []).forEach((mark) => { const wrapper = document.createElement(mark.type === "bold" ? "strong" : mark.type === "italic" ? "em" : mark.type === "underline" ? "u" : "span"); wrapper.append(el); el = wrapper; }); target.append(el); }); }
  function appendNestedInline(target, nodes) { nodes.forEach((node) => node.type === "text" ? appendInline(target, [node]) : appendNestedInline(target, node.content || [])); }
  async function appendFigure(target, image, attrs) { if (!image) return; const url = await assetUrl(image.assetId, image.contentType).catch(() => ""); if (!url) return; const figure = document.createElement("figure"); const img = document.createElement("img"); img.src = url; img.alt = String(attrs.altText || image.altText || "Story illustration"); img.dataset.lightbox = url; figure.append(img); if (attrs.caption) { const caption = document.createElement("figcaption"); caption.textContent = String(attrs.caption); figure.append(caption); } target.append(figure); }
  function richHeadings(node, output = []) { if (!node) return output; if (node.type === "heading") output.push({ id: String(node.attrs?.nodeId || ""), title: nodeText(node), level: Number(node.attrs?.level || 2) }); (node.content || []).forEach((child) => richHeadings(child, output)); return output; }
  function nodeText(node) { return node.text || (node.content || []).map(nodeText).join(""); }
  function documentText(documentValue) { return documentValue.richContent ? nodeText(documentValue.richContent) : (documentValue.sections || []).map((section) => `${section.title} ${(section.blocks || []).map((block) => (block.inlines || []).map((inline) => inline.text).join("")).join(" ")}`).join(" "); }
  function wordCount(text) { return String(text || "").trim().split(/\s+/u).filter(Boolean).length; }
  function readerPrefs() { try { return { fontSize: 19, lineHeight: 1.65, alignment: "left", theme: "paper", ...JSON.parse(localStorage.getItem("mad-static-reader-prefs") || "{}") }; } catch { return { fontSize: 19, lineHeight: 1.65, alignment: "left", theme: "paper" }; } }
  function updateReaderPrefs(change, editionId) { const prefs = { ...readerPrefs(), ...change }; localStorage.setItem("mad-static-reader-prefs", JSON.stringify(prefs)); const article = root.querySelector(".story-article"); article.style.setProperty("--reader-size", `${prefs.fontSize}px`); article.style.setProperty("--reader-leading", prefs.lineHeight); document.body.className = `theme-${prefs.theme}`; localStorage.setItem(`mad-static-progress:${editionId}`, String(scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight))); }

  function downloadCalendar(draft, startsAt, title) { const start = startsAt ? new Date(startsAt) : new Date(Date.now() + 86400000); const end = new Date(start.getTime() + 60 * 60000); const format = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/u, ""); const uid = `${crypto.randomUUID()}@muffins-after-dark`; const safe = String(title || "Private time").replace(/[\\,;]/g, " ").replace(/\n/g, " "); const content = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Muffins After Dark//Reader//EN","BEGIN:VEVENT",`UID:${uid}`,`DTSTAMP:${format(new Date())}`,`DTSTART:${format(start)}`,`DTEND:${format(end)}`,`SUMMARY:${safe}`,"BEGIN:VALARM","TRIGGER:-PT30M","ACTION:DISPLAY","DESCRIPTION:Reminder","END:VALARM","END:VEVENT","END:VCALENDAR"].join("\r\n"); download(new Blob([content], { type: "text/calendar" }), `${safe.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "private-time"}.ics`); const plans = JSON.parse(localStorage.getItem("mad-static-meal-plan") || "[]"); plans.push({ title: safe, startsAt: start.toISOString(), recipeTitle: draft.title }); localStorage.setItem("mad-static-meal-plan", JSON.stringify(plans)); toast("Calendar invitation downloaded."); }
  function download(blob, name) { const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 500); }
  function toast(text) { const el = document.createElement("div"); el.className = "toast"; el.textContent = text; document.body.append(el); setTimeout(() => el.remove(), 2400); }
  function wireLightbox() { root.querySelectorAll("[data-lightbox]").forEach((item) => item.addEventListener("click", () => { const box = document.getElementById("lightbox"); box.querySelector("img").src = item.dataset.lightbox; box.hidden = false; })); }
  document.getElementById("lightbox").addEventListener("click", (event) => { if (event.target.tagName !== "IMG") event.currentTarget.hidden = true; });

  function printBooklet(draft) {
    const count = [8,12,16].includes(Number(draft.bookletPages)) ? Number(draft.bookletPages) : 8;
    const split = (text) => { const words = String(text || "").split(/\s+/); const mid = Math.ceil(words.length / 2); return [words.slice(0,mid).join(" "), words.slice(mid).join(" ")]; };
    const [storyOne, storyTwo] = split(draft.story);
    const page = (label, title, content, className = "") => `<div class="${className}"><small>${esc(label)}</small><h2>${esc(title)}</h2>${content}</div>`;
    const list = (values) => `<ul>${(values || []).map((value) => `<li>${esc(value)}</li>`).join("")}</ul>`;
    const methodPages = (parts) => Array.from({ length: parts }, (_, chunk) => { const start = Math.floor(draft.method.length * chunk / parts); const end = Math.floor(draft.method.length * (chunk + 1) / parts); return page(`The method · ${chunk + 1} of ${parts}`, chunk === 0 ? "Begin here." : chunk === parts - 1 ? "Bring it home." : "Keep going.", draft.method.slice(start,end).map((step,index) => `<div class="booklet-step"><b>${start+index+1}</b> <strong>${esc(step.title)}</strong><p>${esc(step.body)}</p></div>`).join("")); });
    const cover = `<div class="booklet-cover"><span class="mini-mark">✣</span><small>Muffins After Dark</small><h1>${esc(draft.title)}</h1><p>${esc(draft.subtitle)}</p><small>The Buck & Muffin Marriage Cookbook</small></div>`;
    const move = page("Muffin’s Move", "The part she begins.", `<p>${esc(draft.muffinMove)}</p>`);
    const card = page("Buck’s Card", "What she asks from him.", `<p>${esc(draft.buckCard)}</p>`);
    const cardMise = page("Buck’s Card", "What she asks from him.", `<p>${esc(draft.buckCard)}</p><h3>Mise en place</h3>${list(draft.miseEnPlace)}`);
    const invitations = page("Invitations & dialogue", "Things to say.", list([...(draft.invitations || []).map((item) => `${item.tone}: ${item.text}`), ...(draft.wordsOnTheTongue || [])]));
    const fit = page("Make it fit us", "Keep what works.", list(draft.makeItFitUs)); const heat = page("Turn up the heat", "Take it further.", list(draft.turnUpTheHeat));
    const variations = page("Make it yours", "Fit, heat & reset.", `${list([...(draft.makeItFitUs || []), ...(draft.turnUpTheHeat || [])])}<p>${esc(draft.finishAndReset)}</p>`);
    const finish = page("Finish & reset", "Land it well.", `<p>${esc(draft.finishAndReset)}</p>`); const notes = page("Kitchen Table Review", "For next time.", `<p>________________________________</p><p>________________________________</p><p>Buck ____★ &nbsp; Muffin ____★</p>`);
    const back = page("Muffins After Dark", "Buck & Muffin", "<p>Made for their table.</p>");
    const pages = count === 16 ? [cover,page("The invitation · 1 of 2",draft.title,`<p class="booklet-story">${esc(storyOne)}</p>`),page("The invitation · 2 of 2","Stay in the scene.",`<p class="booklet-story">${esc(storyTwo)}</p>`),move,card,page("Mise en place","Set the table.",list(draft.miseEnPlace)),invitations,...methodPages(4),fit,heat,finish,notes,back] : count === 12 ? [cover,page("The invitation · 1 of 2",draft.title,`<p class="booklet-story">${esc(storyOne)}</p>`),page("The invitation · 2 of 2","Stay in the scene.",`<p class="booklet-story">${esc(storyTwo)}</p>`),move,cardMise,invitations,...methodPages(2),variations,finish,notes,back] : [cover,page("The invitation",draft.title,`<p class="booklet-story">${esc(draft.story)}</p>`),move,cardMise,...methodPages(2),variations,notes];
    const pairs = count === 16 ? [[16,1],[2,15],[14,3],[4,13],[12,5],[6,11],[10,7],[8,9]] : count === 12 ? [[12,1],[2,11],[10,3],[4,9],[8,5],[6,7]] : [[8,1],[2,7],[6,3],[4,5]];
    const section = document.createElement("section"); section.className = "print-root"; section.innerHTML = pairs.map(([left,right]) => `<div class="print-sheet"><div class="booklet-page">${pages[left-1]}<i>${left}</i></div><div class="booklet-page">${pages[right-1]}<i>${right}</i></div></div>`).join(""); document.body.append(section); print(); setTimeout(() => section.remove(), 600);
  }

  addEventListener("hashchange", render);
  lockScreen();
})();
