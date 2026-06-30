(function () {
  "use strict";

  /* ================================================================
     State
  ================================================================ */
  const state = {
    folders: [],
    allNotesCount: 0,
    trashCount: 0,
    currentFolder: "all",
    notes: [],
    currentNoteId: null,
    currentNoteDeleted: false,
    searchQuery: "",
    sortBy: "updated",
    viewMode: "list",
    filterMode: "all",
    saveTimer: null,
    titleSaveTimer: null,
    dirty: false,
    titleDirty: false,
    quill: null,
    sidebarCollapsed: false,
    noteListCollapsed: false,
    drag: { active: false, noteId: null, noteTitle: "", sourceEl: null },
  };

  const el = (id) => document.getElementById(id);

  const ICONS = {
    folder:    `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.4a1.5 1.5 0 0 1 1.2.6l1.2 1.6a1.5 1.5 0 0 0 1.2.6h7a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.3v-11.8z" fill="currentColor"/></svg>`,
    allNotes:  `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 3h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`,
    trash:     `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    pinFilled: `<svg viewBox="0 0 24 24" width="11" height="11"><path d="M14 2l8 8-4 1-5 5-1 4-2-2 3-3-5-5-3 3-2-2 4-1 5-5 1-4z" fill="currentColor"/></svg>`,
    checklist: `<svg viewBox="0 0 18 18"><rect x="2" y="2" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 9l2.5 2.5L13 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  };

  /* ================================================================
     API helper
  ================================================================ */
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

  /* ================================================================
     Date / utils
  ================================================================ */
  function formatListDate(iso) {
    const d = new Date(iso), now = new Date();
    if (d.toDateString() === now.toDateString())
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    const diffDays = Math.floor((now - d) / 86400000);
    if (diffDays < 6) return d.toLocaleDateString([], { weekday: "long" });
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
    return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }

  function escapeHtml(str) {
    return (str || "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function highlightMatch(text, query) {
    if (!query) return escapeHtml(text);
    const safe = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return escapeHtml(text).replace(new RegExp(`(${safe})`, "gi"), "<mark>$1</mark>");
  }

  /* ================================================================
     Client-side filter
  ================================================================ */
  function applyClientFilter(notes) {
    const now = new Date();
    switch (state.filterMode) {
      case "pinned": return notes.filter((n) => n.pinned);
      case "today": {
        const today = now.toDateString();
        return notes.filter((n) => new Date(n.updated_at).toDateString() === today);
      }
      case "week": {
        const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7);
        return notes.filter((n) => new Date(n.updated_at) >= weekAgo);
      }
      default: return notes;
    }
  }

  /* ================================================================
     Sort
  ================================================================ */
  function sortNotes(list) {
    const arr = list.slice();
    if (state.sortBy === "manual")  return arr.sort((a, b) => a.sort_order - b.sort_order);
    if (state.sortBy === "created") return arr.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (state.sortBy === "title")   return arr.sort((a, b) => a.title.localeCompare(b.title));
    return arr.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  }

  /* ================================================================
     Panel collapse
  ================================================================ */
  function collapseSidebar(collapse) {
    state.sidebarCollapsed = (collapse != null) ? collapse : !state.sidebarCollapsed;
    el("sidebar").classList.toggle("collapsed", state.sidebarCollapsed);
    el("sidebarTab").classList.toggle("hidden", !state.sidebarCollapsed);
  }
  function collapseNoteList(collapse) {
    state.noteListCollapsed = (collapse != null) ? collapse : !state.noteListCollapsed;
    el("noteListPane").classList.toggle("collapsed", state.noteListCollapsed);
    el("noteListTab").classList.toggle("hidden", !state.noteListCollapsed);
  }

  /* ================================================================
     Export CSV
  ================================================================ */
  function exportCsv() {
    const url = `/api/export/csv?folder=${encodeURIComponent(state.currentFolder)}`;
    const a = document.createElement("a");
    a.href = url; a.download = "notes_export.csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    showToast("Exported as CSV ✓");
  }

  function showToast(msg) {
    const t = el("exportToast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2400);
  }

  /* ================================================================
     Sidebar / Folders
  ================================================================ */
  async function loadSidebar() {
    const data = await api("/api/sidebar");
    if (!data) return;
    state.folders       = data.folders;
    state.allNotesCount = data.all_notes_count;
    state.trashCount    = data.trash_count;
    renderFolderList();
  }

  function renderFolderList() {
    const container = el("folderList");
    container.innerHTML = "";
    container.appendChild(buildFolderRow({ key: "all",   name: "All Notes",        icon: ICONS.allNotes, count: state.allNotesCount }));
    const d1 = document.createElement("div"); d1.className = "folder-divider"; container.appendChild(d1);
    state.folders.forEach((f) => container.appendChild(buildFolderRow({ key: f.id, name: f.name, icon: ICONS.folder, count: f.note_count, folder: f })));
    const d2 = document.createElement("div"); d2.className = "folder-divider"; container.appendChild(d2);
    container.appendChild(buildFolderRow({ key: "trash", name: "Recently Deleted", icon: ICONS.trash, count: state.trashCount, muted: true }));
  }

  function buildFolderRow({ key, name, icon, count, folder, muted }) {
    const row = document.createElement("div");
    row.className = "folder-row" + (String(state.currentFolder) === String(key) ? " selected" : "");
    row.dataset.key = String(key);

    const iconSpan = document.createElement("span");
    iconSpan.className = "folder-icon" + (muted ? " muted" : "");
    iconSpan.innerHTML = icon;
    row.appendChild(iconSpan);

    const nameSpan = document.createElement("span");
    nameSpan.className = "folder-name";
    nameSpan.textContent = name;
    row.appendChild(nameSpan);

    const countSpan = document.createElement("span");
    countSpan.className = "folder-count";
    countSpan.textContent = count > 0 ? count : "";
    row.appendChild(countSpan);

    row.addEventListener("click", () => { if (!nameSpan.isContentEditable) selectFolder(key); });
    if (folder) {
      row.addEventListener("dblclick", () => startRenameFolder(row, nameSpan, folder));
      row.addEventListener("contextmenu", (e) => { e.preventDefault(); showFolderContextMenu(e, folder, row, nameSpan); });
    }
    return row;
  }

  /* ── Drag-to-folder: hit-test all folder rows by bounding rect ──
     We do NOT use elementFromPoint for folder targets because the sidebar
     may be "behind" the note pane in pointer-event terms during a drag
     from the note list. Instead we scan all folder-row rects directly. */
  function getFolderAtPoint(x, y) {
    let match = null;
    document.querySelectorAll(".folder-row").forEach((row) => {
      const r = row.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        match = { el: row, key: row.dataset.key };
      }
    });
    return match;
  }

  function clearFolderHighlights() {
    document.querySelectorAll(".folder-row")
      .forEach((r) => r.classList.remove("folder-drop-target", "folder-drop-deny"));
  }

  function highlightFolderAt(x, y) {
    clearFolderHighlights();
    const hit = getFolderAtPoint(x, y);
    if (!hit) return null;
    const isValid = hit.key !== "trash" && hit.key !== "all";
    hit.el.classList.add(isValid ? "folder-drop-target" : "folder-drop-deny");
    return hit;
  }

  function startRenameFolder(row, nameSpan, folder) {
    nameSpan.contentEditable = "true";
    nameSpan.focus();
    document.execCommand("selectAll", false, null);
    function finish(save) {
      nameSpan.contentEditable = "false";
      const newName = nameSpan.textContent.trim();
      if (save && newName && newName !== folder.name) {
        api(`/api/folders/${folder.id}`, { method: "PATCH", body: JSON.stringify({ name: newName }) }).then(() => loadSidebar());
      } else {
        nameSpan.textContent = folder.name;
      }
      nameSpan.removeEventListener("blur", onBlur);
      nameSpan.removeEventListener("keydown", onKey);
    }
    const onBlur = () => finish(true);
    const onKey = (e) => {
      if (e.key === "Enter")  { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
    };
    nameSpan.addEventListener("blur", onBlur);
    nameSpan.addEventListener("keydown", onKey);
  }

  async function createFolder() {
    const folder = await api("/api/folders", { method: "POST", body: JSON.stringify({ name: "New Folder" }) });
    if (!folder) return;
    await loadSidebar();
    const row = [...document.querySelectorAll(".folder-row")].find((r) => r.dataset.key === String(folder.id));
    if (row) startRenameFolder(row, row.querySelector(".folder-name"), folder);
  }

  function showFolderContextMenu(evt, folder, row, nameSpan) {
    openContextMenu(evt, [
      { label: "Rename Folder", action: () => startRenameFolder(row, nameSpan, folder) },
      { label: "Delete Folder", danger: true, action: () =>
          confirmDialog(`Delete the folder "${folder.name}"? Its notes will move to Notes.`, async () => {
            await api(`/api/folders/${folder.id}`, { method: "DELETE" });
            if (String(state.currentFolder) === String(folder.id)) selectFolder("all");
            else loadSidebar();
          }) },
    ]);
  }

  function selectFolder(key) {
    state.currentFolder = key;
    state.searchQuery   = "";
    state.filterMode    = "all";
    if (state.sortBy === "manual") state.sortBy = "updated";
    el("searchInput").value = "";
    el("clearSearch").classList.add("hidden");
    document.querySelectorAll(".filter-chip").forEach((c) => c.classList.toggle("active", c.dataset.filter === "all"));
    renderFolderList();
    deselectNote();
    const title = key === "all" ? "All Notes"
      : key === "trash" ? "Recently Deleted"
      : (state.folders.find((f) => f.id === key) || {}).name || "Notes";
    el("currentFolderTitle").textContent = title;
    el("trashBanner").classList.toggle("hidden", key !== "trash");
    el("emptyTrashBtn").style.display = key === "trash" ? "block" : "none";
    setMobileView("view-list");
    loadNotes();
  }

  /* ================================================================
     Note list / render
  ================================================================ */
  async function loadNotes() {
    const params = new URLSearchParams({ folder: state.currentFolder });
    if (state.searchQuery) params.set("q", state.searchQuery);
    const notes = await api(`/api/notes?${params.toString()}`);
    if (!notes) return;
    state.notes = notes;
    renderNoteList();
  }

  function renderNoteList() {
    const list = el("noteList");
    const grid = el("stickyGrid");
    list.innerHTML = "";
    grid.innerHTML = "";

    const filtered = applyClientFilter(state.notes);
    el("noteListEmpty").classList.toggle("hidden", filtered.length > 0);

    const sticky  = state.viewMode === "sticky";
    const isTrash = state.currentFolder === "trash";
    list.classList.toggle("hidden", sticky);
    grid.classList.toggle("hidden", !sticky);

    if (sticky) {
      const pinned = sortNotes(filtered.filter((n) => n.pinned));
      const rest   = sortNotes(filtered.filter((n) => !n.pinned));
      (isTrash ? sortNotes(filtered) : [...pinned, ...rest])
        .forEach((n, i) => grid.appendChild(buildStickyCard(n, i, isTrash)));
      return;
    }
    if (isTrash) {
      sortNotes(filtered).forEach((n) => list.appendChild(buildNoteRow(n, true)));
      return;
    }
    const pinned = sortNotes(filtered.filter((n) => n.pinned));
    const rest   = sortNotes(filtered.filter((n) => !n.pinned));
    if (pinned.length) {
      list.appendChild(sectionLabel("Pinned"));
      pinned.forEach((n) => list.appendChild(buildNoteRow(n, false)));
      list.appendChild(sectionLabel(state.currentFolder === "all" ? "All Notes" : "Notes"));
    }
    rest.forEach((n) => list.appendChild(buildNoteRow(n, false)));
  }

  /* ================================================================
     Build sticky card
     FIX: use plain_text as preview so single-line notes show content.
     plain_text is the full note body without HTML tags.
     We show it from character 0 (unlike snippet which skips line 1).
  ================================================================ */
  function buildStickyCard(note, index, isTrash) {
    const card = document.createElement("div");
    card.className = "sticky-card" + (note.id === state.currentNoteId ? " selected" : "");
    const colorIdx  = ((note.id || index + 1) * 3 + 1) % 7;
    const rotations = [-2, -1, 0, 1, 2, -1.5, 1.5];
    card.dataset.color = String(colorIdx);
    card.style.setProperty("--rot", rotations[(note.id || index) % rotations.length] + "deg");
    card.dataset.id = note.id;

    if (note.pinned) {
      const pin = document.createElement("span");
      pin.className = "sticky-pin";
      pin.innerHTML = ICONS.pinFilled;
      card.appendChild(pin);
    }

    // Title
    const titleEl = document.createElement("div");
    titleEl.className = "sticky-title";
    titleEl.innerHTML = highlightMatch(note.title || "New Note", state.searchQuery);
    card.appendChild(titleEl);

    // Preview body — use plain_text (full body, always populated) so even a
    // one-line note shows the text. Fall back through snippet → title.
    const previewText = (note.plain_text || note.snippet || note.title || "").slice(0, 300);
    const snippetEl = document.createElement("div");
    snippetEl.className = "sticky-snippet";
    snippetEl.innerHTML = highlightMatch(previewText, state.searchQuery);
    card.appendChild(snippetEl);

    const meta = document.createElement("div");
    meta.className = "sticky-meta";
    meta.innerHTML = `<span>${escapeHtml(formatListDate(note.updated_at))}</span>`;
    card.appendChild(meta);

    if (isTrash) {
      const actions = document.createElement("div");
      actions.className = "sticky-actions";
      const rec = document.createElement("button");
      rec.textContent = "Recover";
      rec.onclick = (e) => { e.stopPropagation(); recoverNote(note.id); };
      const del = document.createElement("button");
      del.textContent = "Delete"; del.className = "danger";
      del.onclick = (e) => { e.stopPropagation(); confirmDialog("Delete this note permanently? This can't be undone.", () => permanentlyDeleteNote(note.id)); };
      actions.appendChild(rec); actions.appendChild(del);
      card.appendChild(actions);
    }

    card.addEventListener("click", () => selectNote(note.id));
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      isTrash
        ? openContextMenu(e, [
            { label: "Recover Note", action: () => recoverNote(note.id) },
            { label: "Delete Immediately", danger: true, action: () => confirmDialog("Delete this note permanently? This can't be undone.", () => permanentlyDeleteNote(note.id)) },
          ])
        : openNoteContextMenu(e, note);
    });
    if (!isTrash) attachStickyDrag(card, note);
    return card;
  }

  /* ================================================================
     Build list row
  ================================================================ */
  function sectionLabel(text) {
    const d = document.createElement("div");
    d.className = "note-list-section-label";
    d.textContent = text;
    return d;
  }

  function buildNoteRow(note, isTrash) {
    const row = document.createElement("li");
    row.className = "note-row" + (note.id === state.currentNoteId ? " selected" : "");
    row.dataset.id = note.id;

    const top = document.createElement("div"); top.className = "row-top";
    const titleSpan = document.createElement("span");
    titleSpan.className = "row-title";
    titleSpan.innerHTML = highlightMatch(note.title || "New Note", state.searchQuery);
    top.appendChild(titleSpan);
    if (note.pinned) {
      const pin = document.createElement("span"); pin.className = "pin-icon"; pin.innerHTML = ICONS.pinFilled; top.appendChild(pin);
    }
    row.appendChild(top);

    const meta = document.createElement("div"); meta.className = "row-meta";
    const dateSpan = document.createElement("span"); dateSpan.className = "row-date"; dateSpan.textContent = formatListDate(note.updated_at); meta.appendChild(dateSpan);
    const snippetSpan = document.createElement("span"); snippetSpan.className = "row-snippet"; snippetSpan.innerHTML = highlightMatch(note.snippet || "", state.searchQuery); meta.appendChild(snippetSpan);
    row.appendChild(meta);

    if (isTrash) {
      const actions = document.createElement("div"); actions.className = "row-actions"; actions.style.display = "flex";
      const recoverBtn = document.createElement("button"); recoverBtn.textContent = "Recover"; recoverBtn.onclick = (e) => { e.stopPropagation(); recoverNote(note.id); };
      const delBtn = document.createElement("button"); delBtn.textContent = "Delete"; delBtn.className = "danger"; delBtn.onclick = (e) => { e.stopPropagation(); confirmDialog("Delete this note permanently? This can't be undone.", () => permanentlyDeleteNote(note.id)); };
      actions.appendChild(recoverBtn); actions.appendChild(delBtn); row.appendChild(actions);
    }

    row.addEventListener("click", () => selectNote(note.id));
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      isTrash
        ? openContextMenu(e, [
            { label: "Recover Note", action: () => recoverNote(note.id) },
            { label: "Delete Immediately", danger: true, action: () => confirmDialog("Delete this note permanently? This can't be undone.", () => permanentlyDeleteNote(note.id)) },
          ])
        : openNoteContextMenu(e, note);
    });
    if (!isTrash) attachListDrag(row, note);
    return row;
  }

  function openNoteContextMenu(evt, note) {
    openContextMenu(evt, [
      { label: note.pinned ? "Unpin Note" : "Pin Note", action: () => togglePin(note.id) },
      { label: "Move to…", submenu: state.folders.map((f) => ({
          label: f.name + (f.id === note.folder_id ? "  ✓" : ""),
          action: () => moveNote(note.id, f.id),
        })) },
      { divider: true },
      { label: "Delete", danger: true, action: () => confirmDialog("Delete this note? It will move to Recently Deleted.", () => deleteNote(note.id)) },
    ]);
  }

  function updateNoteInList(updated) {
    const idx = state.notes.findIndex((n) => n.id === updated.id);
    if (idx >= 0) state.notes[idx] = Object.assign({}, state.notes[idx], updated);
    else state.notes.unshift(updated);
    renderNoteList();
  }

  function removeNoteFromList(id) {
    state.notes = state.notes.filter((n) => n.id !== id);
    renderNoteList();
  }

  /* ================================================================
     DRAG & DROP
     ─────────────────────────────────────────────────────────────────
     KEY FIXES:
     1. Folder hit-testing uses getBoundingClientRect() scanning ALL
        folder-row elements directly — NOT elementFromPoint — so the
        sidebar's overflow:hidden and stacking context never blocks it.
     2. mouseup uses ev.clientX/ev.clientY (the actual release coords)
        not a stale lastX/lastY from the previous mousemove, which can
        lag on Windows when the mouse stops just before release.
     3. plain_text is now used for sticky card previews (Bug 1 fix).
  ================================================================ */

  const ghost = el("dragGhost");

  function showGhost(title, x, y) {
    ghost.textContent = title;
    ghost.style.left = x + "px";
    ghost.style.top  = y + "px";
    ghost.classList.add("visible");
  }
  function moveGhost(x, y) { ghost.style.left = x + "px"; ghost.style.top = y + "px"; }
  function hideGhost() { ghost.classList.remove("visible"); }

  function startDrag(note, sourceEl, e) {
    state.drag = { active: true, noteId: note.id, noteTitle: note.title || "Note", sourceEl };
    sourceEl.classList.add("dragging");
    showGhost(note.title || "Note", e.clientX, e.clientY);
    document.body.style.userSelect = "none";
  }

  function endDrag() {
    if (!state.drag.active) return;
    if (state.drag.sourceEl) state.drag.sourceEl.classList.remove("dragging");
    hideGhost();
    document.body.style.userSelect = "";
    clearFolderHighlights();
    document.querySelectorAll(".drop-above,.drop-below,.drop-target")
      .forEach((n) => n.classList.remove("drop-above", "drop-below", "drop-target"));
    state.drag = { active: false, noteId: null, noteTitle: "", sourceEl: null };
  }

  /* elementFromPoint with source element made pointer-transparent */
  function elementBelowDrag(x, y) {
    const src = state.drag.sourceEl;
    if (src) src.style.pointerEvents = "none";
    const found = document.elementFromPoint(x, y);
    if (src) src.style.pointerEvents = "";
    return found;
  }

  /* ── List drag ── */
  function attachListDrag(row, note) {
    row.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("button")) return;

      let started = false;

      const onMove = (ev) => {
        if (!started && (Math.abs(ev.clientX - e.clientX) > 3 || Math.abs(ev.clientY - e.clientY) > 3)) {
          started = true;
          startDrag(note, row, ev);
        }
        if (!started) return;

        moveGhost(ev.clientX, ev.clientY);

        // Clear all indicators
        document.querySelectorAll(".note-row.drop-above,.note-row.drop-below")
          .forEach((r) => r.classList.remove("drop-above", "drop-below"));
        clearFolderHighlights();

        // FIX: check folders first via rect scan (bypasses pointer-event blocking)
        const folderHit = highlightFolderAt(ev.clientX, ev.clientY);
        if (folderHit) return;

        // Check note rows via elementFromPoint
        const target  = elementBelowDrag(ev.clientX, ev.clientY);
        const noteRow = target && target.closest(".note-row");
        if (noteRow && noteRow !== row) {
          const rect  = noteRow.getBoundingClientRect();
          noteRow.classList.add(ev.clientY < rect.top + rect.height / 2 ? "drop-above" : "drop-below");
        }
      };

      const onUp = async (ev) => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup",   onUp);
        if (!started || !state.drag.active) { endDrag(); return; }

        const cx = ev.clientX, cy = ev.clientY;

        // FIX: check folder drop via rect scan — reliable regardless of z-index/overflow
        const folderHit = getFolderAtPoint(cx, cy);
        if (folderHit) {
          const key = folderHit.key;
          if (key !== "trash" && key !== "all") {
            const folderId = Number(key);
            const folder   = state.folders.find((f) => f.id === folderId);
            if (folder) {
              const draggedNoteId = state.drag.noteId;
              endDrag();
              await moveNote(draggedNoteId, folderId);
              showToast(`Moved to "${folder.name}"`);
              return;
            }
          }
          endDrag(); return;
        }

        // Check note row drop (reorder)
        const target  = elementBelowDrag(cx, cy);
        const dropRow = target && target.closest(".note-row");
        if (dropRow && Number(dropRow.dataset.id) !== note.id) {
          const rect         = dropRow.getBoundingClientRect();
          const insertBefore = cy < rect.top + rect.height / 2;
          const draggedId    = state.drag.noteId;
          endDrag();
          await reorderInList(draggedId, Number(dropRow.dataset.id), insertBefore);
          return;
        }

        endDrag();
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup",   onUp);
    });
  }

  /* ── Sticky drag ── */
  function attachStickyDrag(card, note) {
    card.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("button")) return;

      let started = false;

      const onMove = (ev) => {
        if (!started && (Math.abs(ev.clientX - e.clientX) > 3 || Math.abs(ev.clientY - e.clientY) > 3)) {
          started = true;
          startDrag(note, card, ev);
        }
        if (!started) return;

        moveGhost(ev.clientX, ev.clientY);

        document.querySelectorAll(".sticky-card.drop-target")
          .forEach((c) => c.classList.remove("drop-target"));
        clearFolderHighlights();

        // FIX: folder check via rect scan first
        const folderHit = highlightFolderAt(ev.clientX, ev.clientY);
        if (folderHit) return;

        const target   = elementBelowDrag(ev.clientX, ev.clientY);
        const dropCard = target && target.closest(".sticky-card");
        if (dropCard && dropCard !== card) dropCard.classList.add("drop-target");
      };

      const onUp = async (ev) => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup",   onUp);
        if (!started || !state.drag.active) { endDrag(); return; }

        const cx = ev.clientX, cy = ev.clientY;

        // FIX: folder check via rect scan
        const folderHit = getFolderAtPoint(cx, cy);
        if (folderHit) {
          const key = folderHit.key;
          if (key !== "trash" && key !== "all") {
            const folderId = Number(key);
            const folder   = state.folders.find((f) => f.id === folderId);
            if (folder) {
              const draggedNoteId = state.drag.noteId;
              endDrag();
              await moveNote(draggedNoteId, folderId);
              showToast(`Moved to "${folder.name}"`);
              return;
            }
          }
          endDrag(); return;
        }

        // Sticky card reorder
        const target   = elementBelowDrag(cx, cy);
        const dropCard = target && target.closest(".sticky-card");
        if (dropCard && Number(dropCard.dataset.id) !== note.id) {
          const draggedId = state.drag.noteId;
          endDrag();
          await reorderInGrid(draggedId, Number(dropCard.dataset.id));
          return;
        }

        endDrag();
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup",   onUp);
    });
  }

  /* ── Reorder (DOM-move for instant feedback) ── */
  async function reorderInList(dragId, targetId, insertBefore) {
    const list    = el("noteList");
    const rows    = [...list.querySelectorAll(".note-row")];
    const srcRow  = rows.find((r) => Number(r.dataset.id) === dragId);
    const tgtRow  = rows.find((r) => Number(r.dataset.id) === targetId);
    if (!srcRow || !tgtRow || srcRow === tgtRow) return;
    list.insertBefore(srcRow, insertBefore ? tgtRow : tgtRow.nextSibling);
    state.sortBy = "manual";
    el("sortLabel").textContent = "Manual";
    const newOrder = [...list.querySelectorAll(".note-row")].map((r) => Number(r.dataset.id));
    newOrder.forEach((id, i) => { const n = state.notes.find((n) => n.id === id); if (n) n.sort_order = i; });
    state.notes.sort((a, b) => a.sort_order - b.sort_order);
    await api("/api/notes/reorder", { method: "POST", body: JSON.stringify({ ordered_ids: newOrder }) });
  }

  async function reorderInGrid(dragId, targetId) {
    const grid    = el("stickyGrid");
    const cards   = [...grid.querySelectorAll(".sticky-card")];
    const srcCard = cards.find((c) => Number(c.dataset.id) === dragId);
    const tgtCard = cards.find((c) => Number(c.dataset.id) === targetId);
    if (!srcCard || !tgtCard || srcCard === tgtCard) return;
    grid.insertBefore(srcCard, tgtCard);
    state.sortBy = "manual";
    el("sortLabel").textContent = "Manual";
    const newOrder = [...grid.querySelectorAll(".sticky-card")].map((c) => Number(c.dataset.id));
    newOrder.forEach((id, i) => { const n = state.notes.find((n) => n.id === id); if (n) n.sort_order = i; });
    state.notes.sort((a, b) => a.sort_order - b.sort_order);
    await api("/api/notes/reorder", { method: "POST", body: JSON.stringify({ ordered_ids: newOrder }) });
  }

  /* ================================================================
     Editor
  ================================================================ */
  function initQuill() {
    state.quill = new Quill("#quillEditor", {
      theme: "snow",
      placeholder: "Start writing…",
      modules: { toolbar: { container: "#quillToolbar" } },
    });
    el("checklistBtn").innerHTML = ICONS.checklist;
    initQuillListener();
  }

  function initQuillListener() {
    state.quill.off("text-change");
    state.quill.on("text-change", (delta, old, source) => {
      if (source !== "user") return;
      state.dirty = true;
      setSaveStatus("Editing…");
      updateWordCount();
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(saveCurrentNote, 1500);
    });
  }

  function setSaveStatus(text) {
    const s = el("saveStatus");
    s.style.opacity = "1";
    s.textContent = text;
    if (text === "Saved") {
      clearTimeout(s._fade);
      s._fade = setTimeout(() => { s.style.opacity = "0"; }, 1400);
    }
  }

  function updateWordCount() {
    const text  = state.quill.getText().trim();
    const words = text ? text.split(/\s+/).length : 0;
    el("wordCount").textContent = words ? `${words} word${words === 1 ? "" : "s"}` : "";
  }

  async function selectNote(id) {
    if (state.currentNoteId === id) return;
    await flushPendingSave();
    state.currentNoteId = id;
    state.currentNoteDeleted = state.currentFolder === "trash";
    [...document.querySelectorAll(".note-row")].forEach((r) => r.classList.toggle("selected", Number(r.dataset.id) === id));
    [...document.querySelectorAll(".sticky-card")].forEach((c) => c.classList.toggle("selected", Number(c.dataset.id) === id));

    const note = await api(`/api/notes/${id}`);
    if (!note) return;
    el("editorEmpty").classList.add("hidden");
    el("editorContent").classList.remove("hidden");
    el("trashedBanner").classList.toggle("hidden", !note.is_deleted);
    el("noteTitleInput").value    = (note.title && note.title !== "New Note") ? note.title : "";
    el("noteTitleInput").disabled = note.is_deleted;

    state.quill.off("text-change");
    state.quill.setContents(state.quill.clipboard.convert(note.content || ""), "silent");
    state.quill.history.clear();
    state.quill.enable(!note.is_deleted);
    initQuillListener();
    updateWordCount();
    setSaveStatus("");
    document.title = (note.title || "Notes") + " — Notes";
    updatePinUI(note.pinned);
    setMobileView("view-editor");
  }

  function updatePinUI(pinned) {
    el("taskbarPinBtn").classList.toggle("active-pin", !!pinned);
    el("taskbarPinLabel").textContent = pinned ? "Unpin" : "Pin";
  }

  function deselectNote() {
    state.currentNoteId = null;
    el("editorEmpty").classList.remove("hidden");
    el("editorContent").classList.add("hidden");
    el("noteTitleInput").value = "";
    document.title = "Notes";
    updatePinUI(false);
  }

  async function flushPendingSave() {
    clearTimeout(state.saveTimer);
    clearTimeout(state.titleSaveTimer);
    if ((state.dirty || state.titleDirty) && state.currentNoteId) await saveCurrentNote();
  }

  async function saveCurrentNote() {
    if (!state.currentNoteId || (!state.dirty && !state.titleDirty)) return;
    const id       = state.currentNoteId;
    const content  = state.quill.root.innerHTML;
    const titleVal = el("noteTitleInput").value.trim();
    state.dirty = false; state.titleDirty = false;
    try {
      let updated = await api(`/api/notes/${id}`, { method: "PUT", body: JSON.stringify({ content }) });
      if (!updated) return;
      if (titleVal) {
        updated = await api(`/api/notes/${id}`, { method: "PUT", body: JSON.stringify({ content, _title_override: titleVal }) });
        if (!updated) return;
      }
      updateNoteInList(updated);
      [...document.querySelectorAll(".note-row")].forEach((r) => r.classList.toggle("selected", Number(r.dataset.id) === id));
      document.title = (updated.title || "Notes") + " — Notes";
      setSaveStatus("Saved");
      loadSidebar();
    } catch (_) { setSaveStatus("Couldn't save"); }
  }

  async function createNewNote() {
    let folderId = null;
    if (typeof state.currentFolder === "number") folderId = state.currentFolder;
    const note = await api("/api/notes", { method: "POST", body: JSON.stringify({ folder_id: folderId }) });
    if (!note) return;
    if (state.currentFolder === "trash") { selectFolder("all"); return; }
    state.notes.unshift(note);
    renderNoteList();
    await selectNote(note.id);
    el("noteTitleInput").focus();
    loadSidebar();
  }

  async function togglePin(id) {
    const updated = await api(`/api/notes/${id}/pin`, { method: "POST" });
    if (!updated) return;
    updateNoteInList(updated);
    if (id === state.currentNoteId) updatePinUI(updated.pinned);
  }

  async function moveNote(id, folderId) {
    const updated = await api(`/api/notes/${id}/move`, { method: "POST", body: JSON.stringify({ folder_id: folderId }) });
    if (!updated) return;
    if (typeof state.currentFolder === "number" && state.currentFolder !== folderId) {
      removeNoteFromList(id);
      if (id === state.currentNoteId) deselectNote();
    } else {
      updateNoteInList(updated);
    }
    loadSidebar();
  }

  async function deleteNote(id) {
    await api(`/api/notes/${id}`, { method: "DELETE" });
    removeNoteFromList(id);
    if (id === state.currentNoteId) deselectNote();
    loadSidebar();
  }

  async function recoverNote(id) {
    await api(`/api/notes/${id}/restore`, { method: "POST" });
    removeNoteFromList(id);
    if (id === state.currentNoteId) deselectNote();
    loadSidebar();
  }

  async function permanentlyDeleteNote(id) {
    await api(`/api/notes/${id}`, { method: "DELETE" });
    removeNoteFromList(id);
    if (id === state.currentNoteId) deselectNote();
    loadSidebar();
  }

  async function emptyTrash() {
    await api("/api/trash/empty", { method: "POST" });
    state.notes = [];
    renderNoteList();
    if (state.currentNoteDeleted) deselectNote();
    loadSidebar();
  }

  /* ================================================================
     Context menu
  ================================================================ */
  function openContextMenu(evt, items) {
    const menu = el("contextMenu");
    menu.innerHTML = "";
    items.forEach((item) => {
      if (item.divider) { const d = document.createElement("div"); d.className = "menu-divider"; menu.appendChild(d); return; }
      const row = document.createElement("div");
      row.className = "menu-item" + (item.danger ? " danger" : "");
      row.textContent = item.label;
      if (item.submenu) {
        row.classList.add("menu-submenu-label");
        const sub = document.createElement("div");
        sub.className = "submenu hidden";
        item.submenu.forEach((s) => {
          const sRow = document.createElement("div");
          sRow.className = "menu-item";
          sRow.textContent = s.label;
          sRow.onclick = (e2) => { e2.stopPropagation(); closeContextMenu(); s.action(); };
          sub.appendChild(sRow);
        });
        row.appendChild(sub);
        row.addEventListener("mouseenter", () => sub.classList.remove("hidden"));
        row.addEventListener("mouseleave", () => sub.classList.add("hidden"));
      } else {
        row.onclick = (e2) => { e2.stopPropagation(); closeContextMenu(); item.action(); };
      }
      menu.appendChild(row);
    });
    menu.classList.remove("hidden");
    el("overlay").classList.remove("hidden");
    const x = Math.min(evt.clientX, window.innerWidth  - 220);
    const y = Math.min(evt.clientY, window.innerHeight - menu.offsetHeight - 20);
    menu.style.left = x + "px";
    menu.style.top  = y + "px";
  }

  function closeContextMenu() {
    el("contextMenu").classList.add("hidden");
    el("overlay").classList.add("hidden");
    el("settingsPanel").classList.add("hidden");
  }

  /* ================================================================
     Confirm dialog
  ================================================================ */
  function confirmDialog(message, onConfirm) {
    el("confirmMessage").textContent = message;
    el("confirmDialog").classList.remove("hidden");
    el("overlay").classList.remove("hidden");
    function cleanup() {
      el("confirmDialog").classList.add("hidden");
      el("overlay").classList.add("hidden");
      el("confirmOk").removeEventListener("click", onOk);
      el("confirmCancel").removeEventListener("click", onCancel);
    }
    const onOk     = () => { cleanup(); onConfirm(); };
    const onCancel = () => cleanup();
    el("confirmOk").addEventListener("click", onOk);
    el("confirmCancel").addEventListener("click", onCancel);
  }

  /* ================================================================
     Settings
  ================================================================ */
  function applyEditorSettings() {
    document.documentElement.style.setProperty("--editor-font-size",   el("fontSizeSlider").value + "px");
    document.documentElement.style.setProperty("--editor-line-height", el("lineSpacingSlider").value);
  }

  /* ================================================================
     Mobile
  ================================================================ */
  function setMobileView(view) {
    document.getElementById("app").className = view + (state.viewMode === "sticky" ? " sticky-mode" : "");
  }

  /* ================================================================
     Bind UI
  ================================================================ */
  function bindUI() {
    el("newFolderBtn").addEventListener("click", createFolder);
    el("collapseSidebar").addEventListener("click", () => collapseSidebar());
    el("sidebarTab").addEventListener("click", () => collapseSidebar(false));
    el("collapseNoteList").addEventListener("click", () => collapseNoteList());
    el("noteListTab").addEventListener("click", () => collapseNoteList(false));
    el("backToFolders").addEventListener("click", () => setMobileView("view-folders"));
    el("backToList").addEventListener("click", () => setMobileView("view-list"));

    el("taskbarNewNote").addEventListener("click", createNewNote);
    el("taskbarPinBtn").addEventListener("click", () => { if (state.currentNoteId) togglePin(state.currentNoteId); });
    el("taskbarMoveBtn").addEventListener("click", (e) => {
      if (!state.currentNoteId) return;
      const note = state.notes.find((n) => n.id === state.currentNoteId) || { folder_id: null };
      openContextMenu(e, state.folders.map((f) => ({
        label: f.name + (f.id === note.folder_id ? "  ✓" : ""),
        action: () => moveNote(state.currentNoteId, f.id),
      })));
    });
    el("taskbarDeleteBtn").addEventListener("click", () => {
      if (!state.currentNoteId) return;
      confirmDialog("Delete this note? It will move to Recently Deleted.", () => deleteNote(state.currentNoteId));
    });
    el("exportBtn").addEventListener("click", exportCsv);

    el("settingsBtn").addEventListener("click", (e) => { e.stopPropagation(); el("settingsPanel").classList.toggle("hidden"); });
    el("closeSettings").addEventListener("click", () => el("settingsPanel").classList.add("hidden"));
    el("logoutBtn").addEventListener("click", async () => {
      try { await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" } }); } finally { window.location.href = "/"; }
    });
    el("fontSizeSlider").addEventListener("input", applyEditorSettings);
    el("lineSpacingSlider").addEventListener("input", applyEditorSettings);
    document.querySelectorAll(".settings-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        document.querySelectorAll(".settings-chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        document.documentElement.style.setProperty("--editor-max-width", chip.dataset.width + "px");
      });
    });

    el("emptyTrashBtn").addEventListener("click", () => confirmDialog("Empty Recently Deleted? Notes will be permanently deleted.", emptyTrash));
    el("recoverBtn").addEventListener("click", () => { if (state.currentNoteId) recoverNote(state.currentNoteId); });

    el("noteTitleInput").addEventListener("input", () => {
      state.titleDirty = true; setSaveStatus("Editing…");
      clearTimeout(state.titleSaveTimer);
      state.titleSaveTimer = setTimeout(saveCurrentNote, 1500);
    });
    el("noteTitleInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); state.quill.focus(); } });

    el("createFirstNote").addEventListener("click", createNewNote);

    let searchTimer = null;
    el("searchInput").addEventListener("input", (e) => {
      state.searchQuery = e.target.value;
      el("clearSearch").classList.toggle("hidden", !state.searchQuery);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(loadNotes, 250);
    });
    el("clearSearch").addEventListener("click", () => {
      el("searchInput").value = ""; state.searchQuery = "";
      el("clearSearch").classList.add("hidden");
      loadNotes();
    });

    document.querySelectorAll(".filter-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        state.filterMode = chip.dataset.filter;
        document.querySelectorAll(".filter-chip").forEach((c) => c.classList.toggle("active", c === chip));
        renderNoteList();
      });
    });

    el("sortBtn").addEventListener("click", (e) => { e.stopPropagation(); el("sortMenu").classList.toggle("hidden"); });
    document.querySelectorAll(".sort-option").forEach((opt) => {
      opt.addEventListener("click", () => {
        state.sortBy = opt.dataset.sort;
        el("sortLabel").textContent = opt.textContent;
        el("sortMenu").classList.add("hidden");
        renderNoteList();
      });
    });

    document.querySelectorAll(".view-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.view;
        if (mode === state.viewMode) return;
        state.viewMode = mode;
        document.querySelectorAll(".view-toggle-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === mode));
        document.getElementById("app").classList.toggle("sticky-mode", mode === "sticky");
        renderNoteList();
      });
    });

    el("overlay").addEventListener("click", closeContextMenu);
    document.addEventListener("click", (e) => {
      if (!el("sortMenu").contains(e.target)     && e.target !== el("sortBtn"))     el("sortMenu").classList.add("hidden");
      if (!el("settingsPanel").contains(e.target) && e.target !== el("settingsBtn")) el("settingsPanel").classList.add("hidden");
    });

    window.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); createNewNote(); }
      if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); el("searchInput").focus(); }
    });

    window.addEventListener("beforeunload", () => {
      if ((state.dirty || state.titleDirty) && state.currentNoteId) {
        navigator.sendBeacon && navigator.sendBeacon(
          `/api/notes/${state.currentNoteId}`,
          new Blob([JSON.stringify({ content: state.quill.root.innerHTML })], { type: "application/json" })
        );
      }
    });
  }

  /* ================================================================
     Init
  ================================================================ */
  async function init() {
    try {
      const res = await fetch("/api/auth/me");
      if (res.status === 401) { window.location.href = "/"; return; }
      const me = await res.json();
      if (!me.logged_in) { window.location.href = "/"; return; }
      el("settingsUserEmail").textContent = me.user.email;
    } catch (_) { window.location.href = "/"; return; }

    initQuill();
    bindUI();
    await loadSidebar();
    selectFolder("all");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
