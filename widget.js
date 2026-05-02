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

  // ───────────────────── Dev mode (localhost) ─────────────────────
  // En localhost no llamamos a Supabase: mockeamos sesión + datos para iterar
  // UI sin esperar magic link ni hits a la base.
  const IS_DEV = ["localhost", "127.0.0.1"].includes(window.location.hostname);

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
    countdownInterval: null,
    redirectUrl: window.location.href.split("#")[0],
  };

  const firstName = (full) => (full ?? "").trim().split(/\s+/)[0] || "vos";

  // Track última tab animada para no re-animar en cada render parcial
  let lastAnimatedTab = null;

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

  // ───────────────────── Mock data (dev mode) ─────────────────────
  // Replica la estructura real del Mundial 2026:
  //   12 grupos × 4 equipos = 48 selecciones
  //   72 partidos de fase de grupos (6 por grupo, 3 jornadas)
  //   32 partidos de knockout (16 R32 + 8 R16 + 4 QF + 2 SF + 1 3er puesto + 1 Final)
  function loadMockData(formName, formEmail) {
    const flag = (code) => `https://a.espncdn.com/i/teamlogos/countries/500/${code.toLowerCase()}.png`;
    const GROUPS = {
      A: [["Mexico","MEX"],["Czechia","CZE"],["South Korea","KOR"],["South Africa","RSA"]],
      B: [["Canada","CAN"],["Bosnia-Herzegovina","BIH"],["Switzerland","SUI"],["Qatar","QAT"]],
      C: [["Brazil","BRA"],["Scotland","SCO"],["Haiti","HAI"],["Morocco","MAR"]],
      D: [["Paraguay","PAR"],["Türkiye","TUR"],["Australia","AUS"],["United States","USA"]],
      E: [["Ecuador","ECU"],["Germany","GER"],["Ivory Coast","CIV"],["Curacao","CUW"]],
      F: [["Netherlands","NED"],["Sweden","SWE"],["Japan","JPN"],["Tunisia","TUN"]],
      G: [["Belgium","BEL"],["Iran","IRN"],["Egypt","EGY"],["New Zealand","NZL"]],
      H: [["Spain","ESP"],["Uruguay","URU"],["Saudi Arabia","KSA"],["Cape Verde","CPV"]],
      I: [["Norway","NOR"],["France","FRA"],["Senegal","SEN"],["Iraq","IRQ"]],
      J: [["Argentina","ARG"],["Austria","AUT"],["Algeria","ALG"],["Jordan","JOR"]],
      K: [["Colombia","COL"],["Portugal","POR"],["Uzbekistan","UZB"],["Congo DR","COD"]],
      L: [["England","ENG"],["Croatia","CRO"],["Panama","PAN"],["Ghana","GHA"]],
    };

    // Equipos: 48 reales + 32 placeholders para cuadro de eliminación
    const teams = [];
    const teamIdByName = {};
    let nid = 1;
    for (const [letter, list] of Object.entries(GROUPS)) {
      for (const [name, code] of list) {
        const t = { id: nid++, name, code, group_letter: letter, flag_url: flag(code) };
        teams.push(t);
        teamIdByName[name] = t.id;
      }
    }
    const placeholderStart = nid;
    for (let i = 0; i < 32; i++) {
      teams.push({ id: nid++, name: `Por definir ${i + 1}`, code: null, group_letter: null, flag_url: null });
    }
    state.teams = teams;

    // Helper para fechas
    const dateAt = (day, hourUtc) => {
      const d = new Date("2026-06-11T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + day);
      d.setUTCHours(hourUtc, 0, 0, 0);
      return d.toISOString();
    };

    // Round-robin: 4 equipos → 6 partidos en 3 rondas
    // Pares: (0v1,2v3) (0v2,3v1) (0v3,1v2)
    const PAIRS = [[0,1],[2,3], [0,2],[3,1], [0,3],[1,2]];
    const matches = [];
    let mid = 1000;

    Object.entries(GROUPS).forEach(([letter, list], gi) => {
      const tids = list.map(([n]) => teamIdByName[n]);
      PAIRS.forEach(([h, a], idx) => {
        const round = Math.floor(idx / 2) + 1;
        // J1: día 0–4, J2: 6–10, J3: 11–15
        const dayBase = round === 1 ? 0 : round === 2 ? 6 : 11;
        const day = dayBase + (gi % 4);
        const hour = 15 + ((gi + idx) % 4) * 3;

        // Variedad de estados:
        let status = "scheduled", hs = null, as = null;
        if (letter === "A" && round === 1) { status = "finished"; hs = idx === 0 ? 2 : 1; as = idx === 0 ? 1 : 1; }
        else if (letter === "B" && round === 1 && idx === 0) { status = "live"; hs = 1; as = 0; }
        else if (letter === "C" && round === 1) { status = "finished"; hs = 3; as = 0; }

        matches.push({
          id: mid++, stage: "Group Stage", group_letter: letter,
          round_label: `Fase de Grupos · Jornada ${round}`,
          kickoff_at: dateAt(day, hour),
          home_team_id: tids[h], away_team_id: tids[a],
          home_score: hs, away_score: as, status,
        });
      });
    });

    // Knockout — usa placeholder teams (TBD)
    const ph = (i) => placeholderStart + (i % 32);
    const ko = (count, stage, label, day0, daySpan) => {
      for (let i = 0; i < count; i++) {
        const day = day0 + Math.floor((i / count) * daySpan);
        const hour = 15 + (i % 3) * 4;
        matches.push({
          id: mid++, stage, group_letter: null, round_label: label,
          kickoff_at: dateAt(day, hour),
          home_team_id: ph(i * 2), away_team_id: ph(i * 2 + 1),
          home_score: null, away_score: null, status: "scheduled",
        });
      }
    };
    ko(16, "Round of 32", "Treintaidosavos", 16, 4);  // jun 27–30
    ko(8,  "Round of 16", "Octavos de Final", 23, 4); // jul 4–7
    ko(4,  "Quarter-finals", "Cuartos de Final", 28, 4); // jul 9–12
    ko(2,  "Semi-finals", "Semifinales", 33, 2);      // jul 14–15
    ko(1,  "Third Place", "Tercer Puesto", 37, 1);    // jul 18
    ko(1,  "Final", "Final", 38, 1);                  // jul 19

    state.matches = matches;

    // Sesión + perfil
    state.session = { user: { id: "dev-00000000-0000-0000-0000-000000000001" } };
    state.profile = {
      id: state.session.user.id,
      name: formName || "Andrés Sentis",
      email: formEmail || "dev@local",
    };

    // Predicciones de ejemplo: algunas con puntos cargados, otras pendientes
    const userId = state.session.user.id;
    state.predictions = new Map();
    const findMatch = (gl, round, idx) =>
      matches.find(m => m.group_letter === gl && m.round_label === `Fase de Grupos · Jornada ${round}` && matches.indexOf(m) % 2 === idx);
    // Pick exacto en finalizado (3 pts)
    state.predictions.set(matches[0].id, { id: "p1", user_id: userId, match_id: matches[0].id, home_score: 2, away_score: 1, points_awarded: 3 });
    // Pick con resultado correcto, marcador errado (1 pt)
    state.predictions.set(matches[1].id, { id: "p2", user_id: userId, match_id: matches[1].id, home_score: 2, away_score: 0, points_awarded: 1 });
    // Pick errado en finalizado (0 pts)
    const cFinished = matches.filter(m => m.group_letter === "C" && m.status === "finished")[0];
    if (cFinished) state.predictions.set(cFinished.id, { id: "p3", user_id: userId, match_id: cFinished.id, home_score: 0, away_score: 1, points_awarded: 0 });
    // Live match con predicción
    const live = matches.find(m => m.status === "live");
    if (live) state.predictions.set(live.id, { id: "p4", user_id: userId, match_id: live.id, home_score: 2, away_score: 1 });
    // Algunas predicciones futuras
    matches.filter(m => m.status === "scheduled").slice(0, 8).forEach((m, i) => {
      state.predictions.set(m.id, { id: `pf-${i}`, user_id: userId, match_id: m.id, home_score: (i + 1) % 4, away_score: i % 3 });
    });

    state.bonus = { user_id: userId, champion_team_id: teamIdByName["Argentina"], runner_up_team_id: teamIdByName["France"], points_awarded: null };
    state.totalPoints = 4;
    state.leaderboard = [
      { user_id: "u-2", name: "Mariano Rey", total_points: 18, exact_count: 4, graded_count: 12 },
      { user_id: "u-3", name: "David Grandes", total_points: 14, exact_count: 2, graded_count: 12 },
      { user_id: "u-5", name: "Roberto Guerrero", total_points: 9, exact_count: 1, graded_count: 12 },
      { user_id: userId, name: state.profile.name, total_points: 4, exact_count: 1, graded_count: 4 },
      { user_id: "u-4", name: "Cristian Adamo", total_points: 2, exact_count: 0, graded_count: 12 },
    ];
    state.activeTab = "A";
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
    if (IS_DEV) {
      render();
      return;
    }
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

    if (IS_DEV) {
      loadMockData(name, email);
      render();
      return;
    }

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
    if (IS_DEV) {
      Object.assign(state, {
        session: null, profile: null, teams: [], matches: [],
        predictions: new Map(), bonus: null, leaderboard: [],
        totalPoints: 0, activeTab: null, modalOpen: null,
      });
      render();
      return;
    }
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

    if (IS_DEV) {
      state.predictions.set(matchId, {
        user_id: state.session.user.id, match_id: matchId,
        home_score: home, away_score: away,
      });
      state.saving.delete(matchId);
      render();
      return;
    }

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
      // Diagnostic flash: incluye uid, match_id, válido, todo en el mismo mensaje
      let diag = "";
      try {
        const sess = (await state.supabase.auth.getSession()).data.session;
        const sUid = sess?.user?.id?.slice(0, 8) || "NULL";
        const stUid = state.session?.user?.id?.slice(0, 8) || "NULL";
        const exp = sess?.expires_at ? Math.round((sess.expires_at * 1000 - Date.now()) / 60000) : "?";
        // Verifica si el match existe en la base (con la sesión actual)
        const { data: m } = await state.supabase.from("matches").select("id, kickoff_at, status").eq("id", matchId).maybeSingle();
        const mStatus = m ? `${m.status}, kick=${m.kickoff_at?.slice(0,16)}` : "NOT-FOUND";
        diag = ` [sUid=${sUid} stUid=${stUid} expMin=${exp} mid=${matchId} m=${mStatus}]`;
      } catch (e) {
        diag = ` [diag-err: ${e.message}]`;
      }
      setFlash("error", `No se pudo guardar: ${error.message}${diag}`);
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

    if (IS_DEV) {
      state.bonus = {
        user_id: state.session.user.id,
        champion_team_id: champion,
        runner_up_team_id: runnerUp,
      };
      setFlash("success", "Bonus guardados (dev mock).");
      return;
    }

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
    // Preservar focus + posición del cursor a través de re-renders
    const ae = document.activeElement;
    const focusKey = ae && ae.dataset && ae.dataset.pred && ae.dataset.match
      ? { pred: ae.dataset.pred, match: ae.dataset.match, selStart: ae.selectionStart, selEnd: ae.selectionEnd }
      : null;

    if (!state.session) {
      root.innerHTML = renderAuth();
      bindAuth();
      lastAnimatedTab = null;
      return;
    }
    root.innerHTML = renderApp();
    bindApp();

    // Animar cards solo al cambiar de tab
    if (state.activeTab !== lastAnimatedTab) {
      lastAnimatedTab = state.activeTab;
      animateTabContent();
    }

    // Re-iniciar countdown si hay DOM nuevo (los _odo de los elementos viejos se perdieron)
    if (root.querySelector("[data-countdown]")) {
      startCountdown();
    }

    // Restaurar focus si estaba en un input de predicción
    if (focusKey) {
      const el = root.querySelector(`[data-pred="${focusKey.pred}"][data-match="${focusKey.match}"]`);
      if (el) {
        el.focus();
        try { el.setSelectionRange(focusKey.selStart, focusKey.selEnd); } catch (_) {}
      }
    }
  }

  function animateTabContent() {
    if (!window.gsap) return;
    const cards = root.querySelectorAll(".esmet-match, .esmet-bonus");
    if (cards.length === 0) return;
    window.gsap.fromTo(
      cards,
      { y: 16, opacity: 0 },
      {
        y: 0,
        opacity: 1,
        duration: 0.4,
        // amount = stagger total distribuido entre todos los cards.
        // Para 6 cards de un grupo: ~0.12s entre cada. Para 16 cards de R32: ~0.05s entre cada.
        // Si querés stagger fijo "cada card", reemplazá por: stagger: 0.2
        stagger: { amount: 0.7, from: "start" },
        ease: "power2.out",
        overwrite: true,
      }
    );
  }

  function renderAuth() {
    const flash = renderFlash();
    return `
      <div class="esmet-auth">
        <h2>Crea tu cuenta</h2>
        <p>Predicciones del Mundial 2026 con ranking en vivo.</p>
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

    const groupTab = (g) =>
      `<button class="esmet-tab esmet-tab--letter" role="tab" aria-selected="${state.activeTab === g}" data-tab="${g}">${g}</button>`;
    const wideTab = (id, label) =>
      `<button class="esmet-tab" role="tab" aria-selected="${state.activeTab === id}" data-tab="${id}">${label}</button>`;

    return `
      ${renderCountdown()}
      ${renderUserbar()}
      ${renderFlash()}
      <div class="esmet-tabs" role="tablist">
        ${groups.length > 0 ? '<span class="esmet-tabs__label">Grupo:</span>' : ""}
        ${groups.map(groupTab).join("")}
        ${(hasKnockout || true) && groups.length > 0 ? '<span class="esmet-tabs__sep" aria-hidden="true">|</span>' : ""}
        ${hasKnockout ? wideTab("knockout", "Eliminatorias") : ""}
        ${wideTab("bonus", "Bonus")}
      </div>
      ${renderTabContent()}
      ${renderFooter()}
      ${renderModal()}
    `;
  }

  // Inicio del Mundial 2026: 11 de junio, 19:00 UTC (kickoff Mexico vs Sudáfrica)
  const TOURNAMENT_START_MS = Date.parse("2026-06-11T19:00:00Z");

  function renderCountdown() {
    if (Date.now() >= TOURNAMENT_START_MS) return ""; // post-Mundial: nada
    return `
      <div class="esmet-countdown" data-countdown>
        <div class="esmet-countdown__caption">Faltan para el Mundial</div>
        <div class="esmet-countdown__grid">
          <div class="esmet-countdown__cell">
            <span class="esmet-countdown__num" data-cd="days">0</span>
            <span class="esmet-countdown__label">Días</span>
          </div>
          <div class="esmet-countdown__cell">
            <span class="esmet-countdown__num" data-cd="hours">0</span>
            <span class="esmet-countdown__label">Horas</span>
          </div>
          <div class="esmet-countdown__cell">
            <span class="esmet-countdown__num" data-cd="minutes">0</span>
            <span class="esmet-countdown__label">Min</span>
          </div>
          <div class="esmet-countdown__cell">
            <span class="esmet-countdown__num" data-cd="seconds">0</span>
            <span class="esmet-countdown__label">Seg</span>
          </div>
        </div>
      </div>
    `;
  }

  function startCountdown() {
    const setVal = (key, val) => {
      const el = root.querySelector(`[data-cd="${key}"]`);
      if (!el) return;
      if (window.Odometer) {
        if (!el._odo) {
          el._odo = new window.Odometer({ el, value: val, format: "d", duration: 800 });
        } else {
          el._odo.update(val);
        }
      } else {
        el.textContent = val;
      }
    };
    const tick = () => {
      const diff = TOURNAMENT_START_MS - Date.now();
      if (diff <= 0) {
        if (state.countdownInterval) {
          clearInterval(state.countdownInterval);
          state.countdownInterval = null;
        }
        if (root.querySelector("[data-countdown]")) render();
        return;
      }
      setVal("days", Math.floor(diff / 86400000));
      setVal("hours", Math.floor((diff / 3600000) % 24));
      setVal("minutes", Math.floor((diff / 60000) % 60));
      setVal("seconds", Math.floor((diff / 1000) % 60));
    };
    tick();
    if (state.countdownInterval) clearInterval(state.countdownInterval);
    state.countdownInterval = setInterval(tick, 1000);
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
    } else if (saving) {
      statusBlock = `<div class="esmet-match__status"><span>Guardando…</span></div>`;
    } else if (pred) {
      statusBlock = `<div class="esmet-match__status"><span>✓ Predicción guardada</span></div>`;
    } else {
      statusBlock = "";
    }

    const homeVal = pred?.home_score ?? "";
    const awayVal = pred?.away_score ?? "";

    return `
      <div class="esmet-match ${locked ? "esmet-match--locked" : ""}" data-match-card="${m.id}">
        <div class="esmet-match__meta">
          <span>${escape(fmtDate(m.kickoff_at))}</span>
        </div>
        <div class="esmet-match__team esmet-match__team--home">${flag(home)}<span>${teamName(home)}</span></div>
        <input class="esmet-input esmet-match__score esmet-match__score--home" type="number" min="0" max="20" inputmode="numeric"
               value="${homeVal}" data-pred="home" data-match="${m.id}" ${locked ? "disabled" : ""} aria-label="Goles ${teamName(home)}">
        <span class="esmet-match__sep" aria-hidden="true">vs</span>
        <input class="esmet-input esmet-match__score esmet-match__score--away" type="number" min="0" max="20" inputmode="numeric"
               value="${awayVal}" data-pred="away" data-match="${m.id}" ${locked ? "disabled" : ""} aria-label="Goles ${teamName(away)}">
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
    // Auto-save por partido (debounce 250ms) + auto-advance al siguiente input (450ms)
    const debounce = new Map();
    const advanceTimer = new Map();

    function advanceFrom(inputEl) {
      // Re-find por si el DOM fue reemplazado tras un render
      const live = root.querySelector(`[data-pred="${inputEl.dataset.pred}"][data-match="${inputEl.dataset.match}"]`);
      if (!live || document.activeElement !== live) return;
      const allInputs = Array.from(root.querySelectorAll("[data-pred]:not([disabled])"));
      const idx = allInputs.indexOf(live);
      const next = allInputs[idx + 1];
      if (!next) return;
      next.focus();
      if (next.select) next.select();
      next.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    function gotoPrev(inputEl) {
      const allInputs = Array.from(root.querySelectorAll("[data-pred]:not([disabled])"));
      const idx = allInputs.indexOf(inputEl);
      const prev = allInputs[idx - 1];
      if (!prev) return;
      prev.focus();
      if (prev.select) prev.select();
      prev.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    root.querySelectorAll("[data-pred]").forEach((input) => {
      input.addEventListener("input", () => {
        const matchId = parseInt(input.dataset.match, 10);

        // save: 250ms idle
        clearTimeout(debounce.get(matchId));
        debounce.set(matchId, setTimeout(() => savePrediction(matchId), 250));

        // auto-advance: 450ms idle (más largo que save → save dispara primero si ambos firan)
        clearTimeout(advanceTimer.get(input));
        if (input.value.length >= 1) {
          advanceTimer.set(input, setTimeout(() => advanceFrom(input), 450));
        }
      });

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === "ArrowRight") {
          e.preventDefault();
          clearTimeout(advanceTimer.get(input));
          advanceFrom(input);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          gotoPrev(input);
        }
      });
    });
  }

  init().catch((err) => {
    console.error(err);
    root.innerHTML = `<div class="esmet-error">Error al iniciar el widget: ${escape(err.message)}</div>`;
  });
})();
