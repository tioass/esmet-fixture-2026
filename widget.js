/**
 * ESMET Fixture Mundial 2026 — widget embebible
 *
 * Configuración (definir antes de cargar este script en el embed de Webflow):
 *   window.ESMET_FIXTURE_CONFIG = {
 *     supabaseUrl: "https://xxx.supabase.co",
 *     supabaseAnonKey: "eyJ...",
 *   };
 *
 * Punto de montaje:  <div id="esmet-fixture"></div>
 */
(function () {
  const cfg = window.ESMET_FIXTURE_CONFIG;
  if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    console.error("[esmet-fixture] falta ESMET_FIXTURE_CONFIG (supabaseUrl, supabaseAnonKey)");
    return;
  }

  const root = document.getElementById("esmet-fixture");
  if (!root) {
    console.error("[esmet-fixture] no se encontró <div id='esmet-fixture'>");
    return;
  }
  root.classList.add("esmet-fixture");
  root.innerHTML = '<div class="esmet-loading">Cargando…</div>';

  // ───────────────────── Estado ─────────────────────
  const state = {
    supabase: null,
    session: null,
    profile: null,
    teams: [],
    matches: [],
    predictions: new Map(), // match_id → prediction row
    bonus: null,
    leaderboard: [],
    totalPoints: 0,
    activeTab: null, // "A".."L" | "knockout" | "bonus"
    flash: null, // { type: "success"|"error", text }
    saving: new Set(), // match ids saving
    modalOpen: null, // null | "leaderboard"
    redirectUrl: window.location.href.split("#")[0],
  };

  const firstName = (full) => (full ?? "").trim().split(/\s+/)[0] || "vos";

  // ───────────────────── Helpers ─────────────────────
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return d.toLocaleString("es-AR", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  };
  const escape = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  const isLocked = (m) => new Date(m.kickoff_at).getTime() <= Date.now();
  const tournamentStarted = () =>
    state.matches.length > 0 && new Date(state.matches[0].kickoff_at).getTime() <= Date.now();

  function setFlash(type, text) {
    state.flash = { type, text };
    render();
    setTimeout(() => {
      if (state.flash && state.flash.text === text) {
        state.flash = null;
        render();
      }
    }, 4000);
  }

  // ───────────────────── Init ─────────────────────
  // supabase-js se carga vía un <script> separado en el embed de Webflow.
  // Si el embed se rompió, esperamos hasta 8s a que window.supabase aparezca.
  function waitForSupabase() {
    return new Promise((resolve, reject) => {
      if (window.supabase?.createClient) return resolve(window.supabase);
      const start = Date.now();
      const t = setInterval(() => {
        if (window.supabase?.createClient) {
          clearInterval(t);
          resolve(window.supabase);
        } else if (Date.now() - start > 8000) {
          clearInterval(t);
          reject(new Error("supabase-js no cargó en el embed (¿falta el <script> de supabase?)"));
        }
      }, 80);
    });
  }

  async function init() {
    const sb = await waitForSupabase();
    state.supabase = sb.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });

    const { data } = await state.supabase.auth.getSession();
    state.session = data.session;

    state.supabase.auth.onAuthStateChange(async (event, session) => {
      state.session = session;
      if (event === "SIGNED_IN" && session) {
        await loadAppData();
      } else if (event === "SIGNED_OUT") {
        Object.assign(state, {
          profile: null,
          teams: [],
          matches: [],
          predictions: new Map(),
          bonus: null,
          leaderboard: [],
          totalPoints: 0,
          activeTab: null,
        });
        render();
      }
    });

    if (state.session) await loadAppData();
    else render();
  }

  // ───────────────────── Data loading ─────────────────────
  async function loadAppData() {
    root.innerHTML = '<div class="esmet-loading">Cargando fixture…</div>';
    const sb = state.supabase;
    const uid = state.session.user.id;

    const [profileRes, teamsRes, matchesRes, predsRes, bonusRes] = await Promise.all([
      sb.from("profiles").select("*").eq("id", uid).maybeSingle(),
      sb.from("teams").select("*"),
      sb
        .from("matches")
        .select(
          "id, stage, group_letter, round_label, kickoff_at, home_team_id, away_team_id, home_score, away_score, status"
        )
        .order("kickoff_at", { ascending: true }),
      sb.from("predictions").select("*").eq("user_id", uid),
      sb.from("bonus_predictions").select("*").eq("user_id", uid).maybeSingle(),
    ]);

    state.profile = profileRes.data;
    state.teams = teamsRes.data ?? [];
    state.matches = matchesRes.data ?? [];
    state.predictions = new Map((predsRes.data ?? []).map((p) => [p.match_id, p]));
    state.bonus = bonusRes.data;
    state.totalPoints =
      [...state.predictions.values()].reduce((s, p) => s + (p.points_awarded ?? 0), 0) +
      (state.bonus?.points_awarded ?? 0);

    if (!state.activeTab) {
      const groups = [...new Set(state.matches.map((m) => m.group_letter).filter(Boolean))].sort();
      state.activeTab = groups[0] ?? "knockout";
    }

    await loadLeaderboard();

    // Realtime: cambios en partidos (status/score) y en predictions globales (para leaderboard)
    sb.channel("esmet-matches")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "matches" }, (p) => {
        const idx = state.matches.findIndex((m) => m.id === p.new.id);
        if (idx >= 0) {
          state.matches[idx] = { ...state.matches[idx], ...p.new };
          render();
        }
      })
      .subscribe();

    sb.channel("esmet-predictions")
      .on("postgres_changes", { event: "*", schema: "public", table: "predictions" }, () => {
        loadLeaderboard();
      })
      .subscribe();

    render();
  }

  async function loadLeaderboard() {
    const { data } = await state.supabase
      .from("leaderboard")
      .select("*")
      .order("total_points", { ascending: false })
      .order("exact_count", { ascending: false })
      .limit(100);
    state.leaderboard = data ?? [];
    render();
  }

  // ───────────────────── Auth (magic link) ─────────────────────
  async function handleAuthSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const name = form.name.value.trim();
    const email = form.email.value.trim().toLowerCase();
    if (!name || !email) return;

    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "Enviando…";

    const { error } = await state.supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: state.redirectUrl,
        data: { name },
      },
    });

    btn.disabled = false;
    btn.textContent = "Enviame el link";

    if (error) {
      setFlash("error", `No pudimos enviar el link: ${error.message}`);
      return;
    }
    state.flash = {
      type: "success",
      text: `Te mandamos un link a ${email}. Abrilo desde el mismo navegador y listo.`,
    };
    render();
  }

  async function handleSignOut() {
    await state.supabase.auth.signOut();
  }

  // ───────────────────── Predictions ─────────────────────
  async function savePrediction(matchId) {
    const match = state.matches.find((m) => m.id === matchId);
    if (!match || isLocked(match)) return;

    const homeInput = root.querySelector(`[data-pred="home"][data-match="${matchId}"]`);
    const awayInput = root.querySelector(`[data-pred="away"][data-match="${matchId}"]`);
    const home = parseInt(homeInput.value, 10);
    const away = parseInt(awayInput.value, 10);
    if (isNaN(home) || isNaN(away) || home < 0 || away < 0) return;

    state.saving.add(matchId);
    render();

    const row = {
      user_id: state.session.user.id,
      match_id: matchId,
      home_score: home,
      away_score: away,
    };
    const { data, error } = await state.supabase
      .from("predictions")
      .upsert(row, { onConflict: "user_id,match_id" })
      .select()
      .single();

    state.saving.delete(matchId);

    if (error) {
      setFlash("error", `No se pudo guardar: ${error.message}`);
      return;
    }
    state.predictions.set(matchId, data);
    render();
  }

  async function saveBonus() {
    if (tournamentStarted()) return;
    const championSel = root.querySelector('[data-bonus="champion"]');
    const runnerSel = root.querySelector('[data-bonus="runner_up"]');
    const champion = championSel.value ? parseInt(championSel.value, 10) : null;
    const runnerUp = runnerSel.value ? parseInt(runnerSel.value, 10) : null;

    const row = {
      user_id: state.session.user.id,
      champion_team_id: champion,
      runner_up_team_id: runnerUp,
    };
    const { data, error } = await state.supabase
      .from("bonus_predictions")
      .upsert(row, { onConflict: "user_id" })
      .select()
      .single();

    if (error) {
      setFlash("error", `No se pudieron guardar los bonus: ${error.message}`);
      return;
    }
    state.bonus = data;
    setFlash("success", "Bonus guardados.");
  }

  // ───────────────────── Render ─────────────────────
  function render() {
    if (!state.session) {
      root.innerHTML = renderAuth();
      bindAuth();
      return;
    }
    root.innerHTML = renderApp();
    bindApp();
  }

  function renderAuth() {
    const flash = renderFlash();
    return `
      <div class="esmet-auth">
        <h1>Fixture Esmet 2026</h1>
        <p>Predeci los marcadores, sumá puntos y peleá la cima del ranking.</p>
        ${flash}
        <form data-form="auth">
          <div class="esmet-field">
            <label for="esmet-name">Nombre</label>
            <input class="esmet-input" id="esmet-name" name="name" type="text" required autocomplete="name" placeholder="Juan Pérez">
          </div>
          <div class="esmet-field">
            <label for="esmet-email">Email</label>
            <input class="esmet-input" id="esmet-email" name="email" type="email" required autocomplete="email" placeholder="vos@ejemplo.com">
          </div>
          <button class="esmet-btn" type="submit">Enviame el link</button>
          <p style="margin-top:1rem;font-size:.8rem;color:var(--esmet-neutral);">Te mandamos un link mágico al mail. Sin contraseñas.</p>
        </form>
      </div>
    `;
  }

  function renderApp() {
    const groups = [...new Set(state.matches.map((m) => m.group_letter).filter(Boolean))].sort();
    const hasKnockout = state.matches.some((m) => !m.group_letter);
    const tabs = [
      ...groups.map((g) => ({ id: g, label: `Grupo ${g}` })),
      ...(hasKnockout ? [{ id: "knockout", label: "Eliminatorias" }] : []),
      { id: "bonus", label: "Bonus" },
    ];

    return `
      <h1 class="esmet-title">Fixture Esmet 2026</h1>
      ${renderUserbar()}
      ${renderFlash()}
      <div class="esmet-tabs" role="tablist">
        ${tabs
          .map(
            (t) => `
          <button class="esmet-tab" role="tab" aria-selected="${state.activeTab === t.id}" data-tab="${t.id}">
            ${escape(t.label)}
          </button>
        `
          )
          .join("")}
      </div>
      ${renderTabContent()}
      ${renderFooter()}
      ${renderModal()}
    `;
  }

  function renderUserbar() {
    return `
      <div class="esmet-userbar">
        <span class="esmet-userbar__greeting">Hola, <strong>${escape(firstName(state.profile?.name))}</strong></span>
        <span class="esmet-userbar__points">${state.totalPoints} pts</span>
        <button class="esmet-link" data-action="open-leaderboard">Ver ranking →</button>
      </div>
    `;
  }

  function renderFooter() {
    return `
      <div class="esmet-footer">
        <button class="esmet-btn esmet-btn--secondary esmet-btn--small" data-action="signout">Salir</button>
      </div>
    `;
  }

  function renderModal() {
    if (state.modalOpen !== "leaderboard") return "";
    return `
      <div class="esmet-modal" data-modal>
        <div class="esmet-modal__backdrop" data-modal-close></div>
        <div class="esmet-modal__panel" role="dialog" aria-modal="true" aria-label="Ranking">
          <button class="esmet-modal__close" data-modal-close aria-label="Cerrar">×</button>
          <h2 style="margin-bottom:1rem;">Ranking</h2>
          ${renderLeaderboard()}
        </div>
      </div>
    `;
  }

  function renderFlash() {
    if (!state.flash) return "";
    const cls = state.flash.type === "error" ? "esmet-error" : "esmet-success-msg";
    return `<div class="${cls}">${escape(state.flash.text)}</div>`;
  }

  function renderTabContent() {
    if (state.activeTab === "bonus") return renderBonus();
    const tabMatches =
      state.activeTab === "knockout"
        ? state.matches.filter((m) => !m.group_letter)
        : state.matches.filter((m) => m.group_letter === state.activeTab);
    return renderMatchList(tabMatches);
  }

  function renderMatchList(list) {
    if (list.length === 0) {
      return '<div class="esmet-empty">Todavía no hay partidos cargados para esta fase.</div>';
    }
    // Agrupar por round_label
    const groups = new Map();
    for (const m of list) {
      const k = m.round_label || m.stage;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    return [...groups.entries()]
      .map(
        ([label, ms]) => `
      <h3 style="margin-top:2rem;margin-bottom:.75rem;font-size:1rem;color:var(--esmet-neutral-dark);text-transform:uppercase;letter-spacing:.05em;">${escape(
        label
      )}</h3>
      <div class="esmet-match-list">
        ${ms.map(renderMatch).join("")}
      </div>
    `
      )
      .join("");
  }

  function renderMatch(m) {
    const home = state.teams.find((t) => t.id === m.home_team_id);
    const away = state.teams.find((t) => t.id === m.away_team_id);
    const pred = state.predictions.get(m.id);
    const locked = isLocked(m);
    const finished = m.status === "finished";
    const live = m.status === "live";
    const saving = state.saving.has(m.id);

    const flag = (t) =>
      t?.flag_url ? `<img src="${escape(t.flag_url)}" alt="">` : "";
    const teamName = (t) => escape(t?.name ?? "TBD");

    let statusBlock = "";
    if (live) {
      statusBlock = `<div class="esmet-match__status esmet-match__status--live">
        <span>● EN VIVO &nbsp;${escape(m.home_score ?? 0)}-${escape(m.away_score ?? 0)}</span>
      </div>`;
    } else if (finished) {
      const pts = pred?.points_awarded;
      const ptsBadge =
        pts != null
          ? `<span class="esmet-match__points ${pts === 0 ? "esmet-match__points--zero" : ""}">${pts} pts</span>`
          : "";
      statusBlock = `<div class="esmet-match__status">
        <span class="esmet-match__final">Final: ${escape(m.home_score)}-${escape(m.away_score)}</span>
        ${ptsBadge}
      </div>`;
    } else if (locked) {
      statusBlock = `<div class="esmet-match__status">Cerrado</div>`;
    } else {
      statusBlock = `<div class="esmet-match__status">
        <span>${escape(fmtDate(m.kickoff_at))}</span>
        ${saving ? "<span>Guardando…</span>" : pred ? "<span>✓ Predicción guardada</span>" : ""}
      </div>`;
    }

    const homeVal = pred?.home_score ?? "";
    const awayVal = pred?.away_score ?? "";

    return `
      <div class="esmet-match ${locked ? "esmet-match--locked" : ""}" data-match-card="${m.id}">
        <div class="esmet-match__meta">
          <span>${escape(m.stage)}${m.group_letter ? ` · Grupo ${m.group_letter}` : ""}</span>
          <span>${escape(fmtDate(m.kickoff_at))}</span>
        </div>
        <div class="esmet-match__team">${flag(home)}<span>${teamName(home)}</span></div>
        <div class="esmet-match__scores">
          <input class="esmet-input" type="number" min="0" max="20" inputmode="numeric"
                 value="${homeVal}" data-pred="home" data-match="${m.id}" ${locked ? "disabled" : ""} aria-label="Goles ${teamName(home)}">
          <span class="esmet-match__sep">vs</span>
          <input class="esmet-input" type="number" min="0" max="20" inputmode="numeric"
                 value="${awayVal}" data-pred="away" data-match="${m.id}" ${locked ? "disabled" : ""} aria-label="Goles ${teamName(away)}">
        </div>
        <div class="esmet-match__team esmet-match__team--away"><span>${teamName(away)}</span>${flag(away)}</div>
        ${statusBlock}
      </div>
    `;
  }

  function renderBonus() {
    const closed = tournamentStarted();
    const opts = state.teams
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (t) => `<option value="${t.id}">${escape(t.name)}</option>`
      )
      .join("");
    const champ = state.bonus?.champion_team_id ?? "";
    const runner = state.bonus?.runner_up_team_id ?? "";
    const champPts = state.bonus?.points_awarded;

    return `
      <div class="esmet-bonus">
        <h3>Picks bonus</h3>
        <p style="color:var(--esmet-neutral);font-size:.9rem;">
          Campeón: 10 pts · Finalista: 5 pts.
          ${closed ? "Las predicciones bonus están cerradas." : "Podés modificar hasta el primer partido del Mundial."}
        </p>
        <div class="esmet-bonus__grid">
          <div class="esmet-field">
            <label>Campeón</label>
            <select class="esmet-input" data-bonus="champion" ${closed ? "disabled" : ""}>
              <option value="">Elegí un equipo…</option>
              ${state.teams
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(
                  (t) =>
                    `<option value="${t.id}" ${champ == t.id ? "selected" : ""}>${escape(t.name)}</option>`
                )
                .join("")}
            </select>
          </div>
          <div class="esmet-field">
            <label>Finalista (subcampeón)</label>
            <select class="esmet-input" data-bonus="runner_up" ${closed ? "disabled" : ""}>
              <option value="">Elegí un equipo…</option>
              ${state.teams
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(
                  (t) =>
                    `<option value="${t.id}" ${runner == t.id ? "selected" : ""}>${escape(t.name)}</option>`
                )
                .join("")}
            </select>
          </div>
        </div>
        ${
          closed
            ? champPts != null
              ? `<p style="margin-top:1rem;"><strong>Bonus obtenidos:</strong> ${champPts} pts.</p>`
              : ""
            : `<button class="esmet-btn" data-action="save-bonus" style="margin-top:1rem;">Guardar bonus</button>`
        }
      </div>
    `;
  }

  function renderLeaderboard() {
    if (state.leaderboard.length === 0) {
      return '<div class="esmet-empty">Todavía no hay puntajes cargados.</div>';
    }
    const myId = state.session.user.id;
    return `
      <div class="esmet-leaderboard">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Jugador</th>
              <th>Exactos</th>
              <th>Puntos</th>
            </tr>
          </thead>
          <tbody>
            ${state.leaderboard
              .map(
                (row, i) => `
              <tr class="${row.user_id === myId ? "esmet-me" : ""}">
                <td class="esmet-rank">${i + 1}</td>
                <td>${escape(row.name)}</td>
                <td>${row.exact_count ?? 0}</td>
                <td><strong>${row.total_points ?? 0}</strong></td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  // ───────────────────── Event binding ─────────────────────
  function bindAuth() {
    const form = root.querySelector('[data-form="auth"]');
    if (form) form.addEventListener("submit", handleAuthSubmit);
  }

  function bindApp() {
    root.querySelectorAll("[data-tab]").forEach((b) => {
      b.addEventListener("click", () => {
        state.activeTab = b.dataset.tab;
        render();
      });
    });
    root.querySelectorAll('[data-action="signout"]').forEach((b) => {
      b.addEventListener("click", handleSignOut);
    });
    root.querySelectorAll('[data-action="save-bonus"]').forEach((b) => {
      b.addEventListener("click", saveBonus);
    });
    root.querySelectorAll('[data-action="open-leaderboard"]').forEach((b) => {
      b.addEventListener("click", () => {
        state.modalOpen = "leaderboard";
        render();
      });
    });
    root.querySelectorAll("[data-modal-close]").forEach((el) => {
      el.addEventListener("click", () => {
        state.modalOpen = null;
        render();
      });
    });
    // Auto-save de predicciones con debounce por partido
    const debounce = new Map();
    root.querySelectorAll("[data-pred]").forEach((input) => {
      input.addEventListener("change", () => {
        const matchId = parseInt(input.dataset.match, 10);
        clearTimeout(debounce.get(matchId));
        debounce.set(
          matchId,
          setTimeout(() => savePrediction(matchId), 250)
        );
      });
    });
  }

  init().catch((err) => {
    console.error(err);
    root.innerHTML = `<div class="esmet-error">Error al iniciar el widget: ${escape(err.message)}</div>`;
  });
})();
