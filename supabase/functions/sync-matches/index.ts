// Edge Function: sync-matches
// Sincroniza partidos del Mundial 2026 desde API-Football a la tabla `matches`.
// Programar como cron cada 5–10 minutos en el dashboard de Supabase.
//
// Variables de entorno requeridas:
//   API_FOOTBALL_KEY        — key gratis de https://www.api-football.com/
//   SUPABASE_URL            — auto-inyectada por Supabase
//   SUPABASE_SERVICE_ROLE_KEY — auto-inyectada por Supabase

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// FIFA World Cup 2026 — id de liga en API-Football
const LEAGUE_ID = 1;
const SEASON = 2026;

type Fixture = {
  fixture: {
    id: number;
    date: string;
    status: { short: string };
  };
  league: { round: string };
  teams: {
    home: { id: number; name: string; logo: string };
    away: { id: number; name: string; logo: string };
  };
  goals: { home: number | null; away: number | null };
};

const STATUS_MAP: Record<string, string> = {
  TBD: "scheduled",
  NS: "scheduled",
  "1H": "live",
  HT: "live",
  "2H": "live",
  ET: "live",
  P: "live",
  BT: "live",
  LIVE: "live",
  FT: "finished",
  AET: "finished",
  PEN: "finished",
  PST: "postponed",
  CANC: "postponed",
  ABD: "postponed",
};

function parseStage(round: string): { stage: string; group_letter: string | null } {
  if (/group/i.test(round)) {
    const m = round.match(/Group ([A-L])/i);
    return { stage: "Group Stage", group_letter: m ? m[1].toUpperCase() : null };
  }
  if (/round of 32/i.test(round)) return { stage: "Round of 32", group_letter: null };
  if (/round of 16/i.test(round)) return { stage: "Round of 16", group_letter: null };
  if (/quarter/i.test(round)) return { stage: "Quarter-finals", group_letter: null };
  if (/semi/i.test(round)) return { stage: "Semi-finals", group_letter: null };
  if (/3rd place/i.test(round) || /third place/i.test(round)) return { stage: "Third Place", group_letter: null };
  if (/final/i.test(round)) return { stage: "Final", group_letter: null };
  return { stage: round, group_letter: null };
}

Deno.serve(async () => {
  const apiKey = Deno.env.get("API_FOOTBALL_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!apiKey) return new Response("missing API_FOOTBALL_KEY", { status: 500 });

  const supabase = createClient(supabaseUrl, serviceKey);

  const res = await fetch(
    `https://v3.football.api-sports.io/fixtures?league=${LEAGUE_ID}&season=${SEASON}`,
    { headers: { "x-apisports-key": apiKey } }
  );
  if (!res.ok) {
    return new Response(`api-football error: ${res.status}`, { status: 502 });
  }
  const json = await res.json();
  const fixtures: Fixture[] = json.response ?? [];

  // Upsert teams
  const teamsMap = new Map<number, { id: number; name: string; flag_url: string; group_letter: string | null }>();
  for (const f of fixtures) {
    const { group_letter } = parseStage(f.league.round);
    for (const side of ["home", "away"] as const) {
      const t = f.teams[side];
      if (!teamsMap.has(t.id)) {
        teamsMap.set(t.id, { id: t.id, name: t.name, flag_url: t.logo, group_letter });
      } else if (group_letter && !teamsMap.get(t.id)!.group_letter) {
        teamsMap.get(t.id)!.group_letter = group_letter;
      }
    }
  }
  if (teamsMap.size > 0) {
    const { error: teamErr } = await supabase
      .from("teams")
      .upsert([...teamsMap.values()], { onConflict: "id" });
    if (teamErr) return new Response(`team upsert: ${teamErr.message}`, { status: 500 });
  }

  // Upsert matches + detectar finalizados nuevos
  const matchRows = fixtures.map((f) => {
    const { stage, group_letter } = parseStage(f.league.round);
    return {
      id: f.fixture.id,
      stage,
      group_letter,
      round_label: f.league.round,
      kickoff_at: f.fixture.date,
      home_team_id: f.teams.home.id,
      away_team_id: f.teams.away.id,
      home_score: f.goals.home,
      away_score: f.goals.away,
      status: STATUS_MAP[f.fixture.status.short] ?? "scheduled",
    };
  });

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

  // Disparar scoring para los recién terminados
  for (const m of newlyFinished) {
    const r = await fetch(`${supabaseUrl}/functions/v1/score-matches`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ match_id: m.id }),
    });
    if (!r.ok) console.error(`score-matches failed for ${m.id}: ${await r.text()}`);
  }

  return new Response(
    JSON.stringify({
      fixtures: fixtures.length,
      teams: teamsMap.size,
      newly_finished: newlyFinished.length,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
});
