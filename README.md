# Widget embebible en Webflow con backend Supabase — Playbook

Documentación + plantilla mental para replicar este proyecto (o uno parecido) en otro contexto. Capturo el stack, las decisiones de arquitectura, los patrones de código que vale la pena reusar y los errores que ya pagué.

> Este repo es una implementación concreta de un fixture del Mundial 2026 embebido en Webflow. Pero el patrón sirve para cualquier widget interactivo con auth, base de datos compartida y datos sincronizados desde una API externa, montado en un sitio Webflow / Wix / WordPress / cualquier shell estático.

---

## 1. Cuándo usar este enfoque

✅ **Sí**:
- Necesitás interacciones con persistencia (login, predicciones, votos, formularios complejos) sobre un sitio que ya está en Webflow / similar.
- Querés costo cero o casi cero (free tier).
- El público es chico-mediano (decenas a miles de usuarios).
- No hay equipo de devops; lo monta una persona.

❌ **No**:
- Necesitás SSO empresarial / cumplimiento estricto.
- Esperás >100K usuarios concurrentes.
- Querés todo en un único framework (Next.js / Remix / etc) — usá ese.
- El sitio NO está en Webflow (este patrón asume embed en CMS estático).

---

## 2. Stack final

| Capa | Tecnología | Por qué |
|---|---|---|
| **Hosting de assets** | jsDelivr + GitHub público | CDN gratis, integrado con git push. SHA-pinned URLs para invalidar cache. |
| **Auth** | Supabase Auth (magic link) | Sin password = cero fricción + cero soporte por contraseñas perdidas. |
| **Base de datos** | Supabase Postgres | RLS para policies declarativas, free tier generoso. |
| **Backend logic** | Supabase Edge Functions | Deno runtime, deploy con CLI. Para crons + webhooks. |
| **Realtime** | Supabase Realtime | Push updates al frontend cuando cambia data. |
| **Email transaccional** | Resend (custom SMTP en Supabase) | 3.000/mes gratis, branded sender (`fixture@tudominio.com`). |
| **Datos externos** | ESPN unofficial API | Free, sin auth, datos deportivos completos. |
| **Frontend** | Vanilla JS + GSAP + Odometer.js | Sin framework, ~50KB total, embebible. |
| **Animaciones** | GSAP (stagger) + Odometer.js | Animations battle-tested, sin dependencias pesadas. |
| **Tipografía** | Importada del Webflow CDN | Mantiene consistencia visual con el sitio host. |
| **Dev local** | Python http.server + watcher | Edits instant, sin build step. |

**Total mensual con uso moderado**: $0.

---

## 3. Inicio rápido (45 minutos desde cero)

Pasos en orden. Cada uno tiene su sección detallada después.

1. **Crear repo público en GitHub** (`mi-widget`).
2. **Copiar archivos base** de este repo (widget.js, widget.css, tokens.css, dev.html, dev.sh, schema.sql, edge functions).
3. **Adaptar el dominio del modelo de datos** (en este caso "matches/predictions/teams"; en el tuyo: "events/votes/items", "courses/enrollments/lessons", lo que sea).
4. **Crear proyecto Supabase**, correr `schema.sql`, configurar redirect URLs.
5. **Conseguir API externa de datos** (si aplica — ESPN, RAWG, Spotify, custom API).
6. **Deployar Edge Functions** vía Supabase CLI.
7. **Setup cron** para sincronizar datos (si aplica).
8. **Configurar SMTP custom** (Resend).
9. **Pegar embed en Webflow** con SHA-pinned URLs.

---

## 4. Arquitectura

```
[Browser del usuario]
        │
        │  embed: <link>+<script> apuntando a jsDelivr
        ▼
[ jsDelivr CDN ]
        │  sirve widget.css + widget.js desde GitHub @SHA-fija
        │
[Webflow page]  <main>
        │  <div id="my-widget" class="my-widget">
        │    <skeleton pre-renderizado para evitar layout shift>
        │  </div>
        │  <script>window.MY_CONFIG = {...}</script>
        │  <script defer src="...supabase-js"></script>
        │  <script defer src="...gsap"></script>
        │  <script defer src="...widget.js"></script>
        ▼
[Widget JS ejecuta en el browser]
        │
        │  ├─ Lee localStorage cache → render instant si existe
        │  ├─ Auth via Supabase JS (magic link, lock bypass)
        │  └─ Realtime subscription a tablas
        ▼
[ Supabase ]
   ├── Auth (magic link → Resend SMTP → email branded)
   ├── Postgres + RLS (policies por user_id)
   ├── Realtime (push de cambios al widget)
   └── Edge Functions
         ├── /sync-data    ← cron cada N min, llama API externa
         └── /score-data   ← procesa cuando hay nuevos eventos
```

**Decisiones de arquitectura clave:**

- **Static + CDN serving**: el widget vive como archivos estáticos en GitHub. jsDelivr los sirve. Cero servidores propios, cero deploy pipeline.
- **SHA-pinned URLs en embed**: el embed referencia `@<commit-sha>` en jsDelivr, no `@main`. Esto evita el cache de 12h de jsDelivr en branch refs. Cada update = un push al repo + actualizar SHA en el embed.
- **Auth = magic link sin password**: minimiza fricción y soporte. Implementación en Supabase es 1 línea de código.
- **Auth bypass via `lock: () => fn()`**: el navigator lock de supabase-js cuelga `getSession()` en algunos browsers (issue conocido). Pasar un lock no-op lo bypasse.
- **Cache local agresivo**: localStorage guarda snapshot del estado completo. Visitas posteriores → render instantáneo desde cache + fetch en background. Si el fetch falla, la cache sigue en pantalla.
- **Cron en Postgres**: pg_cron + pg_net dentro de Supabase, sin servicio externo. La función Edge se autentica con un `CRON_SECRET` random, no con `service_role`.
- **Skeleton pre-renderizado en el embed**: evita layout shift al cargar. El JS detecta el skeleton y no lo wipea hasta el primer render real.

---

## 5. Setup detallado

### 5.1 Repo + assets en GitHub

```bash
mkdir mi-widget && cd mi-widget
git init
# Copiar archivos base de este repo
gh repo create mi-widget --public --source=. --push
```

Adaptá `widget.js`, `widget.css`, `tokens.css` al dominio. Mantené la estructura de:
- `tokens.css` — variables de diseño (colores, fonts, radios, sombras)
- `widget.css` — estilos del widget
- `widget.js` — IIFE con state, render functions, event bindings

**Nombres de clases**: usá un prefix único (`mywidget-` en vez de `esmet-`) para no colisionar con CSS del sitio host.

### 5.2 Supabase

1. **Crear proyecto** en https://supabase.com (free).
2. **SQL Editor → New query** → pegar `schema.sql` adaptado:
   - Tablas con foreign keys a `auth.users(id)` vía `profiles`
   - RLS habilitada en todas las tablas
   - Policies tipo `auth.uid() = user_id`
   - Trigger `handle_new_user` que copia `auth.users` → `profiles` con el nombre del raw_user_meta_data
3. **Authentication → Providers → Email**:
   - Confirm email: **OFF** (no queremos doble paso, magic link ya verifica)
4. **Authentication → URL Configuration**:
   - Site URL: la URL de producción
   - Redirect URLs: agregar staging y prod (con `**` al final para wildcard)
5. **Authentication → Email Templates → Magic Link**:
   - Subject branded en español
   - Body HTML con tu logo + estilos inline + `{{ .ConfirmationURL }}`

### 5.3 SMTP custom (Resend)

Sin esto, los emails salen de `noreply@mail.app.supabase.io` (no branded) y hay rate limit de 4/hora.

1. https://resend.com → Sign up.
2. **Domains → Add Domain** → tu dominio. Resend te da 3 records DNS (DKIM TXT, SPF MX, SPF TXT).
3. **Pegar los 3 records** en tu proveedor DNS (Donweb / Cloudflare / GoDaddy / NIC.ar). Importante: van todos en subdominios (`resend._domainkey`, `send`), no tocan tu MX root.
4. Click **Verify** en Resend → debería ponerse verde en 5-30 min.
5. **API Keys → Create API Key** → permission: `sending_access`, scope al dominio. Copiá la key (`re_...`).
6. **Supabase → Authentication → Emails → SMTP Settings → Set up SMTP**:
   - Host: `smtp.resend.com`
   - Port: `465`
   - Username: `resend`
   - Password: la API key
   - Sender email: `equipo@tudominio.com`
   - Sender name: `Mi Producto`

### 5.4 API externa de datos (opcional)

Si tu widget necesita data dinámica (deportes, música, productos), buscá una **API pública sin auth** o con free tier. Ejemplos:
- **Deportes**: ESPN unofficial API (sin key, completa).
- **Música**: Spotify (con OAuth) o Last.fm.
- **Películas**: TMDB (key free).
- **Geo**: OpenStreetMap Nominatim.

**No** uses APIs con key directamente desde el browser — la key queda expuesta. Siempre proxy desde Edge Function.

### 5.5 Edge Functions

```bash
supabase login --token sbp_...
supabase link --project-ref xxx
supabase secrets set CRON_SECRET=$(openssl rand -hex 32)
supabase secrets set EXTERNAL_API_KEY=tu_key
supabase functions deploy sync-data --no-verify-jwt
```

`--no-verify-jwt` porque la función no usa JWT del usuario; se autentica con `CRON_SECRET` que checkeás manualmente:

```ts
const cronSecret = Deno.env.get("CRON_SECRET");
const auth = req.headers.get("Authorization") ?? "";
if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
  return new Response("forbidden", { status: 403 });
}
```

### 5.6 Cron en Supabase (pg_cron)

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'sync-data-job',
  '*/10 * * * *',  -- cada 10 min
  $job$
  select net.http_post(
    url := 'https://xxx.supabase.co/functions/v1/sync-data',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer EL_CRON_SECRET_AQUI'
    )
  );
  $job$
);
```

**Early-exit pattern**: la función chequea cuándo fue la última sync (lee de la tabla); si fue hace poco, retorna sin tocar la API externa. Esto economiza quota:

```ts
const { data: lastRow } = await supabase
  .from("data")
  .select("updated_at")
  .order("updated_at", { ascending: false })
  .limit(1);
if (lastRow?.[0]) {
  const lastSyncedMs = Date.parse(lastRow[0].updated_at);
  const minIntervalMs = isHighActivityWindow ? 5 * 60 * 1000 : 24 * 60 * 60 * 1000;
  if (Date.now() - lastSyncedMs < minIntervalMs) {
    return new Response(JSON.stringify({ skipped: true }));
  }
}
```

### 5.7 Webflow embed

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/USER/REPO@SHA/widget.css">

<div id="my-widget" class="my-widget">
  <!-- Skeleton pre-renderizado: el JS no lo wipea hasta el primer render real,
       evita layout shift -->
  <div class="my-skel" aria-hidden="true">
    <!-- estructura mínima que matchea el layout final -->
  </div>
</div>

<script>
  window.MY_CONFIG = {
    supabaseUrl: "https://xxx.supabase.co",
    supabaseAnonKey: "sb_publishable_..."
  };
</script>
<!-- Dependencias en orden: lib → utils → widget -->
<script defer src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.0/dist/umd/supabase.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/gh/USER/REPO@SHA/widget.js"></script>
```

**Importante**: usar el **commit SHA** en `@SHA`, NO `@main`. jsDelivr cachea `@main` por 12h y la purga no siempre se propaga rápido. Con SHA específico, las URLs son inmutables.

---

## 6. Patrones de código que vale la pena copiar

### 6.1 IIFE con state + helpers + render

```js
(function () {
  const cfg = window.MY_CONFIG;
  if (!cfg?.supabaseUrl) return;
  const root = document.getElementById("my-widget");
  if (!root) return;
  root.classList.add("my-widget");
  // No wipear si hay skeleton pre-renderizado
  if (!root.querySelector(".my-skel")) {
    root.innerHTML = '<div class="my-loading">Cargando…</div>';
  }

  const state = { /* ... */ };
  const IS_DEV = ["localhost", "127.0.0.1"].includes(location.hostname);

  // Helpers, renderers, bindings...

  init().catch(showError).finally(() => clearTimeout(safetyTimer));
})();
```

### 6.2 waitForSupabase + lock bypass

```js
function waitForSupabase() {
  return new Promise((resolve, reject) => {
    if (window.supabase?.createClient) return resolve(window.supabase);
    const start = Date.now();
    const t = setInterval(() => {
      if (window.supabase?.createClient) { clearInterval(t); resolve(window.supabase); }
      else if (Date.now() - start > 8000) { clearInterval(t); reject(new Error("supabase-js no cargó")); }
    }, 80);
  });
}

const sb = await waitForSupabase();
state.supabase = sb.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // ⚠️ critical fix: bypassa el navigator lock que cuelga getSession
    lock: async (_name, _timeout, fn) => fn(),
  },
});

// getSession con timeout — si cuelga, asumimos anon y onAuthStateChange resuelve después
const sess = await Promise.race([
  state.supabase.auth.getSession().then((r) => r.data?.session ?? null),
  new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
]);
state.session = sess;
```

### 6.3 Cache local con stale-while-revalidate

```js
const CACHE_KEY = "my-widget-cache-v1";
const CACHE_TTL_MS = 24 * 3600 * 1000;

function saveCache() { /* serializa state a localStorage */ }
function loadCache() {
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return null;
  const snap = JSON.parse(raw);
  if (snap.userId !== state.session?.user?.id) return null; // distinto user
  if (Date.now() - snap.savedAt > CACHE_TTL_MS) return null; // expiró
  return snap;
}

async function loadAppData() {
  // Si hay cache → render YA (instant), después fetcheamos fresh
  const cached = loadCache();
  if (cached) { hydrateFromCache(cached); render(); }

  try {
    const fresh = await Promise.race([fetchEverything(), timeoutPromise(6000)]);
    updateState(fresh); saveCache(); render();
  } catch (err) {
    if (cached) return; // cache ya está en pantalla, no mostrar error
    showError(err);
  }
}
```

### 6.4 bfcache + visibilitychange para tab return

```js
window.addEventListener("pageshow", (e) => {
  if (e.persisted) location.reload(); // bfcache restore = reload
});

let __hiddenAt = null;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { __hiddenAt = Date.now(); return; }
  if (__hiddenAt == null) return;
  const wasHiddenFor = Date.now() - __hiddenAt;
  __hiddenAt = null;
  if (wasHiddenFor < 3000) return;
  const isStuck = !!root.querySelector(".my-skel, .my-loading");
  if (isStuck) location.reload();
});
```

### 6.5 Skeleton screen con shimmer

```css
.my-skel__line, .my-skel__card {
  background: linear-gradient(90deg, #eee 0%, #f8f8f8 50%, #eee 100%);
  background-size: 200% 100%;
  animation: shimmer 1.6s ease-in-out infinite;
  border-radius: 4px;
}
@keyframes shimmer {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}
```

### 6.6 Auto-advance focus con preservación al re-render

```js
function render() {
  // Capturar focus antes de wipe
  const ae = document.activeElement;
  const focusKey = ae?.dataset?.field
    ? { field: ae.dataset.field, key: ae.dataset.key, sel: [ae.selectionStart, ae.selectionEnd] }
    : null;

  root.innerHTML = renderApp();
  bindApp();

  // Restaurar focus tras re-render
  if (focusKey) {
    const el = root.querySelector(`[data-field="${focusKey.field}"][data-key="${focusKey.key}"]`);
    if (el) {
      el.focus();
      try { el.setSelectionRange(...focusKey.sel); } catch (_) {}
    }
  }
}

// En bindApp: tras 450ms idle, advance al siguiente input
input.addEventListener("input", () => {
  // ... save logic
  clearTimeout(advanceTimer.get(input));
  if (input.value.length >= 1) {
    advanceTimer.set(input, setTimeout(() => advanceFrom(input), 450));
  }
});
```

### 6.7 IS_DEV bypass de auth con mock data

```js
async function init() {
  if (IS_DEV) {
    loadMockData();
    render();
    return;
  }
  // ... real init
}
```

Ahorra 30+ segundos por iteración (no esperás magic link en cada reload).

### 6.8 RLS policies con check temporal

```sql
create policy "predictions_insert_own_before_kickoff" on predictions
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from matches m
      where m.id = match_id and m.kickoff_at > now()
    )
  );
```

Pattern: el server enforce las reglas de negocio aunque el cliente las saltee. La UI desactiva los inputs después del kickoff, pero la DB **rechaza** cualquier write tardío.

---

## 7. Workflow de desarrollo

### 7.1 Estructura del repo

```
mi-widget/
├── widget.js              ← lógica del widget
├── widget.css             ← estilos
├── tokens.css             ← variables de diseño
├── webflow-embed.html     ← snippet listo para Webflow
├── dev.html               ← preview local (incluye skeleton + scripts)
├── dev.sh                 ← arranca python http.server en :8765
└── supabase/
    ├── schema.sql         ← tablas + RLS + triggers
    ├── email-templates/
    │   └── magic-link.html
    └── functions/
        ├── sync-data/index.ts
        └── score-data/index.ts
```

### 7.2 Iteración local

```bash
./dev.sh           # http server en :8765
# en otra terminal:
# editás widget.js o widget.css
# refresh en http://localhost:8765/dev.html
```

Para **mac con archivos en Google Drive**: el sandbox del proceso bloquea acceso. Soluciones:
1. Mover el repo afuera de Google Drive (recomendado).
2. O usar un watcher que rsync los archivos a `/tmp/mi-widget` y servir desde ahí. Ver `dev.sh` para el patrón.

Para **bypass de auth en dev**:
```js
const IS_DEV = ["localhost", "127.0.0.1"].includes(location.hostname);
async function init() {
  if (IS_DEV) { loadMockData(); render(); return; }
  // real init
}
```

### 7.3 Commit + deploy

```bash
git commit -am "feat: nueva feature"
git push  # jsDelivr serve el commit en <1min
# Captura SHA: git rev-parse --short HEAD
# Actualizar webflow-embed.html con la SHA nueva
# Pegar nuevo embed en Webflow → publicar
```

Convención de SHA-pinning: cada cambio que modifica widget.js o widget.css debe bumpear la SHA en el embed. Yo lo automaticé en este repo con un commit doble: 1) cambio + 2) bump SHA del embed.

---

## 8. Errores comunes (y cómo se resuelven)

### Auth se cuelga en `getSession`
- **Síntoma**: skeleton stuck, init log dice `get-session`.
- **Causa**: navigator lock de supabase-js abandonado por una tab cerrada.
- **Fix**: `lock: async (_name, _timeout, fn) => fn()` en createClient.

### Layout shift cuando carga el widget
- **Causa**: el div del embed empieza con altura 0; cuando el JS injecta contenido, la página crece.
- **Fix**: skeleton screen pre-renderizado dentro del div del embed. El JS detecta `.my-skel` y no lo reemplaza hasta el primer render real.

### "Cargando..." stuck al volver de otra tab
- **Causa**: bfcache del browser restaura la página con state JS intacto pero requests pendientes abandonadas.
- **Fix combo**:
  1. `pageshow` con `event.persisted=true` → `location.reload()`
  2. `visibilitychange` → si tab estuvo oculta >3s y aún hay loading → reload
  3. **Cache localStorage**: la próxima visita ya no muestra loading, render desde cache instantáneo.

### jsDelivr sigue sirviendo versión vieja con `@main`
- **Causa**: TTL de 12h en branch refs.
- **Fix**: nunca usar `@main` en producción; siempre `@<commit-sha>` específico.

### macOS Google Drive folder: "Operation not permitted"
- **Causa**: sandbox del proceso bloquea el folder de Google Drive.
- **Fix**: mover el repo afuera, o usar rsync watcher a `/tmp`.

### Odometer.js no respeta `duration` JS
- **Causa**: el theme tiene `transition: transform 2s` hardcoded en CSS.
- **Fix**: override con `!important`:
  ```css
  .my-widget .odometer.odometer-animating-up .odometer-ribbon-inner {
    transition: transform 0.4s ease-in-out !important;
  }
  ```

### Odometer no padea ceros (muestra "8" en vez de "08")
- **Causa**: `parseFloat` descarta el cero líder.
- **Fix**: dos instancias de Odometer por unidad — una para decenas, una para unidades.

### Email rate limit en Supabase free tier
- **Síntoma**: 4 emails / hora máximo, después fallan.
- **Fix**: configurar SMTP custom (Resend con free tier de 3.000/mes).

### Confirm Signup email se manda en vez de Magic Link
- **Causa**: Authentication → Email Confirmations está ON por default.
- **Fix**: desactivar "Confirm email" en Email Provider settings. El magic link ya verifica el mail.

### Service role key compartida en chat / código
- **Causa**: confusión entre publishable (frontend) y secret (backend).
- **Fix**:
  - Publishable key (`sb_publishable_*`): puede ir al frontend.
  - Secret key (`sb_secret_*`): solo en Edge Function secrets via `supabase secrets set`. Si se filtró, **rotar inmediatamente**.

### Webflow no actualiza pese a re-pegar el embed
- **Causa**: Webflow tiene cache de página en Cloudflare (`surrogate-control: max-age=2147483647`).
- **Fix**: en Webflow, **publicar** el sitio (no solo guardar). Webflow purga el cache al publish.

### Cron no dispara
- **Causa 1**: `pg_cron` y `pg_net` no están habilitadas.
- **Fix**: `create extension if not exists pg_cron; create extension if not exists pg_net;`
- **Causa 2**: el job está scheduled pero la URL/auth está mal.
- **Fix**: revisar `select * from cron.job_run_details order by start_time desc limit 5;`

---

## 9. Decisiones que pagué iterando (por si te ayudan a saltearte el ciclo)

1. **API-Football (de pago) vs ESPN unofficial**: empecé con API-Football pero el plan free no incluye temporadas futuras. ESPN unofficial es completamente free, sin auth, y tiene los 104 fixtures del Mundial 2026. **Lección**: antes de comprometerse con una API paga, busca alternativas no oficiales.

2. **service_role key en frontend → desastre**: nunca, jamás. Aunque sea "para testear". Se filtra en chat, en logs, en commits. **Siempre** publishable + RLS para frontend; secret solo en Edge Functions.

3. **`@main` en jsDelivr → cache de 12h**: cambié a SHA específica. El embed se re-pega cada vez (un drawback) pero se evita el infierno del "ya pushé pero no se ve".

4. **iOS Safari + bfcache → loading state stuck**: probé varias detecciones. Lo que finalmente funcionó: **cache localStorage con stale-while-revalidate**. Cualquier visita posterior es instant, sin loading state que pueda quedarse stuck.

5. **Repo en Google Drive → sandbox bloquea acceso**: Claude Code intentaba leer credenciales y el OS lo bloqueaba. Workaround: scripts watcher que copian a `/tmp`. Lección para próxima vez: poner el repo en `~/Projects/` desde el día 1.

6. **Webflow Cloud no era una opción**: el usuario lo descartó por complejidad. Para casos así (widget chico) jsDelivr + GitHub es 100x más simple.

7. **Custom SMTP es prácticamente obligatorio**: el rate limit de 4/hora del free tier es muy bajo. Resend con DNS records bien configurados es 15 min de setup y elimina el problema.

8. **GSAP + Odometer.js**: no busqué alternativas porque ya conocía estas. Si optimizás bytes, considerá Motion.js (más liviano que GSAP) y un odómetro custom CSS (para evitar 12KB de Odometer.js).

---

## 10. Check antes del go-live

- [ ] `webflow-embed.html` tiene la SHA del último commit que querés deployar.
- [ ] `Site URL` y `Redirect URLs` en Supabase incluyen staging Y producción.
- [ ] "Confirm email" está OFF.
- [ ] SMTP custom configurado y testeado (mail de prueba al admin).
- [ ] Email template del magic link está customizado con tu branding.
- [ ] RLS está habilitada en TODAS las tablas con datos de usuario.
- [ ] Edge Functions deployadas (`supabase functions list`).
- [ ] `CRON_SECRET` rotado de cualquier valor que pasó por chat.
- [ ] Cron job `select * from cron.job` confirma que está agendado.
- [ ] Datos sembrados (al menos un manual sync con `?force=1`).
- [ ] Probaste el flujo end-to-end: registro → magic link → entrar → interactuar → cerrar tab → volver → todo OK.

---

## Apéndice A: archivos clave para copiar

Estos son los que más vale la pena reusar tal cual:

- `widget.js` — la estructura del IIFE, helpers de cache, lock bypass, auto-advance.
- `tokens.css` — pattern de variables namespaced.
- `widget.css` — selectores con prefix (`my-widget` en vez de `body`), media queries.
- `supabase/schema.sql` — pattern de profiles + RLS + trigger.
- `supabase/functions/sync-data/index.ts` — pattern de cron-friendly Edge Function con early-exit y CRON_SECRET auth.
- `dev.html` — preview local que matchea el embed de prod.

## Apéndice B: cosas que faltarían para escalar

Si el proyecto crece y necesitás más:

- **Build step + minificación**: actualmente el JS es ~30KB sin minificar. Con esbuild/rollup podés bajarlo a ~12KB. Vale la pena con > 1k usuarios concurrentes.
- **Monitoring**: Sentry para errores frontend, Logflare para logs de Edge Functions.
- **Tests**: Playwright para flow end-to-end, vitest para helpers puros.
- **CI/CD**: GitHub Actions que pushea a GitHub Pages / re-deploy Edge Functions / corre tests en cada PR.
- **i18n**: si hay multi-idioma, mover strings a un dict externo.
- **Tipo TypeScript**: convertir widget.js a widget.ts para autocomplete y type safety.
