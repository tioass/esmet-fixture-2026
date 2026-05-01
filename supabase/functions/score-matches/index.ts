// Edge Function: score-matches
// Calcula puntos para todas las predicciones de un partido finalizado, o de todos
// los finalizados que aún no fueron calificados.
//
// Llamadas:
//   POST {} → procesa todos los partidos finished con predicciones sin puntos
//   POST { match_id: 12345 } → procesa solo ese partido
//
// Sistema de puntos:
//   3  marcador exacto
//   1  resultado correcto (gana/empata/pierde)
//   0  errado
//
// Bonus:
//   10  campeón correcto
//    5  finalista correcto

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

function pointsFor(predH: number, predA: number, realH: number, realA: number): number {
  if (predH === realH && predA === realA) return 3;
  const predOutcome = Math.sign(predH - predA);
  const realOutcome = Math.sign(realH - realA);
  return predOutcome === realOutcome ? 1 : 0;
}

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  let matchId: number | null = null;
  if (req.method === "POST") {
    try {
      const body = await req.json();
      matchId = body?.match_id ?? null;
    } catch (_) {
      // sin body → procesar todo
    }
  }

  let matches: { id: number; home_score: number; away_score: number; stage: string }[] = [];
  if (matchId) {
    const { data, error } = await supabase
      .from("matches")
      .select("id, home_score, away_score, stage, status")
      .eq("id", matchId)
      .single();
    if (error) return new Response(error.message, { status: 500 });
    if (data?.status !== "finished") {
      return new Response("match not finished", { status: 400 });
    }
    matches = [data];
  } else {
    const { data, error } = await supabase
      .from("matches")
      .select("id, home_score, away_score, stage")
      .eq("status", "finished");
    if (error) return new Response(error.message, { status: 500 });
    matches = data ?? [];
  }

  let updates = 0;
  for (const m of matches) {
    if (m.home_score == null || m.away_score == null) continue;

    const { data: preds, error: pErr } = await supabase
      .from("predictions")
      .select("id, home_score, away_score, points_awarded")
      .eq("match_id", m.id);
    if (pErr) {
      console.error(`fetch preds ${m.id}: ${pErr.message}`);
      continue;
    }

    for (const p of preds ?? []) {
      const pts = pointsFor(p.home_score, p.away_score, m.home_score, m.away_score);
      if (p.points_awarded === pts) continue;
      const { error: uErr } = await supabase
        .from("predictions")
        .update({ points_awarded: pts })
        .eq("id", p.id);
      if (uErr) console.error(`update pred ${p.id}: ${uErr.message}`);
      else updates++;
    }
  }

  // Bonus: si la final ya está jugada, calcular bonus de todos los users
  const { data: finalMatch } = await supabase
    .from("matches")
    .select("id, home_team_id, away_team_id, home_score, away_score, status")
    .eq("stage", "Final")
    .eq("status", "finished")
    .maybeSingle();

  let bonusUpdates = 0;
  if (finalMatch && finalMatch.home_score != null && finalMatch.away_score != null) {
    const champ =
      finalMatch.home_score > finalMatch.away_score
        ? finalMatch.home_team_id
        : finalMatch.away_team_id;
    const runnerUp =
      finalMatch.home_score > finalMatch.away_score
        ? finalMatch.away_team_id
        : finalMatch.home_team_id;

    const { data: bonuses } = await supabase
      .from("bonus_predictions")
      .select("user_id, champion_team_id, runner_up_team_id, points_awarded");

    for (const b of bonuses ?? []) {
      let pts = 0;
      if (b.champion_team_id === champ) pts += 10;
      if (b.runner_up_team_id === runnerUp) pts += 5;
      if (b.points_awarded === pts) continue;
      const { error } = await supabase
        .from("bonus_predictions")
        .update({ points_awarded: pts })
        .eq("user_id", b.user_id);
      if (!error) bonusUpdates++;
    }
  }

  return new Response(
    JSON.stringify({
      matches_processed: matches.length,
      predictions_updated: updates,
      bonus_updated: bonusUpdates,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
});
