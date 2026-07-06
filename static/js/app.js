(function () {
  "use strict";

  const state = {
    folders: [], tags: [],
    allNotesCount: 0, trashCount: 0, favoritesCount: 0,
    currentFolder: "all", currentTag: null,
    notes: [], currentNoteId: null, currentNoteDeleted: false,
    searchQuery: "", sortBy: "updated", viewMode: "list",
    filterMode: "all", dateFrom: null, dateTo: null,
    saveTimer: null, titleSaveTimer: null,
    dirty: false, titleDirty: false,
    quill: null, sidebarCollapsed: false, noteListCollapsed: false,
    drag: { active: false, noteId: null, noteTitle: "", sourceEl: null },
  };

  const el = id => document.getElementById(id);

  const ICONS = {
    folder:    `<svg viewBox="0 0 24 24" width="15" height="15"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.4a1.5 1.5 0 0 1 1.2.6l1.2 1.6a1.5 1.5 0 0 0 1.2.6h7a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.3z" fill="currentColor"/></svg>`,
    subFolder: `<svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 8.5A1.5 1.5 0 0 1 6.5 7h3.4a1.5 1.5 0 0 1 1.2.6l.9 1.2a1.5 1.5 0 0 0 1.2.6H19a1.5 1.5 0 0 1 1.5 1.5V18A1.5 1.5 0 0 1 19 19.5H6A1.5 1.5 0 0 1 4.5 18z" fill="currentColor" opacity=".7"/></svg>`,
    allNotes:  `<svg viewBox="0 0 24 24" width="15" height="15"><path d="M6 3h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`,
    favorites: `<svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="currentColor" opacity=".85"/></svg>`,
    trash:     `<svg viewBox="0 0 24 24" width="15" height="15"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    pinFilled: `<svg viewBox="0 0 24 24" width="11" height="11"><path d="M14 2l8 8-4 1-5 5-1 4-2-2 3-3-5-5-3 3-2-2 4-1 5-5 1-4z" fill="currentColor"/></svg>`,
    starFilled:`<svg viewBox="0 0 24 24" width="11" height="11"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="currentColor"/></svg>`,
    checklist: `<svg viewBox="0 0 18 18"><rect x="2" y="2" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 9l2.5 2.5L13 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  };

  /* ── API ── */
  async function api(url, opts) {
    const res = await fetch(url, Object.assign({ headers: { "Content-Type": "application/json" } }, opts));
    if (res.status === 401) { window.location.href = "/"; return; }
    if (!res.ok) {
      let msg = "Request failed";
      try { msg = (await res.json()).error || msg; } catch (_) {}
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  /* ── Dates / utils ── */
  function formatListDate(iso) {
    const d = new Date(iso), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    if (Math.floor((now - d) / 86400000) < 6) return d.toLocaleDateString([], { weekday: "long" });
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
    return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  function highlightMatch(text, query) {
    if (!query) return escapeHtml(text);
    const safe = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return escapeHtml(text).replace(new RegExp(`(${safe})`, "gi"), "<mark>$1</mark>");
  }

  /* ── Sort ── */
  function sortNotes(list) {
    const a = list.slice();
    if (state.sortBy === "manual")  return a.sort((a,b) => a.sort_order - b.sort_order);
    if (state.sortBy === "created") return a.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
    if (state.sortBy === "title")   return a.sort((a,b) => a.title.localeCompare(b.title));
    return a.sort((a,b) => new Date(b.updated_at) - new Date(a.updated_at));
  }

  /* ── Client filter (pinned/today/week; tag+date+favorite filters are server-side) ── */
  function applyClientFilter(notes) {
    const now = new Date();
    if (state.filterMode === "pinned")   return notes.filter(n => n.pinned);
    if (state.filterMode === "favorite") return notes.filter(n => n.is_favorite);
    if (state.filterMode === "today") {
      const t = now.toDateString();
      return notes.filter(n => new Date(n.updated_at).toDateString() === t);
    }
    if (state.filterMode === "week") {
      const w = new Date(now); w.setDate(now.getDate() - 7);
      return notes.filter(n => new Date(n.updated_at) >= w);
    }
    return notes;
  }

  /* ── Panel collapse ── */
  function collapseSidebar(v) {
    state.sidebarCollapsed = v != null ? v : !state.sidebarCollapsed;
    el("sidebar").classList.toggle("collapsed", state.sidebarCollapsed);
    el("sidebarTab").classList.toggle("hidden", !state.sidebarCollapsed);
  }
  function collapseNoteList(v) {
    state.noteListCollapsed = v != null ? v : !state.noteListCollapsed;
    el("noteListPane").classList.toggle("collapsed", state.noteListCollapsed);
    el("noteListTab").classList.toggle("hidden", !state.noteListCollapsed);
  }

  /* ── Toast ── */
  function showToast(msg) {
    const t = el("exportToast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 2600);
  }

  /* ════════════════════════════════════════
     SIDEBAR
  ════════════════════════════════════════ */
  async function loadSidebar() {
    const data = await api("/api/sidebar");
    if (!data) return;
    state.folders       = data.folders;
    state.tags          = data.tags || [];
    state.allNotesCount = data.all_notes_count;
    state.trashCount    = data.trash_count;
    state.favoritesCount= data.favorites_count || 0;
    renderFolderList();
    renderTagFilterChips();
  }

  /* Build the nested folder tree */
  function renderFolderList() {
    const container = el("folderList");
    container.innerHTML = "";

    // All Notes
    container.appendChild(buildFolderRow({ key:"all", name:"All Notes", icon:ICONS.allNotes, count:state.allNotesCount }));
    // Favorites
    container.appendChild(buildFolderRow({ key:"favorites", name:"Favorites", icon:ICONS.favorites, count:state.favoritesCount }));

    const d1 = document.createElement("div"); d1.className = "folder-divider"; container.appendChild(d1);

    // Build tree: top-level folders, then their children indented
    const roots = state.folders.filter(f => !f.parent_id);
    roots.forEach(f => renderFolderTree(container, f, 0));

    const d2 = document.createElement("div"); d2.className = "folder-divider"; container.appendChild(d2);
    container.appendChild(buildFolderRow({ key:"trash", name:"Recently Deleted", icon:ICONS.trash, count:state.trashCount, muted:true }));
  }

  function renderFolderTree(container, folder, depth) {
    const icon = depth > 0 ? ICONS.subFolder : ICONS.folder;
    container.appendChild(buildFolderRow({ key:folder.id, name:folder.name, icon, count:folder.note_count, folder, depth }));
    const children = state.folders.filter(f => f.parent_id === folder.id);
    children.forEach(c => renderFolderTree(container, c, depth + 1));
  }

  function buildFolderRow({ key, name, icon, count, folder, muted, depth = 0 }) {
    const row = document.createElement("div");
    const isSelected = state.currentTag ? false : String(state.currentFolder) === String(key);
    row.className = "folder-row" + (isSelected ? " selected" : "");
    row.dataset.key = String(key);
    if (depth > 0) row.style.paddingLeft = (8 + depth * 16) + "px";

    const iconSpan = document.createElement("span");
    iconSpan.className = "folder-icon" + (muted ? " muted" : "");
    iconSpan.innerHTML = icon;
    row.appendChild(iconSpan);

    const nameSpan = document.createElement("span");
    nameSpan.className = "folder-name";
    nameSpan.textContent = name;
    row.appendChild(nameSpan);

    if (count > 0) {
      const countSpan = document.createElement("span");
      countSpan.className = "folder-count";
      countSpan.textContent = count;
      row.appendChild(countSpan);
    }

    row.addEventListener("click", () => { if (!nameSpan.isContentEditable) selectFolder(key); });

    if (folder) {
      // Sub-folder button
      const addSubBtn = document.createElement("button");
      addSubBtn.className = "folder-add-sub icon-btn";
      addSubBtn.title = "Add subfolder";
      addSubBtn.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;
      addSubBtn.addEventListener("click", async e => {
        e.stopPropagation();
        const sub = await api("/api/folders", { method:"POST", body:JSON.stringify({ name:"New Folder", parent_id:folder.id }) });
        if (!sub) return;
        await loadSidebar();
        const newRow = [...document.querySelectorAll(".folder-row")].find(r => r.dataset.key === String(sub.id));
        if (newRow) startRenameFolder(newRow, newRow.querySelector(".folder-name"), sub);
      });
      row.appendChild(addSubBtn);
      row.addEventListener("dblclick", () => startRenameFolder(row, nameSpan, folder));
      row.addEventListener("contextmenu", e => { e.preventDefault(); showFolderContextMenu(e, folder, row, nameSpan); });
    }
    return row;
  }

  /* Tag filter chips in the note list filter row */
  function renderTagFilterChips() {
    // Remove old dynamic tag chips
    document.querySelectorAll(".filter-chip[data-tag]").forEach(c => c.remove());
    const row = el("filterRow");
    state.tags.forEach(tag => {
      const chip = document.createElement("button");
      chip.className = "filter-chip tag-filter-chip" + (state.currentTag === tag.name ? " active" : "");
      chip.dataset.tag = tag.name;
      chip.style.setProperty("--tag-color", tag.color);
      chip.innerHTML = `<span class="tag-dot" style="background:${tag.color}"></span>#${escapeHtml(tag.name)}`;
      chip.addEventListener("click", () => {
        if (state.currentTag === tag.name) {
          state.currentTag = null;
          chip.classList.remove("active");
          loadNotes();
        } else {
          state.currentTag = tag.name;
          document.querySelectorAll(".filter-chip").forEach(c => c.classList.remove("active"));
          chip.classList.add("active");
          state.filterMode = "all";
          loadNotes();
        }
      });
      row.appendChild(chip);
    });
  }

  /* ── Folder actions ── */
  function startRenameFolder(row, nameSpan, folder) {
    nameSpan.contentEditable = "true"; nameSpan.focus();
    document.execCommand("selectAll", false, null);
    function finish(save) {
      nameSpan.contentEditable = "false";
      const n = nameSpan.textContent.trim();
      if (save && n && n !== folder.name) {
        api(`/api/folders/${folder.id}`, { method:"PATCH", body:JSON.stringify({ name:n }) }).then(() => loadSidebar());
      } else { nameSpan.textContent = folder.name; }
      nameSpan.removeEventListener("blur", onBlur);
      nameSpan.removeEventListener("keydown", onKey);
    }
    const onBlur = () => finish(true);
    const onKey = e => {
      if (e.key === "Enter")  { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
    };
    nameSpan.addEventListener("blur", onBlur);
    nameSpan.addEventListener("keydown", onKey);
  }

  async function createFolder() {
    const folder = await api("/api/folders", { method:"POST", body:JSON.stringify({ name:"New Folder" }) });
    if (!folder) return;
    await loadSidebar();
    const row = [...document.querySelectorAll(".folder-row")].find(r => r.dataset.key === String(folder.id));
    if (row) startRenameFolder(row, row.querySelector(".folder-name"), folder);
  }

  function showFolderContextMenu(evt, folder, row, nameSpan) {
    openContextMenu(evt, [
      { label:"Rename Folder", action:() => startRenameFolder(row, nameSpan, folder) },
      { label:"Add Subfolder",  action:async () => {
          const sub = await api("/api/folders", { method:"POST", body:JSON.stringify({ name:"New Folder", parent_id:folder.id }) });
          if (!sub) return;
          await loadSidebar();
          const newRow = [...document.querySelectorAll(".folder-row")].find(r => r.dataset.key === String(sub.id));
          if (newRow) startRenameFolder(newRow, newRow.querySelector(".folder-name"), sub);
        }},
      { divider:true },
      { label:"Delete Folder", danger:true, action:() =>
          confirmDialog(`Delete "${folder.name}"? Notes move to Notes folder.`, async () => {
            await api(`/api/folders/${folder.id}`, { method:"DELETE" });
            if (String(state.currentFolder) === String(folder.id)) selectFolder("all");
            else loadSidebar();
          }) },
    ]);
  }

  function selectFolder(key) {
    state.currentFolder = key;
    state.currentTag    = null;
    state.searchQuery   = "";
    state.filterMode    = "all";
    state.dateFrom = state.dateTo = null;
    if (state.sortBy === "manual") state.sortBy = "updated";
    el("searchInput").value = "";
    el("clearSearch").classList.add("hidden");
    el("dateFilterRow").classList.add("hidden");
    document.querySelectorAll(".filter-chip").forEach(c => c.classList.toggle("active", c.dataset.filter === "all"));
    renderFolderList();
    deselectNote();
    const title = key === "all" ? "All Notes"
      : key === "trash" ? "Recently Deleted"
      : key === "favorites" ? "Favorites"
      : (state.folders.find(f => f.id === key) || {}).name || "Notes";
    el("currentFolderTitle").textContent = title;
    el("trashBanner").classList.toggle("hidden", key !== "trash");
    el("emptyTrashBtn").style.display = key === "trash" ? "block" : "none";
    setMobileView("view-list");
    loadNotes();
  }

  /* ════════════════════════════════════════
     NOTE LIST
  ════════════════════════════════════════ */
  async function loadNotes() {
    const params = new URLSearchParams({ folder: state.currentFolder });
    if (state.searchQuery) params.set("q", state.searchQuery);
    if (state.currentTag)  params.set("tag", state.currentTag);
    if (state.dateFrom)    params.set("date_from", state.dateFrom);
    if (state.dateTo)      params.set("date_to",   state.dateTo);
    if (state.currentFolder === "favorites") {
      params.set("folder", "all");
      params.set("favorite", "1");
    }
    const notes = await api(`/api/notes?${params.toString()}`);
    if (!notes) return;
    state.notes = notes;
    renderNoteList();
  }

  function renderNoteList() {
    const list = el("noteList"), grid = el("stickyGrid");
    list.innerHTML = ""; grid.innerHTML = "";
    const filtered = applyClientFilter(state.notes);
    el("noteListEmpty").classList.toggle("hidden", filtered.length > 0);
    const sticky = state.viewMode === "sticky", isTrash = state.currentFolder === "trash";
    list.classList.toggle("hidden", sticky);
    grid.classList.toggle("hidden", !sticky);
    if (sticky) {
      const pinned = sortNotes(filtered.filter(n => n.pinned));
      const rest   = sortNotes(filtered.filter(n => !n.pinned));
      (isTrash ? sortNotes(filtered) : [...pinned, ...rest]).forEach((n, i) => grid.appendChild(buildStickyCard(n, i, isTrash)));
      return;
    }
    if (isTrash) { sortNotes(filtered).forEach(n => list.appendChild(buildNoteRow(n, true))); return; }
    const pinned = sortNotes(filtered.filter(n => n.pinned));
    const rest   = sortNotes(filtered.filter(n => !n.pinned));
    if (pinned.length) {
      list.appendChild(sectionLabel("Pinned"));
      pinned.forEach(n => list.appendChild(buildNoteRow(n, false)));
      list.appendChild(sectionLabel(state.currentFolder === "all" ? "All Notes" : "Notes"));
    }
    rest.forEach(n => list.appendChild(buildNoteRow(n, false)));
  }

  function sectionLabel(text) {
    const d = document.createElement("div"); d.className = "note-list-section-label"; d.textContent = text; return d;
  }

  function buildNoteRow(note, isTrash) {
    const row = document.createElement("li");
    row.className = "note-row" + (note.id === state.currentNoteId ? " selected" : "");
    row.dataset.id = note.id;

    const top = document.createElement("div"); top.className = "row-top";
    const titleSpan = document.createElement("span"); titleSpan.className = "row-title";
    titleSpan.innerHTML = highlightMatch(note.title || "New Note", state.searchQuery);
    top.appendChild(titleSpan);
    if (note.pinned) { const p = document.createElement("span"); p.className = "pin-icon"; p.innerHTML = ICONS.pinFilled; top.appendChild(p); }
    if (note.is_favorite) { const s = document.createElement("span"); s.className = "fav-icon"; s.innerHTML = ICONS.starFilled; top.appendChild(s); }
    row.appendChild(top);

    // Tags
    if (note.tags && note.tags.length) {
      const tagRow = document.createElement("div"); tagRow.className = "row-tags";
      note.tags.forEach(t => {
        const chip = document.createElement("span"); chip.className = "row-tag-chip";
        chip.style.background = t.color + "28"; chip.style.color = t.color;
        chip.textContent = "#" + t.name; tagRow.appendChild(chip);
      });
      row.appendChild(tagRow);
    }

    const meta = document.createElement("div"); meta.className = "row-meta";
    const dateSpan = document.createElement("span"); dateSpan.className = "row-date"; dateSpan.textContent = formatListDate(note.updated_at); meta.appendChild(dateSpan);
    const preview = (note.plain_text || note.snippet || "").slice(0, 200);
    const snippetSpan = document.createElement("span"); snippetSpan.className = "row-snippet";
    snippetSpan.innerHTML = highlightMatch(preview, state.searchQuery); meta.appendChild(snippetSpan);
    row.appendChild(meta);

    if (isTrash) {
      const actions = document.createElement("div"); actions.className = "row-actions"; actions.style.display = "flex";
      const rec = document.createElement("button"); rec.textContent = "Recover"; rec.onclick = e => { e.stopPropagation(); recoverNote(note.id); };
      const del = document.createElement("button"); del.textContent = "Delete"; del.className = "danger";
      del.onclick = e => { e.stopPropagation(); confirmDialog("Delete permanently?", () => permanentlyDeleteNote(note.id)); };
      actions.appendChild(rec); actions.appendChild(del); row.appendChild(actions);
    }

    row.addEventListener("click", () => selectNote(note.id));
    row.addEventListener("contextmenu", e => { e.preventDefault(); isTrash ? openTrashMenu(e, note) : openNoteContextMenu(e, note); });
    if (!isTrash) attachListDrag(row, note);
    return row;
  }

  function buildStickyCard(note, index, isTrash) {
    const card = document.createElement("div");
    card.className = "sticky-card" + (note.id === state.currentNoteId ? " selected" : "");
    const colorIdx = ((note.id || index + 1) * 3 + 1) % 7;
    const rotations = [-2, -1, 0, 1, 2, -1.5, 1.5];
    card.dataset.color = String(colorIdx);
    card.style.setProperty("--rot", rotations[(note.id || index) % rotations.length] + "deg");
    card.dataset.id = note.id;

    if (note.pinned) { const p = document.createElement("span"); p.className = "sticky-pin"; p.innerHTML = ICONS.pinFilled; card.appendChild(p); }
    if (note.is_favorite) { const s = document.createElement("span"); s.className = "sticky-star"; s.innerHTML = ICONS.starFilled; card.appendChild(s); }

    const titleEl = document.createElement("div"); titleEl.className = "sticky-title";
    titleEl.innerHTML = highlightMatch(note.title || "New Note", state.searchQuery); card.appendChild(titleEl);

    const previewText = (note.plain_text || note.snippet || note.title || "").slice(0, 300);
    const snippetEl = document.createElement("div"); snippetEl.className = "sticky-snippet";
    snippetEl.innerHTML = highlightMatch(previewText, state.searchQuery); card.appendChild(snippetEl);

    if (note.tags && note.tags.length) {
      const tagRow = document.createElement("div"); tagRow.className = "sticky-tags";
      note.tags.slice(0, 3).forEach(t => {
        const chip = document.createElement("span"); chip.className = "row-tag-chip";
        chip.style.background = t.color + "28"; chip.style.color = t.color;
        chip.textContent = "#" + t.name; tagRow.appendChild(chip);
      }); card.appendChild(tagRow);
    }

    const meta = document.createElement("div"); meta.className = "sticky-meta";
    meta.innerHTML = `<span>${escapeHtml(formatListDate(note.updated_at))}</span>`; card.appendChild(meta);

    if (isTrash) {
      const actions = document.createElement("div"); actions.className = "sticky-actions";
      const rec = document.createElement("button"); rec.textContent = "Recover"; rec.onclick = e => { e.stopPropagation(); recoverNote(note.id); };
      const del = document.createElement("button"); del.textContent = "Delete"; del.className = "danger";
      del.onclick = e => { e.stopPropagation(); confirmDialog("Delete permanently?", () => permanentlyDeleteNote(note.id)); };
      actions.appendChild(rec); actions.appendChild(del); card.appendChild(actions);
    }

    card.addEventListener("click", () => selectNote(note.id));
    card.addEventListener("contextmenu", e => { e.preventDefault(); isTrash ? openTrashMenu(e, note) : openNoteContextMenu(e, note); });
    if (!isTrash) attachStickyDrag(card, note);
    return card;
  }

  function openTrashMenu(evt, note) {
    openContextMenu(evt, [
      { label:"Recover Note", action:() => recoverNote(note.id) },
      { label:"Delete Immediately", danger:true, action:() => confirmDialog("Delete permanently? Can't be undone.", () => permanentlyDeleteNote(note.id)) },
    ]);
  }

  function openNoteContextMenu(evt, note) {
    openContextMenu(evt, [
      { label:note.pinned ? "Unpin Note" : "Pin Note", action:() => togglePin(note.id) },
      { label:note.is_favorite ? "Remove from Favorites" : "Add to Favorites", action:() => toggleFavorite(note.id) },
      { label:"Move to…", submenu: state.folders.map(f => ({ label:f.name + (f.id === note.folder_id ? "  ✓" : ""), action:() => moveNote(note.id, f.id) })) },
      { divider:true },
      { label:"Delete", danger:true, action:() => confirmDialog("Delete this note? It will move to Recently Deleted.", () => deleteNote(note.id)) },
    ]);
  }

  function updateNoteInList(updated) {
    const idx = state.notes.findIndex(n => n.id === updated.id);
    if (idx >= 0) state.notes[idx] = Object.assign({}, state.notes[idx], updated);
    else state.notes.unshift(updated);
    renderNoteList();
  }

  function removeNoteFromList(id) {
    state.notes = state.notes.filter(n => n.id !== id);
    renderNoteList();
  }

  /* ════════════════════════════════════════
     DRAG & DROP
  ════════════════════════════════════════ */
  const ghost = el("dragGhost");
  function showGhost(t, x, y) { ghost.textContent = t; ghost.style.left = x+"px"; ghost.style.top = y+"px"; ghost.classList.add("visible"); }
  function moveGhost(x, y) { ghost.style.left = x+"px"; ghost.style.top = y+"px"; }
  function hideGhost() { ghost.classList.remove("visible"); }

  function startDrag(note, sourceEl, e) {
    state.drag = { active:true, noteId:note.id, noteTitle:note.title||"Note", sourceEl };
    sourceEl.classList.add("dragging");
    showGhost(note.title||"Note", e.clientX, e.clientY);
    document.body.style.userSelect = "none";
  }

  function endDrag() {
    if (!state.drag.active) return;
    if (state.drag.sourceEl) state.drag.sourceEl.classList.remove("dragging");
    hideGhost(); document.body.style.userSelect = "";
    clearFolderHighlights();
    document.querySelectorAll(".drop-above,.drop-below,.drop-target").forEach(n => n.classList.remove("drop-above","drop-below","drop-target"));
    state.drag = { active:false, noteId:null, noteTitle:"", sourceEl:null };
  }

  function elementBelowDrag(x, y) {
    const src = state.drag.sourceEl;
    if (src) src.style.pointerEvents = "none";
    const found = document.elementFromPoint(x, y);
    if (src) src.style.pointerEvents = "";
    return found;
  }

  function getFolderAtPoint(x, y) {
    let match = null;
    document.querySelectorAll(".folder-row").forEach(row => {
      const r = row.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) match = { el:row, key:row.dataset.key };
    });
    return match;
  }

  function clearFolderHighlights() {
    document.querySelectorAll(".folder-row").forEach(r => r.classList.remove("folder-drop-target","folder-drop-deny"));
  }

  function highlightFolderAt(x, y) {
    clearFolderHighlights();
    const hit = getFolderAtPoint(x, y);
    if (!hit) return null;
    const valid = hit.key !== "trash" && hit.key !== "all" && hit.key !== "favorites";
    hit.el.classList.add(valid ? "folder-drop-target" : "folder-drop-deny");
    return hit;
  }

  function attachListDrag(row, note) {
    row.addEventListener("mousedown", e => {
      if (e.button !== 0 || e.target.closest("button,input")) return;
      let started = false;
      const onMove = ev => {
        if (!started && (Math.abs(ev.clientX-e.clientX)>3||Math.abs(ev.clientY-e.clientY)>3)) { started=true; startDrag(note,row,ev); }
        if (!started) return;
        moveGhost(ev.clientX,ev.clientY);
        document.querySelectorAll(".note-row.drop-above,.note-row.drop-below").forEach(r=>r.classList.remove("drop-above","drop-below"));
        clearFolderHighlights();
        const fh = highlightFolderAt(ev.clientX,ev.clientY);
        if (fh) return;
        const target = elementBelowDrag(ev.clientX,ev.clientY);
        const nr = target && target.closest(".note-row");
        if (nr && nr !== row) { const rect=nr.getBoundingClientRect(); nr.classList.add(ev.clientY<rect.top+rect.height/2?"drop-above":"drop-below"); }
      };
      const onUp = async ev => {
        document.removeEventListener("mousemove",onMove); document.removeEventListener("mouseup",onUp);
        if (!started||!state.drag.active) { endDrag(); return; }
        const cx=ev.clientX, cy=ev.clientY;
        const fh = getFolderAtPoint(cx,cy);
        if (fh) {
          const key=fh.key;
          if (key!=="trash"&&key!=="all"&&key!=="favorites") {
            const fid=Number(key), folder=state.folders.find(f=>f.id===fid);
            if (folder) { const did=state.drag.noteId; endDrag(); await moveNote(did,fid); showToast(`Moved to "${folder.name}"`); return; }
          }
          endDrag(); return;
        }
        const target=elementBelowDrag(cx,cy), dropRow=target&&target.closest(".note-row");
        if (dropRow&&Number(dropRow.dataset.id)!==note.id) {
          const rect=dropRow.getBoundingClientRect(), ib=cy<rect.top+rect.height/2, did=state.drag.noteId;
          endDrag(); await reorderInList(did,Number(dropRow.dataset.id),ib); return;
        }
        endDrag();
      };
      document.addEventListener("mousemove",onMove); document.addEventListener("mouseup",onUp);
    });
  }

  function attachStickyDrag(card, note) {
    card.addEventListener("mousedown", e => {
      if (e.button!==0||e.target.closest("button")) return;
      let started = false;
      const onMove = ev => {
        if (!started&&(Math.abs(ev.clientX-e.clientX)>3||Math.abs(ev.clientY-e.clientY)>3)) { started=true; startDrag(note,card,ev); }
        if (!started) return;
        moveGhost(ev.clientX,ev.clientY);
        document.querySelectorAll(".sticky-card.drop-target").forEach(c=>c.classList.remove("drop-target"));
        clearFolderHighlights();
        const fh=highlightFolderAt(ev.clientX,ev.clientY); if (fh) return;
        const t=elementBelowDrag(ev.clientX,ev.clientY), dc=t&&t.closest(".sticky-card");
        if (dc&&dc!==card) dc.classList.add("drop-target");
      };
      const onUp = async ev => {
        document.removeEventListener("mousemove",onMove); document.removeEventListener("mouseup",onUp);
        if (!started||!state.drag.active) { endDrag(); return; }
        const cx=ev.clientX,cy=ev.clientY;
        const fh=getFolderAtPoint(cx,cy);
        if (fh) {
          const key=fh.key;
          if (key!=="trash"&&key!=="all"&&key!=="favorites") {
            const fid=Number(key),folder=state.folders.find(f=>f.id===fid);
            if (folder) { const did=state.drag.noteId; endDrag(); await moveNote(did,fid); showToast(`Moved to "${folder.name}"`); return; }
          }
          endDrag(); return;
        }
        const t=elementBelowDrag(cx,cy),dc=t&&t.closest(".sticky-card");
        if (dc&&Number(dc.dataset.id)!==note.id) { const did=state.drag.noteId; endDrag(); await reorderInGrid(did,Number(dc.dataset.id)); return; }
        endDrag();
      };
      document.addEventListener("mousemove",onMove); document.addEventListener("mouseup",onUp);
    });
  }

  async function reorderInList(dragId, targetId, insertBefore) {
    const list=el("noteList"), rows=[...list.querySelectorAll(".note-row")];
    const src=rows.find(r=>Number(r.dataset.id)===dragId), tgt=rows.find(r=>Number(r.dataset.id)===targetId);
    if (!src||!tgt||src===tgt) return;
    list.insertBefore(src, insertBefore ? tgt : tgt.nextSibling);
    state.sortBy="manual"; el("sortLabel").textContent="Manual";
    const ids=[...list.querySelectorAll(".note-row")].map(r=>Number(r.dataset.id));
    ids.forEach((id,i)=>{ const n=state.notes.find(n=>n.id===id); if(n) n.sort_order=i; });
    state.notes.sort((a,b)=>a.sort_order-b.sort_order);
    await api("/api/notes/reorder",{ method:"POST", body:JSON.stringify({ ordered_ids:ids }) });
  }

  async function reorderInGrid(dragId, targetId) {
    const grid=el("stickyGrid"), cards=[...grid.querySelectorAll(".sticky-card")];
    const src=cards.find(c=>Number(c.dataset.id)===dragId), tgt=cards.find(c=>Number(c.dataset.id)===targetId);
    if (!src||!tgt||src===tgt) return;
    grid.insertBefore(src, tgt);
    state.sortBy="manual"; el("sortLabel").textContent="Manual";
    const ids=[...grid.querySelectorAll(".sticky-card")].map(c=>Number(c.dataset.id));
    ids.forEach((id,i)=>{ const n=state.notes.find(n=>n.id===id); if(n) n.sort_order=i; });
    state.notes.sort((a,b)=>a.sort_order-b.sort_order);
    await api("/api/notes/reorder",{ method:"POST", body:JSON.stringify({ ordered_ids:ids }) });
  }

  /* ════════════════════════════════════════
     EDITOR
  ════════════════════════════════════════ */
  function initQuill() {
    state.quill = new Quill("#quillEditor", {
      theme:"snow", placeholder:"Start writing…",
      modules:{ toolbar:{ container:"#quillToolbar" } },
    });
    el("checklistBtn").innerHTML = ICONS.checklist;
    initQuillListener();
  }

  function initQuillListener() {
    state.quill.off("text-change");
    state.quill.on("text-change", (d, o, source) => {
      if (source !== "user") return;
      state.dirty = true; setSaveStatus("Editing…"); updateWordCount();
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(saveCurrentNote, 1500);
    });
  }

  function setSaveStatus(text) {
    const s = el("saveStatus"); s.style.opacity="1"; s.textContent=text;
    if (text==="Saved") { clearTimeout(s._f); s._f=setTimeout(()=>{ s.style.opacity="0"; },1400); }
  }

  function updateWordCount() {
    const t=state.quill.getText().trim(), w=t?t.split(/\s+/).length:0;
    el("wordCount").textContent = w ? `${w} word${w===1?"":"s"}` : "";
  }

  async function selectNote(id) {
    if (state.currentNoteId===id) return;
    await flushPendingSave();
    state.currentNoteId=id; state.currentNoteDeleted=state.currentFolder==="trash";
    [...document.querySelectorAll(".note-row")].forEach(r=>r.classList.toggle("selected",Number(r.dataset.id)===id));
    [...document.querySelectorAll(".sticky-card")].forEach(c=>c.classList.toggle("selected",Number(c.dataset.id)===id));

    const note = await api(`/api/notes/${id}`);
    if (!note) return;
    el("editorEmpty").classList.add("hidden");
    el("editorContent").classList.remove("hidden");
    el("trashedBanner").classList.toggle("hidden", !note.is_deleted);
    el("noteTitleInput").value=(note.title&&note.title!=="New Note")?note.title:"";
    el("noteTitleInput").disabled=note.is_deleted;

    state.quill.off("text-change");
    state.quill.setContents(state.quill.clipboard.convert(note.content||""), "silent");
    state.quill.history.clear();
    state.quill.enable(!note.is_deleted);
    initQuillListener();
    updateWordCount(); setSaveStatus("");
    document.title=(note.title||"Notes")+" — Notes";
    updatePinUI(note.pinned);
    updateFavUI(note.is_favorite);
    renderNoteTagBar(note);
    setMobileView("view-editor");
  }

  function updatePinUI(pinned) {
    el("taskbarPinBtn").classList.toggle("active-pin",!!pinned);
    el("taskbarPinLabel").textContent=pinned?"Unpin":"Pin";
  }

  function updateFavUI(fav) {
    el("taskbarFavBtn").classList.toggle("active-fav",!!fav);
    el("taskbarFavLabel").textContent=fav?"Unstar":"Star";
  }

  /* ── Tag bar in editor ── */
  function renderNoteTagBar(note) {
    const chips = el("tagChips");
    chips.innerHTML = "";
    (note.tags || []).forEach(t => {
      const chip = document.createElement("span");
      chip.className = "tag-chip-editor";
      chip.style.background = t.color+"22"; chip.style.color = t.color;
      chip.innerHTML = `#${escapeHtml(t.name)} <button class="tag-chip-remove" data-tag-id="${t.id}" title="Remove tag">×</button>`;
      chip.querySelector(".tag-chip-remove").addEventListener("click", async () => {
        if (!state.currentNoteId) return;
        const currentNote = state.notes.find(n=>n.id===state.currentNoteId);
        const newTagIds = (currentNote?.tags||[]).filter(tt=>tt.id!==t.id).map(tt=>tt.id);
        const updated = await api(`/api/notes/${state.currentNoteId}`, { method:"PUT", body:JSON.stringify({ tag_ids:newTagIds }) });
        if (updated) { updateNoteInList(updated); renderNoteTagBar(updated); loadSidebar(); }
      });
      chips.appendChild(chip);
    });
  }

  function initTagInput() {
    const input = el("tagInput"), suggestions = el("tagSuggestions");
    input.addEventListener("input", () => {
      const val = input.value.replace(/^#/, "").toLowerCase().trim();
      if (!val) { suggestions.classList.add("hidden"); return; }
      const matches = state.tags.filter(t => t.name.startsWith(val)).slice(0, 6);
      if (!matches.length) { suggestions.classList.add("hidden"); return; }
      suggestions.innerHTML = "";
      matches.forEach(t => {
        const item = document.createElement("div"); item.className = "tag-suggestion-item";
        item.style.color = t.color; item.textContent = "#"+t.name;
        item.addEventListener("mousedown", async e => {
          e.preventDefault();
          await applyTagToNote(t);
          input.value = ""; suggestions.classList.add("hidden");
        });
        suggestions.appendChild(item);
      });
      suggestions.classList.remove("hidden");
    });
    input.addEventListener("keydown", async e => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        const name = input.value.replace(/^#/, "").toLowerCase().trim().replace(/,/g,"");
        if (!name) return;
        let tag = state.tags.find(t => t.name===name);
        if (!tag) {
          const colors = ["#3a6b32","#8b6914","#1a5c8c","#8c2a1a","#5a3a8c","#2a6b5c"];
          const color = colors[state.tags.length % colors.length];
          tag = await api("/api/tags", { method:"POST", body:JSON.stringify({ name, color }) });
          if (!tag) return;
          state.tags.push(tag);
        }
        await applyTagToNote(tag);
        input.value=""; suggestions.classList.add("hidden");
      }
      if (e.key==="Escape") { suggestions.classList.add("hidden"); }
    });
    document.addEventListener("click", e => {
      if (!suggestions.contains(e.target) && e.target!==input) suggestions.classList.add("hidden");
    });
  }

  async function applyTagToNote(tag) {
    if (!state.currentNoteId) return;
    const currentNote = state.notes.find(n=>n.id===state.currentNoteId);
    const existing = currentNote?.tags||[];
    if (existing.find(t=>t.id===tag.id)) return;
    const newTagIds = [...existing.map(t=>t.id), tag.id];
    const updated = await api(`/api/notes/${state.currentNoteId}`, { method:"PUT", body:JSON.stringify({ tag_ids:newTagIds }) });
    if (updated) { updateNoteInList(updated); renderNoteTagBar(updated); loadSidebar(); }
  }

  function deselectNote() {
    state.currentNoteId=null;
    el("editorEmpty").classList.remove("hidden");
    el("editorContent").classList.add("hidden");
    el("noteTitleInput").value="";
    el("tagChips").innerHTML="";
    document.title="Notes"; updatePinUI(false); updateFavUI(false);
  }

  async function flushPendingSave() {
    clearTimeout(state.saveTimer); clearTimeout(state.titleSaveTimer);
    if ((state.dirty||state.titleDirty)&&state.currentNoteId) await saveCurrentNote();
  }

  async function saveCurrentNote() {
    if (!state.currentNoteId||(!state.dirty&&!state.titleDirty)) return;
    const id=state.currentNoteId, content=state.quill.root.innerHTML;
    const titleVal=el("noteTitleInput").value.trim();
    state.dirty=false; state.titleDirty=false;
    try {
      let updated=await api(`/api/notes/${id}`,{ method:"PUT", body:JSON.stringify({ content }) });
      if (!updated) return;
      if (titleVal) { updated=await api(`/api/notes/${id}`,{ method:"PUT", body:JSON.stringify({ content, _title_override:titleVal }) }); if (!updated) return; }
      updateNoteInList(updated);
      [...document.querySelectorAll(".note-row")].forEach(r=>r.classList.toggle("selected",Number(r.dataset.id)===id));
      document.title=(updated.title||"Notes")+" — Notes";
      renderNoteTagBar(updated);
      setSaveStatus("Saved"); loadSidebar();
    } catch(_) { setSaveStatus("Couldn't save"); }
  }

  async function createNewNote() {
    let folderId=null;
    if (typeof state.currentFolder==="number") folderId=state.currentFolder;
    const note=await api("/api/notes",{ method:"POST", body:JSON.stringify({ folder_id:folderId }) });
    if (!note) return;
    if (state.currentFolder==="trash") { selectFolder("all"); return; }
    state.notes.unshift(note); renderNoteList();
    await selectNote(note.id); el("noteTitleInput").focus(); loadSidebar();
  }

  async function togglePin(id) {
    const u=await api(`/api/notes/${id}/pin`,{ method:"POST" }); if (!u) return;
    updateNoteInList(u); if (id===state.currentNoteId) updatePinUI(u.pinned);
  }

  async function toggleFavorite(id) {
    const u=await api(`/api/notes/${id}/favorite`,{ method:"POST" }); if (!u) return;
    updateNoteInList(u); if (id===state.currentNoteId) updateFavUI(u.is_favorite);
    loadSidebar();
  }

  async function moveNote(id, folderId) {
    const u=await api(`/api/notes/${id}/move`,{ method:"POST", body:JSON.stringify({ folder_id:folderId }) });
    if (!u) return;
    if (typeof state.currentFolder==="number"&&state.currentFolder!==folderId) {
      removeNoteFromList(id); if (id===state.currentNoteId) deselectNote();
    } else { updateNoteInList(u); }
    loadSidebar();
  }

  async function deleteNote(id) { await api(`/api/notes/${id}`,{ method:"DELETE" }); removeNoteFromList(id); if (id===state.currentNoteId) deselectNote(); loadSidebar(); }
  async function recoverNote(id) { await api(`/api/notes/${id}/restore`,{ method:"POST" }); removeNoteFromList(id); if (id===state.currentNoteId) deselectNote(); loadSidebar(); }
  async function permanentlyDeleteNote(id) { await api(`/api/notes/${id}`,{ method:"DELETE" }); removeNoteFromList(id); if (id===state.currentNoteId) deselectNote(); loadSidebar(); }
  async function emptyTrash() { await api("/api/trash/empty",{ method:"POST" }); state.notes=[]; renderNoteList(); if (state.currentNoteDeleted) deselectNote(); loadSidebar(); }

  /* ════════════════════════════════════════
     SHARE MODAL
  ════════════════════════════════════════ */
  function openShareModal() {
    if (!state.currentNoteId) return;
    const note=state.notes.find(n=>n.id===state.currentNoteId);
    el("shareMsg").textContent=""; el("shareMsg").className="modal-msg";
    if (note?.share_token) {
      el("shareUrlInput").value=window.location.origin+"/share/"+note.share_token;
    } else {
      el("shareUrlInput").value="";
    }
    el("shareModal").classList.remove("hidden");
  }

  async function generateShareLink() {
    if (!state.currentNoteId) return;
    const expiry=el("shareExpiry").value;
    const data=await api(`/api/notes/${state.currentNoteId}/share`,{ method:"POST", body:JSON.stringify({ expiry_hours:expiry||null }) });
    if (!data) return;
    const url=window.location.origin+data.url;
    el("shareUrlInput").value=url;
    const n=state.notes.find(n=>n.id===state.currentNoteId);
    if (n) n.share_token=data.token;
    el("shareMsg").textContent="Link generated!"; el("shareMsg").className="modal-msg ok";
  }

  async function revokeShareLink() {
    if (!state.currentNoteId) return;
    await api(`/api/notes/${state.currentNoteId}/share`,{ method:"DELETE" });
    el("shareUrlInput").value="";
    const n=state.notes.find(n=>n.id===state.currentNoteId);
    if (n) n.share_token=null;
    el("shareMsg").textContent="Link revoked."; el("shareMsg").className="modal-msg";
  }

  /* ════════════════════════════════════════
     EXPORT / IMPORT
  ════════════════════════════════════════ */
  function exportCsv() {
    const url=`/api/export/csv?folder=${encodeURIComponent(state.currentFolder)}`;
    const a=document.createElement("a"); a.href=url; a.download="notes_export.csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    showToast("Exported as CSV ✓");
  }

  function exportPdf() {
    if (!state.currentNoteId) { showToast("Select a note first"); return; }
    window.open(`/api/notes/${state.currentNoteId}/export/pdf`, "_blank");
  }

  async function doImport() {
    const file=el("importFile").files[0];
    if (!file) { el("importMsg").textContent="Please choose a CSV file."; el("importMsg").className="modal-msg err"; return; }
    const formData=new FormData(); formData.append("file",file);
    el("doImportBtn").disabled=true;
    try {
      const res=await fetch("/api/import/csv",{ method:"POST", body:formData });
      const data=await res.json();
      if (res.ok) {
        el("importMsg").textContent=`Imported ${data.created} note${data.created!==1?"s":""}, skipped ${data.skipped}.`;
        el("importMsg").className="modal-msg ok";
        loadNotes(); loadSidebar();
      } else {
        el("importMsg").textContent=data.error||"Import failed."; el("importMsg").className="modal-msg err";
      }
    } catch(_) { el("importMsg").textContent="Network error."; el("importMsg").className="modal-msg err"; }
    finally { el("doImportBtn").disabled=false; }
  }

  /* ════════════════════════════════════════
     CONTEXT MENU
  ════════════════════════════════════════ */
  function openContextMenu(evt, items) {
    const menu=el("contextMenu"); menu.innerHTML="";
    items.forEach(item => {
      if (item.divider) { const d=document.createElement("div"); d.className="menu-divider"; menu.appendChild(d); return; }
      const row=document.createElement("div"); row.className="menu-item"+(item.danger?" danger":"");
      row.textContent=item.label;
      if (item.submenu) {
        row.classList.add("menu-submenu-label");
        const sub=document.createElement("div"); sub.className="submenu hidden";
        item.submenu.forEach(s => {
          const sr=document.createElement("div"); sr.className="menu-item"; sr.textContent=s.label;
          sr.onclick=e2=>{ e2.stopPropagation(); closeContextMenu(); s.action(); }; sub.appendChild(sr);
        });
        row.appendChild(sub);
        row.addEventListener("mouseenter",()=>sub.classList.remove("hidden"));
        row.addEventListener("mouseleave",()=>sub.classList.add("hidden"));
      } else { row.onclick=e2=>{ e2.stopPropagation(); closeContextMenu(); item.action(); }; }
      menu.appendChild(row);
    });
    menu.classList.remove("hidden"); el("overlay").classList.remove("hidden");
    const x=Math.min(evt.clientX,window.innerWidth-220), y=Math.min(evt.clientY,window.innerHeight-menu.offsetHeight-20);
    menu.style.left=x+"px"; menu.style.top=y+"px";
  }

  function closeContextMenu() {
    el("contextMenu").classList.add("hidden");
    el("overlay").classList.add("hidden");
    el("settingsPanel").classList.add("hidden");
    el("exportDropdown").classList.add("hidden");
  }

  function confirmDialog(message, onConfirm) {
    el("confirmMessage").textContent=message;
    el("confirmDialog").classList.remove("hidden"); el("overlay").classList.remove("hidden");
    function cleanup() {
      el("confirmDialog").classList.add("hidden"); el("overlay").classList.add("hidden");
      el("confirmOk").removeEventListener("click",onOk); el("confirmCancel").removeEventListener("click",onCancel);
    }
    const onOk=()=>{ cleanup(); onConfirm(); }, onCancel=()=>cleanup();
    el("confirmOk").addEventListener("click",onOk); el("confirmCancel").addEventListener("click",onCancel);
  }

  function applyEditorSettings() {
    document.documentElement.style.setProperty("--editor-font-size", el("fontSizeSlider").value+"px");
    document.documentElement.style.setProperty("--editor-line-height", el("lineSpacingSlider").value);
  }

  function setMobileView(view) {
    document.getElementById("app").className=view+(state.viewMode==="sticky"?" sticky-mode":"");
  }

  /* ════════════════════════════════════════
     BIND UI
  ════════════════════════════════════════ */
  function bindUI() {
    el("newFolderBtn").addEventListener("click", createFolder);
    el("collapseSidebar").addEventListener("click", () => collapseSidebar());
    el("sidebarTab").addEventListener("click", () => collapseSidebar(false));

    // Folder settings panel
    el("sidebarSettingsBtn").addEventListener("click", e => {
      e.stopPropagation();
      el("folderSettingsPanel").classList.toggle("hidden");
      if (!el("folderSettingsPanel").classList.contains("hidden")) renderFolderSettingsTags();
    });
    el("closeFolderSettings").addEventListener("click", () => {
      el("folderSettingsPanel").classList.add("hidden");
    });

    // Show note count toggle
    el("fsShowCount").addEventListener("change", () => {
      document.querySelectorAll(".folder-count").forEach(c => {
        c.style.display = el("fsShowCount").checked ? "" : "none";
      });
    });

    // Default sort order — apply immediately when changed
    el("fsDefaultSort").addEventListener("change", () => {
      const val = el("fsDefaultSort").value;
      state.sortBy = val;
      el("sortLabel").textContent = { updated:"Date Edited", created:"Date Created", title:"Title" }[val] || "Date Edited";
      renderNoteList();
    });
    el("collapseNoteList").addEventListener("click",()=>collapseNoteList());
    el("noteListTab").addEventListener("click",()=>collapseNoteList(false));
    el("backToFolders").addEventListener("click",()=>setMobileView("view-folders"));
    el("backToList").addEventListener("click",()=>setMobileView("view-list"));

    el("taskbarNewNote").addEventListener("click",createNewNote);
    el("taskbarPinBtn").addEventListener("click",()=>{ if(state.currentNoteId) togglePin(state.currentNoteId); });
    el("taskbarFavBtn").addEventListener("click",()=>{ if(state.currentNoteId) toggleFavorite(state.currentNoteId); });
    el("taskbarMoveBtn").addEventListener("click",e=>{
      if (!state.currentNoteId) return;
      const note=state.notes.find(n=>n.id===state.currentNoteId)||{};
      openContextMenu(e, state.folders.map(f=>({ label:f.name+(f.id===note.folder_id?"  ✓":""), action:()=>moveNote(state.currentNoteId,f.id) })));
    });
    el("taskbarShareBtn").addEventListener("click",openShareModal);
    el("taskbarDeleteBtn").addEventListener("click",()=>{
      if (!state.currentNoteId) return;
      confirmDialog("Delete this note? It will move to Recently Deleted.",()=>deleteNote(state.currentNoteId));
    });

    // Export group — toggle dropdown, stopPropagation prevents immediate close
    el("exportGroup").addEventListener("click", e => {
      e.stopPropagation();
      el("exportDropdown").classList.toggle("hidden");
    });
    el("exportCsvBtn").addEventListener("click", e => {
      e.stopPropagation();
      el("exportDropdown").classList.add("hidden");
      exportCsv();
    });
    el("exportPdfBtn").addEventListener("click", e => {
      e.stopPropagation();
      el("exportDropdown").classList.add("hidden");
      exportPdf();
    });
    el("importCsvBtn").addEventListener("click", e => {
      e.stopPropagation();
      el("exportDropdown").classList.add("hidden");
      el("importMsg").textContent = ""; el("importMsg").className = "modal-msg";
      el("importFile").value = "";
      el("importModal").classList.remove("hidden");
    });
    el("doImportBtn").addEventListener("click",doImport);

    // Share modal
    el("generateShareBtn").addEventListener("click",generateShareLink);
    el("revokeShareBtn").addEventListener("click",revokeShareLink);
    el("copyShareUrl").addEventListener("click",()=>{
      const url=el("shareUrlInput").value;
      if (!url) return;
      navigator.clipboard.writeText(url).then(()=>showToast("Link copied!"));
    });

    el("settingsBtn").addEventListener("click",e=>{ e.stopPropagation(); el("settingsPanel").classList.toggle("hidden"); });
    el("closeSettings").addEventListener("click",()=>el("settingsPanel").classList.add("hidden"));
    el("logoutBtn").addEventListener("click",async()=>{
      try{ await fetch("/api/auth/logout",{ method:"POST", headers:{"Content-Type":"application/json"} }); } finally{ window.location.href="/"; }
    });
    el("fontSizeSlider").addEventListener("input",applyEditorSettings);
    el("lineSpacingSlider").addEventListener("input",applyEditorSettings);
    document.querySelectorAll(".settings-chip").forEach(chip=>{
      chip.addEventListener("click",()=>{
        document.querySelectorAll(".settings-chip").forEach(c=>c.classList.remove("active"));
        chip.classList.add("active");
        document.documentElement.style.setProperty("--editor-max-width",chip.dataset.width+"px");
      });
    });

    el("emptyTrashBtn").addEventListener("click",()=>confirmDialog("Empty Recently Deleted? Notes will be permanently deleted.",emptyTrash));
    el("recoverBtn").addEventListener("click",()=>{ if(state.currentNoteId) recoverNote(state.currentNoteId); });
    el("noteTitleInput").addEventListener("input",()=>{
      state.titleDirty=true; setSaveStatus("Editing…");
      clearTimeout(state.titleSaveTimer);
      state.titleSaveTimer=setTimeout(saveCurrentNote,1500);
    });
    el("noteTitleInput").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); state.quill.focus(); } });
    el("createFirstNote").addEventListener("click",createNewNote);

    // Search
    let searchTimer=null;
    el("searchInput").addEventListener("input",e=>{
      state.searchQuery=e.target.value;
      el("clearSearch").classList.toggle("hidden",!state.searchQuery);
      clearTimeout(searchTimer); searchTimer=setTimeout(loadNotes,250);
    });
    el("clearSearch").addEventListener("click",()=>{
      el("searchInput").value=""; state.searchQuery="";
      el("clearSearch").classList.add("hidden"); loadNotes();
    });

    // Filter chips
    document.querySelectorAll(".filter-chip[data-filter]").forEach(chip=>{
      chip.addEventListener("click",()=>{
        state.filterMode=chip.dataset.filter; state.currentTag=null;
        document.querySelectorAll(".filter-chip").forEach(c=>c.classList.remove("active"));
        chip.classList.add("active"); renderNoteList();
      });
    });

    // Date filter
    el("dateFilterToggle").addEventListener("click",()=>{
      el("dateFilterRow").classList.toggle("hidden");
    });
    el("applyDateFilter").addEventListener("click",()=>{
      state.dateFrom=el("dateFrom").value||null;
      state.dateTo=el("dateTo").value||null;
      loadNotes();
    });
    el("clearDateFilter").addEventListener("click",()=>{
      state.dateFrom=state.dateTo=null;
      el("dateFrom").value=""; el("dateTo").value="";
      loadNotes();
    });

    // Sort
    el("sortBtn").addEventListener("click",e=>{ e.stopPropagation(); el("sortMenu").classList.toggle("hidden"); });
    document.querySelectorAll(".sort-option").forEach(opt=>{
      opt.addEventListener("click",()=>{
        state.sortBy=opt.dataset.sort; el("sortLabel").textContent=opt.textContent;
        el("sortMenu").classList.add("hidden"); renderNoteList();
      });
    });

    // View toggle
    document.querySelectorAll(".view-toggle-btn").forEach(btn=>{
      btn.addEventListener("click",()=>{
        const mode=btn.dataset.view; if(mode===state.viewMode) return;
        state.viewMode=mode;
        document.querySelectorAll(".view-toggle-btn").forEach(b=>b.classList.toggle("active",b.dataset.view===mode));
        document.getElementById("app").classList.toggle("sticky-mode",mode==="sticky");
        renderNoteList();
      });
    });

    el("overlay").addEventListener("click",closeContextMenu);
    document.addEventListener("click",e=>{
      if (!el("sortMenu").contains(e.target)&&e.target!==el("sortBtn")) el("sortMenu").classList.add("hidden");
      if (!el("settingsPanel").contains(e.target)&&e.target!==el("settingsBtn")) el("settingsPanel").classList.add("hidden");
      if (!el("exportWrap").contains(e.target)) el("exportDropdown").classList.add("hidden");
    });

    window.addEventListener("keydown",e=>{
      const mod=e.metaKey||e.ctrlKey;
      if(mod&&e.key.toLowerCase()==="n"){ e.preventDefault(); createNewNote(); }
      if(mod&&e.key.toLowerCase()==="f"){ e.preventDefault(); el("searchInput").focus(); }
    });

    window.addEventListener("beforeunload",()=>{
      if((state.dirty||state.titleDirty)&&state.currentNoteId)
        navigator.sendBeacon&&navigator.sendBeacon(`/api/notes/${state.currentNoteId}`,
          new Blob([JSON.stringify({ content:state.quill.root.innerHTML })],{ type:"application/json" }));
    });

    // Close folder settings panel when clicking outside it
    document.addEventListener("click", e => {
      const panel = el("folderSettingsPanel");
      if (!panel || panel.classList.contains("hidden")) return;
      if (!el("sidebar").contains(e.target)) {
        panel.classList.add("hidden");
      }
    });

    initTagInput();
  }

  /* ────────────────────────────────────────
     FOLDER SETTINGS — tag manager
  ──────────────────────────────────────── */
  function renderFolderSettingsTags() {
    const list = el("fsTagList");
    list.innerHTML = "";

    if (!state.tags.length) {
      list.innerHTML = '<div style="font-size:12px;color:var(--text-secondary);font-style:italic;padding:4px 0">No tags yet — type #tagname in a note</div>';
      return;
    }

    state.tags.forEach(tag => {
      const row = document.createElement("div");
      row.className = "fs-tag-row";

      // Colour dot with hidden colour-picker input on top
      const dotWrap = document.createElement("div");
      dotWrap.className = "fs-tag-color";
      dotWrap.style.background = tag.color;
      const colorInput = document.createElement("input");
      colorInput.type = "color";
      colorInput.value = tag.color;
      colorInput.addEventListener("input", () => {
        dotWrap.style.background = colorInput.value;
      });
      colorInput.addEventListener("change", async () => {
        const updated = await api(`/api/tags/${tag.id}`, { method:"PATCH", body:JSON.stringify({ color:colorInput.value }) });
        if (!updated) return;
        // update local state
        const t = state.tags.find(t => t.id === tag.id);
        if (t) t.color = updated.color;
        // refresh tag chips in filter row
        renderTagFilterChips();
        // refresh note list so tag chips update their colours
        renderNoteList();
      });
      dotWrap.appendChild(colorInput);
      row.appendChild(dotWrap);

      // Tag name
      const name = document.createElement("span");
      name.className = "fs-tag-name";
      name.textContent = "#" + tag.name;
      row.appendChild(name);

      // Note count badge
      const noteCount = state.notes.filter(n => n.tags && n.tags.some(t => t.id === tag.id)).length;
      if (noteCount > 0) {
        const badge = document.createElement("span");
        badge.style.cssText = "font-size:11px;color:var(--text-secondary);";
        badge.textContent = noteCount + "n";
        row.appendChild(badge);
      }

      // Delete button
      const del = document.createElement("button");
      del.className = "fs-tag-delete";
      del.title = "Delete tag";
      del.innerHTML = "×";
      del.addEventListener("click", async () => {
        if (!confirm(`Delete tag "#${tag.name}"? It will be removed from all notes.`)) return;
        await api(`/api/tags/${tag.id}`, { method:"DELETE" });
        state.tags = state.tags.filter(t => t.id !== tag.id);
        // remove from all notes in state
        state.notes.forEach(n => { if (n.tags) n.tags = n.tags.filter(t => t.id !== tag.id); });
        renderFolderSettingsTags();
        renderTagFilterChips();
        renderNoteList();
        loadSidebar();
      });
      row.appendChild(del);

      list.appendChild(row);
    });
  }

  /* ════════════════════════════════════════
     INIT
  ════════════════════════════════════════ */
  async function init() {
    try {
      const res=await fetch("/api/auth/me");
      if (res.status===401) { window.location.href="/"; return; }
      const me=await res.json();
      if (!me.logged_in) { window.location.href="/"; return; }
      el("settingsUserEmail").textContent=me.user.email;
    } catch(_) { window.location.href="/"; return; }
    initQuill(); bindUI();
    await loadSidebar(); selectFolder("all");
  }

  document.addEventListener("DOMContentLoaded",init);
})();
