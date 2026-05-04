// Edge Function: sync-matches
// Sincroniza partidos del Mundial 2026 desde ESPN (API pública sin auth) a la tabla `matches`.
// Programar como cron cada 10 min en pg_cron.
//
// Auth de invocación: Authorization: Bearer <CRON_SECRET>
// Variables de entorno:
//   CRON_SECRET                    — random shared secret entre el cron y la función
//   SUPABASE_URL                   — auto-inyectada
//   SUPABASE_SERVICE_ROLE_KEY      — auto-inyectada (para escribir en la base)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=200";
const STANDINGS_URL =
  "https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings";

// ESPN status.type.name → nuestro status
const STATUS_MAP: Record<string, string> = {
  STATUS_SCHEDULED: "scheduled",
  STATUS_IN_PROGRESS: "live",
  STATUS_HALFTIME: "live",
  STATUS_END_OF_PERIOD: "live",
  STATUS_FIRST_HALF: "live",
  STATUS_SECOND_HALF: "live",
  STATUS_FULL_TIME: "finished",
  STATUS_FINAL: "finished",
  STATUS_PENALTIES: "live",
  STATUS_END_OF_EXTRATIME: "live",
  STATUS_POSTPONED: "postponed",
  STATUS_CANCELED: "postponed",
  STATUS_ABANDONED: "postponed",
};

// Etapa de knockout por fecha (calendario oficial WC 2026).
// Solo se usa cuando el partido NO es de fase de grupos (el groupLetter lo determinamos
// por el equipo, no por fecha — porque la última jornada de algunos grupos cae el 27/28 jun
// en UTC y se confundía con Round of 32).
function determineKnockoutStage(date: string): { stage: string; round_label: string } {
  const d = date.slice(0, 10); // "YYYY-MM-DD"
  if (d <= "2026-07-03") return { stage: "Round of 32", round_label: "Treintaidosavos" };
  if (d <= "2026-07-08") return { stage: "Round of 16", round_label: "Octavos de Final" };
  if (d <= "2026-07-13") return { stage: "Quarter-finals", round_label: "Cuartos de Final" };
  if (d <= "2026-07-17") return { stage: "Semi-finals", round_label: "Semifinales" };
  if (d === "2026-07-18") return { stage: "Third Place", round_label: "Tercer Puesto" };
  return { stage: "Final", round_label: "Final" };
}

Deno.serve(async (req) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  const auth = req.headers.get("Authorization") ?? "";
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return new Response("forbidden", { status: 403 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  // Early-exit: si ya sincronizamos hace poco, evitar llamadas innecesarias a ESPN.
  // Pre-Mundial / Post-Mundial: 1 vez cada 24h. Durante el Mundial: 1 vez cada 5 min.
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  if (!force) {
    const now = Date.now();
    const tournamentStart = Date.parse("2026-06-04T00:00:00Z"); // ~1 semana antes del kickoff
    const tournamentEnd = Date.parse("2026-07-20T00:00:00Z");
    const tournamentActive = now >= tournamentStart && now <= tournamentEnd;
    const minIntervalMs = tournamentActive ? 5 * 60 * 1000 : 24 * 60 * 60 * 1000;

    const { data: lastRow } = await supabase
      .from("matches")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1);
    if (lastRow?.[0]) {
      const lastSyncedMs = Date.parse(lastRow[0].updated_at);
      if (now - lastSyncedMs < minIntervalMs) {
        return new Response(
          JSON.stringify({
            skipped: true,
            reason: tournamentActive ? "synced within last 5min" : "synced within last 24h",
            last_sync_at: lastRow[0].updated_at,
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      }
    }
  }

  // 1) Standings → mapa team_id → group_letter
  const standRes = await fetch(STANDINGS_URL);
  if (!standRes.ok) return new Response(`espn standings: ${standRes.status}`, { status: 502 });
  const stand = await standRes.json();
  const teamGroup = new Map<number, string>(); // team.id (numérico) → "A".."L"
  for (const child of stand.children ?? []) {
    const m = (child.name ?? "").match(/Group ([A-L])/i);
    if (!m) continue;
    const letter = m[1].toUpperCase();
    for (const entry of child.standings?.entries ?? []) {
      const tid = parseInt(entry.team?.id, 10);
      if (!isNaN(tid)) teamGroup.set(tid, letter);
    }
  }

  // 2) Scoreboard → todos los fixtures del Mundial
  const sbRes = await fetch(SCOREBOARD_URL);
  if (!sbRes.ok) return new Response(`espn scoreboard: ${sbRes.status}`, { status: 502 });
  const sb = await sbRes.json();
  const events: any[] = sb.events ?? [];

  // 3) Construir teams + matches
  const teamsMap = new Map<number, { id: number; name: string; code: string | null; flag_url: string | null; group_letter: string | null }>();
  const matchRows: any[] = [];

  for (const e of events) {
    const comp = e.competitions?.[0];
    if (!comp) continue;
    const competitors = comp.competitors ?? [];
    if (competitors.length < 2) continue;

    const home = competitors.find((c: any) => c.homeAway === "home");
    const away = competitors.find((c: any) => c.homeAway === "away");
    if (!home || !away) continue;

    for (const c of [home, away]) {
      const tid = parseInt(c.team?.id, 10);
      if (isNaN(tid)) continue;
      if (!teamsMap.has(tid)) {
        teamsMap.set(tid, {
          id: tid,
          name: c.team?.displayName ?? "TBD",
          code: c.team?.abbreviation ?? null,
          flag_url: c.team?.logo || null,
          group_letter: teamGroup.get(tid) ?? null,
        });
      }
    }

    const homeId = parseInt(home.team?.id, 10);
    const awayId = parseInt(away.team?.id, 10);
    // Si el home team está en standings (= en un grupo), es fase de grupos.
    // Si no (placeholder de knockout), determinamos la etapa por fecha.
    const groupLetter = teamGroup.get(homeId) ?? null;
    let stage: string, round_label: string;
    if (groupLetter) {
      stage = "Group Stage";
      round_label = "Fase de Grupos";
    } else {
      ({ stage, round_label } = determineKnockoutStage(e.date));
    }

    const statusName = e.status?.type?.name ?? "STATUS_SCHEDULED";
    const status = STATUS_MAP[statusName] ?? "scheduled";
    const homeScore = parseInt(home.score, 10);
    const awayScore = parseInt(away.score, 10);

    matchRows.push({
      id: parseInt(e.id, 10),
      stage,
      group_letter: groupLetter,
      round_label,
      kickoff_at: e.date,
      home_team_id: isNaN(homeId) ? null : homeId,
      away_team_id: isNaN(awayId) ? null : awayId,
      home_score: status === "scheduled" ? null : isNaN(homeScore) ? null : homeScore,
      away_score: status === "scheduled" ? null : isNaN(awayScore) ? null : awayScore,
      status,
    });
  }

  if (teamsMap.size > 0) {
    const { error } = await supabase
      .from("teams")
      .upsert([...teamsMap.values()], { onConflict: "id" });
    if (error) return new Response(`team upsert: ${error.message}`, { status: 500 });
  }

  // Detectar partidos recién finalizados (status anterior != finished)
  const { data: prev } = await supabase
    .from("matches")
    .select("id, status")
    .in("id", matchRows.map((m) => m.id));
  const prevStatus = new Map((prev ?? []).map((p) => [p.id, p.status]));

  const { error: matchErr } = await supabase
    .from("matches")
    .upsert(matchRows, { onConflict: "id" });
  if (matchErr) return new Response(`match upsert: ${matchErr.message}`, { status: 500 });

  const newlyFinished = matchRows.filter(
    (m) => m.status === "finished" && prevStatus.get(m.id) !== "finished"
  );

  // Disparar scoring para los recién finalizados
  for (const m of newlyFinished) {
    const r = await fetch(`${supabaseUrl}/functions/v1/score-matches`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cronSecret}`,
      },
      body: JSON.stringify({ match_id: m.id }),
    });
    if (!r.ok) console.error(`score-matches failed for ${m.id}: ${await r.text()}`);
  }

  return new Response(
    JSON.stringify({
      events: events.length,
      teams: teamsMap.size,
      matches: matchRows.length,
      newly_finished: newlyFinished.length,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
});
