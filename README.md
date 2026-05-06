# Fixture/Polla embebible — playbook para replicar

Esta es una polla de predicciones de un torneo deportivo, embebida en Webflow. Los usuarios se registran (magic link, sin password), predicen marcadores partido por partido, suman puntos según un sistema (3 exacto / 1 resultado / 0 errado + bonus campeón/finalista) y compiten en un ranking en tiempo real.

**El repo está armado para que puedas forkearlo y adaptarlo a CUALQUIER torneo deportivo** que tenga datos en ESPN: Champions, Eurocopa, Copa América, Mundial Femenino, Liga local, NBA Playoffs, etc.

> **Tiempo estimado para replicarlo a otro torneo**:
> - 2–3 horas si ya hiciste este patrón una vez.
> - 4–6 horas la primera vez (la mayoría es esperar verificación DNS + setup inicial de Supabase).

---

## 1. Qué hereda y qué cambia entre fixtures

### Heredás idéntico (no tocás nada)

- ✅ Schema completo de DB (`profiles`, `teams`, `matches`, `predictions`, `bonus_predictions`, vista `leaderboard`).
- ✅ RLS policies (lock por kickoff, etc).
- ✅ Trigger `handle_new_user` (crea profile cuando alguien se registra).
- ✅ Frontend completo (`widget.js`, `widget.css`, `tokens.css`):
  - Auth con magic link + lock bypass
  - Cache localStorage con stale-while-revalidate
  - Skeleton screen pre-renderizado
  - bfcache / visibilitychange handlers
  - Auto-advance focus en mobile
  - GSAP stagger al cambiar tabs
  - Odometer countdown con 2 dígitos siempre
  - Modal del ranking
  - Bonus picks (campeón / finalista)
- ✅ Edge functions:
  - `sync-matches` (cron-friendly con early-exit)
  - `score-matches` (calcula puntos)
- ✅ Sistema de scoring: 3 exacto / 1 resultado / 0 errado / 10 campeón / 5 finalista.

### Cambiás entre fixtures

1. **Datos del torneo** (fechas, deporte/liga en ESPN, knockout cutoffs).
2. **Branding** (nombre, colores, font, logo, copy del countdown y del título).
3. **Credenciales** (nuevo Supabase project, nuevo dominio Resend, nuevo repo GitHub si querés).

---

## 2. Antes de arrancar: 3 checks rápidos

### Check 1 — ¿ESPN tiene tu torneo?

```bash
# Reemplazá {sport}, {league} y dates por los del torneo target
curl -sS "https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard?dates=20270601-20270731&limit=200" \
  | python3 -c "import sys,json; print('events:', len(json.load(sys.stdin).get('events', [])))"
```

Tiene que devolver > 0 events. Si devuelve 0, prueba con otro rango de fechas o liga.

**URLs típicas de ESPN**:
| Torneo | URL slug |
|---|---|
| Mundial FIFA | `soccer/fifa.world` |
| Champions League | `soccer/uefa.champions` |
| Eurocopa | `soccer/uefa.euro` |
| Copa América | `soccer/conmebol.america` |
| Premier League | `soccer/eng.1` |
| LaLiga | `soccer/esp.1` |
| Liga Argentina | `soccer/arg.1` |
| MLS | `soccer/usa.1` |
| NBA Playoffs | `basketball/nba` |
| NFL Playoffs | `football/nfl` |

### Check 2 — ¿ESPN tiene standings de grupos?

```bash
curl -sS "https://site.api.espn.com/apis/v2/sports/{sport}/{league}/standings" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('groups:', [c['name'] for c in d.get('children',[])][:15])"
```

Si devuelve grupos (e.g., `["Group A", "Group B", ...]`), el sync va a auto-asignar `group_letter` ✓.

Si devuelve un solo bracket o tabla única (típico de Champions, Eurocopa fase de eliminatorias), no hay grupos — todo va a tab "Eliminatorias", no hay tabs por grupo. La UI se adapta sola.

### Check 3 — ¿Tenés dominio para emails brandeados?

- **Sí (`fixture@cliente.com`)** → 15 min de setup en Resend, mejor UX.
- **No** → arrancá con SMTP default de Supabase (rate limit 4/hora). Para una acción comercial chica con < 30 usuarios concurrentes, va.

---

## 3. Inicio rápido — 7 pasos

### Paso 1 — Forkear el repo

```bash
git clone https://github.com/tioass/esmet-fixture-2026 mi-nuevo-fixture
cd mi-nuevo-fixture
rm -rf .git
git init
gh repo create mi-nuevo-fixture --public --source=. --push
```

### Paso 2 — Adaptar las variables del torneo

Editá los archivos siguientes con los valores nuevos. **Es la parte específica de cada torneo**.

#### `widget.js`

| Buscar | Reemplazar con |
|---|---|
| `TOURNAMENT_START_MS = Date.parse("2026-06-11T19:00:00Z")` | la fecha+hora UTC del partido inaugural |
| `Faltan para el Mundial` | `Faltan para [tu torneo]` |
| `Fixture del Mundial 2026 con ranking en vivo.` | tu copy de auth subtitle |
| `Crea tu cuenta` | título del auth screen (probablemente igual) |
| Mock data de los 12 grupos | adaptar al nuevo torneo (solo se usa en dev mode local) |

#### `supabase/functions/sync-matches/index.ts`

| Línea | Original | Cambiar a |
|---|---|---|
| `SCOREBOARD_URL` | `.../soccer/fifa.world/scoreboard?dates=20260611-20260719` | URL+fechas de tu torneo |
| `STANDINGS_URL` | `.../soccer/fifa.world/standings` | URL de standings de tu torneo |
| `tournamentStart` | `2026-06-04T00:00:00Z` | ~1 semana antes del kickoff |
| `tournamentEnd` | `2026-07-20T00:00:00Z` | ~1 día después de la final |
| `determineKnockoutStage()` | fechas de cutoff del Mundial 2026 | fechas de tu calendario de eliminatorias |

#### `tokens.css`

Las variables de marca: `--esmet-black`, `--esmet-rojo`, `--esmet-beige`, etc. Cambialas a la paleta del cliente nuevo. **Mantené los nombres** (no renombres `--esmet-` a `--otro-`) porque widget.css usa esos nombres.

(Opcional) renombrar el prefijo del CSS de `esmet-` a otra marca: hacé un find/replace global en widget.css y widget.js. ~50 ocurrencias. Lleva 3 minutos.

#### `widget.css`

Si querés font diferente, cambiá el `@font-face` de Alliance No. Si seguís en Webflow, podés copiar la URL del font del CDN de Webflow del cliente nuevo (mirá `cdn.prod.website-files.com/{site-id}/...otf`).

### Paso 3 — Crear nuevo proyecto Supabase

1. https://supabase.com → New project (region South America – São Paulo).
2. **SQL Editor → New query** → pegar TODO el contenido de [`supabase/schema.sql`](./supabase/schema.sql) → Run.
3. **Authentication → Providers → Email** → desactivar **"Confirm email"** (queremos magic link directo).
4. **Authentication → URL Configuration**:
   - **Site URL**: la URL de producción donde va a vivir el embed.
   - **Redirect URLs**: agregar staging + producción + (si vas a hacer dev local) `http://localhost:8765/**`.
5. **Authentication → Email Templates → Magic Link**:
   - Subject: `Tu link para entrar al [Nombre del fixture]`
   - Body: copiá [`supabase/email-templates/magic-link.html`](./supabase/email-templates/magic-link.html), adaptá copy y colores. **Sacá el comentario HTML del top** (no se renderiza pero queda feo en algunos clientes).

### Paso 4 — Setup de SMTP custom (Resend)

Si saltás esto, los emails van a salir de `noreply@mail.app.supabase.io` y vas a tener rate limit de 4/hora.

1. https://resend.com → Sign up.
2. **Domains → Add Domain** → tu dominio (`cliente.com`). Te da 3 records DNS.
3. **Pegar los 3 records DNS** en el proveedor del cliente. Importante: van todos en **subdominios** (`resend._domainkey.cliente.com`, `send.cliente.com`), no tocan el MX root → no afecta los emails actuales del cliente.
   - **Donweb / Plesk**: nombre completo del subdominio (ej: `send.cliente.com.ar`), TTL 3600, prioridad 0 para TXT y 10 para MX.
   - **Cloudflare / GoDaddy / Namecheap**: poner solo la parte corta (`send`), el panel autocompleta.
4. Esperar 5–60 min para propagación. Click **Verify** en Resend hasta que se ponga verde.
5. **API Keys → Create API Key** → name `supabase-smtp`, permission `sending_access`, scope al dominio.
6. **Supabase → Authentication → Emails → SMTP Settings → Set up SMTP**:

| Campo | Valor |
|---|---|
| Sender email | `fixture@cliente.com` |
| Sender name | tu marca |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | la API key |

### Paso 5 — Deploy de Edge Functions

```bash
# CLI (si no lo tenés instalado): brew install supabase/tap/supabase
supabase login --token sbp_...   # generar en supabase.com/dashboard/account/tokens
supabase link --project-ref xxx  # el ref del nuevo proyecto

# Generar y guardar un cron secret nuevo (no reusar el del fixture anterior)
CRON_SECRET=$(openssl rand -hex 32)
supabase secrets set CRON_SECRET=$CRON_SECRET

# Deploy ambas functions
supabase functions deploy sync-matches --no-verify-jwt
supabase functions deploy score-matches --no-verify-jwt

# Disparar un sync inicial para poblar la base
curl -sS -X POST "https://xxx.supabase.co/functions/v1/sync-matches?force=1" \
  -H "Authorization: Bearer $CRON_SECRET"
# Debería devolver: {"events": N, "teams": M, "matches": N}
```

### Paso 6 — Programar el cron

En **Supabase → SQL Editor**, ejecutar (reemplazando `xxx` y el secret):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'sync-matches-job') then
    perform cron.unschedule('sync-matches-job');
  end if;
end $$;

select cron.schedule(
  'sync-matches-job',
  '*/10 * * * *',
  $job$
  select net.http_post(
    url := 'https://xxx.supabase.co/functions/v1/sync-matches',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer EL_CRON_SECRET_DEL_PASO_5'
    )
  );
  $job$
);
```

### Paso 7 — Pegar embed en Webflow

Tomá la SHA del último commit del repo:
```bash
git rev-parse --short HEAD
# → e58bbc0 (por ejemplo)
```

Editá [`webflow-embed.html`](./webflow-embed.html):
- Reemplazá los `@SHA` por la SHA actual
- Reemplazá `supabaseUrl` y `supabaseAnonKey` por los del nuevo proyecto Supabase

Pegá el bloque entero en un Embed (HTML) en el `<main>` de la página de Webflow. Publicá.

---

## 4. Variables clave en una sola tabla (cheat sheet)

Si querés saber QUÉ archivo tocar para QUÉ cosa:

| Cambio | Archivo | Buscar |
|---|---|---|
| Fecha de inicio del torneo (countdown) | `widget.js` | `TOURNAMENT_START_MS` |
| Texto "Faltan para el Mundial" | `widget.js` | `"Faltan para el Mundial"` |
| Liga + fechas en ESPN | `sync-matches/index.ts` | `SCOREBOARD_URL`, `STANDINGS_URL` |
| Fechas de etapas knockout | `sync-matches/index.ts` | `determineKnockoutStage()` |
| Ventana de "torneo activo" para early-exit del cron | `sync-matches/index.ts` | `tournamentStart`, `tournamentEnd` |
| Sistema de puntos | `score-matches/index.ts` | `pointsFor()` (3/1/0) y bonus (10/5) |
| Colores de marca | `tokens.css` | `--esmet-*` (rojo, beige, neutrals) |
| Font (URL) | `widget.css` | `@font-face` (URL de Webflow CDN) |
| Subject del email magic link | Supabase dashboard | Authentication → Email Templates |
| Body del email | `supabase/email-templates/magic-link.html` (copiar al dashboard) | — |
| Sender de emails | Supabase dashboard | Authentication → Emails → SMTP Settings |
| Reglas RLS (lock por kickoff) | `supabase/schema.sql` | `predictions_insert_own_before_kickoff` |
| URLs permitidas para magic link redirect | Supabase dashboard | Authentication → URL Configuration |

---

## 5. Adaptaciones por escenario

### Si tu torneo es un knockout puro (Champions, Copa Libertadores avanzada)

- ESPN standings probablemente devuelve un solo bracket, no grupos por letra.
- El widget detecta: si no hay matches con `group_letter`, **no muestra tabs por grupo, solo "Eliminatorias"**.
- En `determineKnockoutStage()`, ajustá los rangos de fecha. Por ejemplo Champions:
  - Round of 16: feb–mar
  - Quarter-finals: abr
  - Semi-finals: abr–may
  - Final: may–jun

### Si tu torneo no está en ESPN

Buscás otra API y reescribís `sync-matches/index.ts`. La interfaz que el widget espera de la base es:

```sql
matches: id, stage, group_letter, round_label, kickoff_at, home_team_id, away_team_id, home_score, away_score, status
teams: id, name, code, flag_url, group_letter
```

Mientras la función `sync-matches` cargue eso correctamente desde tu fuente, todo lo demás funciona igual. Alternativas a ESPN:
- **football-data.org** (free tier, requiere key, no incluye todos los torneos)
- **API-Football** (paga, muy completa)
- **TheSportsDB** (free, datos a veces incompletos)
- **Fixture cargado a mano** (CSV → SQL inserts)

### Si el sistema de puntos es diferente

Editá `score-matches/index.ts`, función `pointsFor()`. Ejemplos:

```ts
// Fútbol estándar (default actual): 3/1/0
function pointsFor(predH, predA, realH, realA) {
  if (predH === realH && predA === realA) return 3;
  return Math.sign(predH - predA) === Math.sign(realH - realA) ? 1 : 0;
}

// Más estricto: solo marcador exacto
function pointsFor(predH, predA, realH, realA) {
  return (predH === realH && predA === realA) ? 1 : 0;
}

// NBA / Tenis (grandes scores): bonificar diferencia cercana
function pointsFor(predH, predA, realH, realA) {
  if (predH === realH && predA === realA) return 5;
  const outcomeOk = Math.sign(predH - predA) === Math.sign(realH - realA);
  if (!outcomeOk) return 0;
  const diff = Math.abs((predH - predA) - (realH - realA));
  return diff <= 5 ? 3 : 1;
}
```

Y los bonus al final del archivo (los 10 + 5 del campeón / finalista).

### Si querés agregar más bonus

Por ejemplo, `goleador del torneo`:

1. Schema: agregar columna `top_scorer_team_id` a `bonus_predictions` y añadir UI en `renderBonus()`.
2. `score-matches`: bonificar cuando se sepa el goleador (manual o vía ESPN).

---

## 6. Cosas que NO toques (a menos que sepas qué hacés)

- **El `lock` no-op en `createClient`**: cuelga la app sin él.
- **El timeout de 3s en `getSession()`**: lo mismo.
- **Cache `stale-while-revalidate` en `loadAppData`**: es lo que hace que tab return sea instantáneo.
- **El skeleton pre-renderizado en el embed**: es lo que evita layout shift.
- **El handler `pageshow` con `event.persisted`**: bfcache restore.
- **El handler `visibilitychange`**: tab return en iOS Safari.
- **El override de transition en odometer (`!important`)**: el theme hardcodea 2s.
- **La estructura de dos odómetros por unidad de countdown**: necesario para zero-padding.
- **`group_letter` derivado del home team, no de la fecha**: maneja casos como el Mundial 2026 donde la jornada 3 cae el 28 jun UTC.

---

## 7. Workflow de iteración

### Dev local (sin internet de Supabase)

```bash
./dev.sh   # python http.server en :8765
```

Abrís http://localhost:8765/dev.html. El widget detecta `localhost` (`IS_DEV=true`):
- Saltea login (carga mock data instantáneo).
- Bypaseá Supabase, render del fixture sobre 12 grupos × 4 equipos × 3 jornadas + knockout TBD.

Sirve para iterar diseño / interacción sin esperar magic links ni hits a Supabase.

⚠️ **macOS + Google Drive**: el sandbox del proceso bloquea acceso al folder. Mové el repo afuera de Google Drive (recomendado) o usá un watcher con rsync a `/tmp/`.

### Cambio + push + producción

```bash
git commit -am "feat: X"
git push
git rev-parse --short HEAD   # → nuevo SHA, ej: a1b2c3d
# Editá webflow-embed.html: reemplazar @<sha-vieja> por @a1b2c3d
git commit -am "Bump embed SHA a a1b2c3d"
git push
# Pegar webflow-embed.html nuevo en el Embed de Webflow
# Click Publish en Webflow
```

**Importante**: usá `@<commit-sha>` específico, no `@main`. jsDelivr cachea `@main` por 12h.

---

## 8. Checklist antes de go-live

- [ ] Edité `TOURNAMENT_START_MS` con la fecha real del partido inaugural.
- [ ] El countdown muestra el tiempo correcto (verificá en dev local).
- [ ] `SCOREBOARD_URL` tiene las fechas correctas y devuelve eventos.
- [ ] `determineKnockoutStage` tiene las fechas de cutoff de mi torneo.
- [ ] Ejecuté el sync con `?force=1` y la base tiene partidos.
- [ ] El cron job está creado y funcionando (`select * from cron.job;`).
- [ ] SMTP custom configurado y verificado con un mail de prueba.
- [ ] Email template del magic link branded.
- [ ] Site URL + Redirect URLs incluyen staging Y producción.
- [ ] "Confirm email" está OFF.
- [ ] Probé el flow completo: registro → magic link → entrar → predecir → cerrar tab → volver → todo OK.
- [ ] Probé el flow en mobile (iPhone Safari y/o Android Chrome).
- [ ] Pegué el embed en Webflow (con la SHA correcta) y publiqué la página.

---

## 9. Errores comunes al replicar

### "El countdown llega a 0 días pero el contenido sigue mostrando el countdown"
Verificá `TOURNAMENT_START_MS` — si está en el pasado, el widget oculta el countdown automáticamente. Si lo dejaste con la fecha del Mundial 2026, en mayo 2027 el componente lo va a esconder.

### "Group J / un grupo específico tiene menos partidos"
Causa típica: la última jornada de ese grupo cae en una fecha que `determineKnockoutStage` clasifica como Round of 32. **Fix ya aplicado**: el `group_letter` se deriva del home team, no de la fecha. Si lo seguís viendo, tirá un `?force=1` al sync.

### "Todos los partidos aparecen en 'Eliminatorias', no hay tabs por grupo"
La standings de ESPN no devolvió grupos. Para torneos sin grupos (Champions de eliminatorias) es esperado. Para un Mundial / Eurocopa, verifica que la URL de standings sea correcta y el torneo esté activo en ESPN.

### "Magic link no llega en mobile"
1. Verificá Authentication → URL Configuration → Site URL incluye el dominio mobile.
2. SMTP custom está configurado (sino el rate limit te jode rápido).
3. Spam folder.

### "Cargando fixture..." no se va aunque haga reload
- ¿Está corriendo el cron? `select * from cron.job_run_details order by start_time desc limit 5;`
- ¿La función responde? `curl -sS -X POST <function-url>?force=1 -H "Authorization: Bearer $CRON_SECRET"`
- ¿Hay datos? `select count(*) from matches;` (vía SQL editor)

### "Las predicciones no se guardan ('row violates RLS')"
- Sesión no está autenticada. Mirá el flash de error: tiene un `[sUid=xxx mid=N m=...]` con diagnóstico.
- O la fecha del partido ya pasó (RLS bloquea inserts después del kickoff).

---

## 10. Estructura del repo (qué hay dónde)

```
.
├── README.md                       ← este archivo
├── widget.js                       ← lógica frontend (IIFE, ~800 líneas)
├── widget.css                      ← estilos
├── tokens.css                      ← variables de marca
├── webflow-embed.html              ← snippet para pegar en Webflow
├── dev.html                        ← preview local (con skeleton)
├── dev.sh                          ← arranca dev server en :8765
└── supabase/
    ├── schema.sql                  ← tablas + RLS + triggers (idempotente)
    ├── email-templates/
    │   └── magic-link.html         ← copiar al dashboard de Supabase
    └── functions/
        ├── sync-matches/
        │   └── index.ts            ← cron-friendly (early-exit)
        └── score-matches/
            └── index.ts            ← scoring (3/1/0 + bonus)
```

---

## 11. Si te quedás trabado

- Issues conocidos y sus fixes están en la sección 9.
- El `widget.js` tiene un sistema de diagnóstico: si init se traba, después de 6s muestra en pantalla en qué paso falló (`wait-supabase`, `get-session`, `load-app-data`, etc).
- Logs de Edge Functions: dashboard Supabase → Edge Functions → tu función → Logs.
- Logs del cron: SQL Editor → `select * from cron.job_run_details order by start_time desc limit 10;`
