# Borradores de PR para la candidata de pruebas

Textos preparados el 2026-10-13 para revisión. No registran la creación de
commits, PRs o despliegues. Antes de copiarlos, sustituir las referencias entre
`<...>` por los SHA y enlaces comprobados y actualizar los resultados si cambia
el código. El orden operativo está en
[qualification-merge-deploy.md](qualification-merge-deploy.md).
El estado observado y sus límites están en el
[recibo de preparación](evaluation/merge-preparation-2026-10-13.json).

Los resultados históricos pertenecen a los artefactos de sus recibos. Las
comprobaciones nuevas del origen `https://grok.fabrials.com` no equivalen a
repetir esa cualificación en el nuevo dominio.

## 1. fabrials-libs: feat/grok-remote → master

**Título:** `feat(remote): add direct encrypted Grok sessions and an isolated qualification origin`

**Cuerpo del PR:**

Permite controlar sesiones Grok desde una PWA conectada directamente al host
Spanreed del usuario por HTTPS/WSS y Noise, con identidad fijada, emparejamiento
de un uso, revocación y control exclusivo. El host usa el Grok oficial y su
líder compartido para conservar continuidad con el terminal. Los comandos con
resultado incierto requieren revisión; no se reenvían automáticamente.

Incluye transporte y fragmentación acotados, recibos duraderos, proyección de
interacciones y medios normalizados, notificaciones privadas opcionales y el
cliente de publicaciones con consentimiento y selección explícita. Las rutas
públicas del backend conservan sus requisitos de apertura.

El origen predeterminado sigue siendo `https://desktop.grok.me`. El host directo
admite `https://grok.fabrials.com` sólo mediante selección explícita, persiste
`webOrigin` junto a su identidad y rechaza cambios de origen o endpoint sobre
un estado existente antes de iniciar el host o emitir un nonce. El estado
antiguo conserva el origen de producción. La lista histórica de orígenes del
modo gestionado no se amplía.

**Validación:**

- Histórica: 498 pruebas de agent-host y Clippy estricto; transporte Noise
  real, continuidad ACP y medios tienen sus comprobaciones y límites en los
  documentos de implementación. No son pruebas del dominio nuevo.
- Nueva para el origen de pruebas: 24 pruebas de origen y cuatro pruebas puras
  del host directo correctas; Clippy correcto. Las dos pruebas Noise que
  requieren sockets quedaron bloqueadas por `bind: EPERM` en el sandbox.
- El formato de los archivos afectados se comprobó en una copia de revisión.
  No se eliminaron pruebas de sockets ni se sustituyeron por un resultado verde.

**Dependencias y pendientes antes de integrar:**

- Fijar `<SHA_LIBS_REVISADO>` y usar esa misma revisión para el Noise de Portable
  y el subtree de Spanreed; los consumidores no deben editar su copia vendorizada.
- Repetir las pruebas de sockets con esa revisión y ejecutar la aceptación del
  host con el frontend del mismo origen. Windows, servicios instalados,
  Tailscale y entrega real de push conservan cualificación separada.
- La configuración de un dominio de pruebas no habilita publicaciones ni
  demuestra borrado, restauración o disponibilidad de infraestructura.

## 2. grok-desktop-portable: feat/grok-remote → dev

**Título:** `feat(remote): ship a direct Grok PWA with verified qualification artifacts`

**Cuerpo del PR:**

Añade una PWA que conserva perfiles de equipos emparejados y controla sus
sesiones Grok mediante conexión privada directa y Noise. Incluye reconexión,
historial y borradores locales, interacciones y permisos, adjuntos de imagen,
controles móviles, instalación y actualización explícitas, y acceso a fuentes
y licencias ligado al shell cargado. El modo directo conserva su funcionamiento
sin depender de una cuenta Fabrials ni recurrir automáticamente a un relay.

La construcción acepta dos orígenes exactos: `https://desktop.grok.me` por
defecto y `https://grok.fabrials.com` mediante `FABRIALS_REMOTE_ORIGIN` o
`--origin`. El origen queda compilado en la aplicación y registrado en el HTML
y artefacto. Un shell servido en el otro origen conocido se bloquea antes de
consumir fragmentos de emparejamiento o publicación. El alias histórico
`remote.fabrials.com` continúa apuntando a producción.

La candidata de pruebas utiliza un Build Output Vercel independiente con
condición de Host `value: {eq: "grok.fabrials.com"}`, cabeceras de seguridad y
`noindex`. La verificación exige la correspondencia del shell completo, Noise,
instaladores y ambas configuraciones de hosting con las fuentes archivadas.
El workflow de pruebas crea el archivo desde la candidata nativa exacta; el de
producción exige el archivo de la release estable. Los verificadores leen los
metadatos literales del worker sin ejecutar JavaScript del artefacto.

**Validación:**

- Histórica: 795 pruebas en 81 archivos, tipos y build cifrado correctos; 35
  comprobaciones de navegador en Syl Sway aislado y un artefacto de revisión de
  50 archivos, con 47 archivos de PWA idénticos al embed nativo. La comprobación
  positiva de metadatos de fuentes empleó una respuesta sintética; no cualificó
  la descarga de un archivo real de fuentes.
- Nueva para el dominio: 799 pruebas frontend, TypeScript y 18 pruebas de
  límites del artefacto correctas; actionlint y comprobación de espacios
  correctos. La revisión independiente detectó y corrigió el Host interpretado
  como regex; los casos adversariales ahora comprueban la igualdad exacta.
- El build cifrado del nuevo origen quedó bloqueado: el subprocess del
  generador de atribuciones devolvió salida vacía y el requisito de JSON válido
  detuvo la construcción; el diagnóstico registró `EPERM`. No se desactivó la
  generación de licencias ni se produjo una candidata cualificada para este
  dominio.

**Dependencias y pendientes antes de integrar/desplegar:**

- Usar `<SHA_LIBS_REVISADO>`, `<SHA_PORTABLE_REVISADO>` y
  `<SHA_SPANREED_CANDIDATO>`; este último debe contener el subtree correcto y
  el embed construido desde Portable con el origen de pruebas explícito.
- Ejecutar el workflow y `verify --for-deploy` con fuentes limpias. Confirmar
  proyecto Vercel independiente, DNS, HTTPS y comportamiento real del guard
  antes de usar enlaces de emparejamiento. No trasladar el dominio de producción.
- Probar instalación en S24, Tailscale, continuidad con terminal, suspensión,
  cambios de red, push y actualizaciones N/N−1 con esta candidata. Retener las
  fuentes de versiones que los clientes aún puedan ejecutar.
- La PWA privada no necesita un rollout de Web. SSO/push gestionado requieren
  su integración separada; publicaciones conservan el origen canónico y siguen
  cerradas.

## 3. spanreed: feat/grok-remote → dev

**Título:** `feat(remote): integrate private Grok hosting and source-verified distribution`

**Cuerpo del PR:**

Integra los comandos de Remote en Spanreed y las herramientas para distribuir
la PWA embebida, diagnosticar, emparejar y gestionar el ciclo de vida. El modo privado conserva la
ejecución de Grok en el equipo del usuario y expone el transporte cifrado detrás
de su HTTPS, con Tailscale como red recomendada.

`private-serve`, `private-pair` y el renderizado de servicios admiten
`--web-origin https://grok.fabrials.com` de forma explícita. El estado y los
enlaces reflejan el origen persistido. Los servicios se niegan a operar cuando
hay un directorio de estado alternativo, evitando que una prueba aislada
modifique el servicio habitual; la candidata aislada se ejecuta en primer plano.

La distribución exige archivos de fuentes y checksums que correspondan al
commit nativo y al Portable del embed. Los instaladores rechazan versiones
inestables, checksums ambiguos y destinos inseguros, y preparan la sustitución
en el mismo sistema de archivos. El autoactualizador Unix conserva el bloqueo
de instancia, comprueba las versiones y restaura el binario anterior ante
fallos inmediatos. La aplicación de actualizaciones en Windows permanece
deshabilitada hasta cualificar su confinamiento de procesos y ACL.

**Validación:**

- Histórica: integración del núcleo canónico en una copia temporal del
  consumidor, 16 comprobaciones de ciclo de vida Linux, 23 pruebas dirigidas
  del actualizador y dos integraciones CLI; 14 pruebas aisladas del instalador
  canónico, 19 ejecuciones del instalador Portable y cinco mutaciones detectadas.
  Las pruebas de fuentes/release sumaron 45. Los recibos identifican sus
  binarios y límites; no prueban el dominio nuevo.
- Nueva para el dominio: seis pruebas de servicios, una del parser y una
  integración CLI de preflight/conservación con nueve guardas correctas;
  Clippy correcto, sobre la copia temporal de integración con las librerías
  candidatas. Doce pruebas del archivo de fuentes correctas, incluida la
  correspondencia de instaladores y ambas configuraciones de hosting.
  El arnés de ciclo de vida incorpora 18 comprobaciones y
  `--web-origin`, pero no se ejecutó porque el sandbox impide sockets.
- El embed de pruebas todavía requiere regeneración; el intento de construir
  Portable quedó bloqueado por el subprocess de atribuciones. No se declara
  validada una build del consumidor con el nuevo dominio.

La secuencia propuesta separa el primer commit de código de los posteriores
commits de sincronización y assets. `assets/remote-web/` y su manifiesto quedan
fuera del primer commit: la copia histórica contiene espacios literales en sus
atribuciones generadas y se conserva en disco con sus hashes, sin editarla para
silenciar comprobaciones. Los checks de espacios del código no cualifican esos
assets. El primer commit por sí solo no acredita CI completo del consumidor.

**Dependencias y pendientes antes de integrar:**

- Sincronizar `<SHA_LIBS_REVISADO>` mediante `scripts/sync-fabrials-libs.sh`,
  resolver el lockfile sin actualizaciones ajenas y comprobar el consumidor.
  Esta preparación no acredita que el vendor real ya esté sincronizado.
- Construir el embed desde `<SHA_PORTABLE_REVISADO>` con
  `FABRIALS_REMOTE_ORIGIN=https://grok.fabrials.com`, registrar sus fuentes,
  comprobar `remote-assets.py check --release` y generar el archivo desde el
  commit limpio resultante. Portable debe verificar después la misma candidata.
- Repetir sockets y ciclo de vida real; cualificar servicios, Windows/macOS,
  instaladores descargados y recuperación ante interrupciones. La restauración
  por fallo inmediato no equivale a downgrade posterior ni recuperación tras
  pérdida de alimentación.
- Destino `dev`: no fusionar directamente en `master` ni crear una release
  estable sólo para obtener una candidata de pruebas.

## 4. fabrials-web: feat/grok-remote → master

**Título:** `feat(remote): add revocable browser sessions and bounded publication infrastructure`

**Cuerpo del PR:**

Añade sesiones de navegador revocables por familia, renovación coordinada y
comprobaciones de cuenta/origen para Remote. El retorno de login y CORS
aceptan `https://grok.fabrials.com` sólo con ambos flags
`SPANREED_REMOTE_ENABLED=1` y `SPANREED_REMOTE_TEST_ORIGIN_ENABLED=1`.
Los valores predeterminados conservan la lista de confianza existente.

Incluye el backend y las pantallas de consentimiento, lectura y gestión de
publicaciones. La publicación requiere selección explícita, grant limitado y
PKCE; sólo texto nuevo amplía el vencimiento de siete días. La retirada y
caducidad revocan acceso y destruyen claves antes de la limpieza de ciphertext.
Presupuestos duraderos de almacenamiento, peticiones, entrada, salida y
procesamiento evitan que cancelaciones, reintentos o pequeñas respuestas con
objetos cifrados grandes eludan los límites. La retirada y limpieza conservan
capacidad independiente.

Las publicaciones permanecen deshabilitadas mediante un requisito de readiness
que falla cerrado. El opt-in de pruebas no modifica el binding
`https://desktop.grok.me`, no permite consentimiento entre orígenes y no activa
las rutas. La destrucción de claves y la limpieza física pendiente se muestran
por separado; no se promete retirar originales privados ni copias descargadas.

**Validación:**

- Histórica: 214 pruebas con PostgreSQL y S3 de laboratorio, 3.608 aserciones,
  TypeScript y build Node 22 correctos; nueve comprobaciones HTTP de la build y
  41 comprobaciones de componentes en navegador. Las respuestas de estas
  últimas eran sintéticas, sin autenticar usuarios de producción.
- Nueva para el origen: 28 pruebas dirigidas en siete archivos, 243 aserciones,
  TypeScript, lint y comprobación de espacios correctos. Siete operaciones de
  publicación y OPTIONS, invocadas directamente con ambos flags activados,
  siguen devolviendo 503; readiness conserva 12 bloqueos.
- El intento de nueva build Node 22 falló por `EPERM` al abrir el puerto interno
  de Turbopack/PostCSS. No produjo una nueva candidata; los recibos HTTP/build
  anteriores permanecen históricos. Evidencia incremental:
  `docs/evaluation/test-origin-2026-10-13.json`.
- Los hallazgos de secretos revisados corresponden a nombres de variables de
  laboratorio y checksums del manifiesto vendor preexistente. No se añadieron
  excepciones amplias al escáner.

**Dependencias y pendientes antes de integrar/desplegar:**

- Revisar la migración de autenticación y sus consumidores de SSO. Los productos
  que sólo comprueban la firma JWT necesitan adoptar la comprobación de familia
  antes de prometer revocación inmediata; un backend anterior no preserva esa
  garantía al hacer rollback.
- Repetir build y aceptación HTTP/SSO con la candidata exacta. La fusión en
  `master` puede activar el despliegue de autenticación compartida: coordinarlo
  como operación separada. El frontend privado no depende de este despliegue.
- Mantener cerradas las publicaciones hasta superar aislamiento de nodos de
  claves, borrado/restauración de backups y snapshots, límites de perímetro,
  capacidad física y demás requisitos documentados en `docs/publications-v2.md`.

## Condiciones comunes de entrega

No activar auto-merge. Antes de abrir o fusionar, obtener un fetch reciente,
comparar cada base de destino, resolver divergencias y repetir las comprobaciones
afectadas. No presentar referencias locales como una actualización del remoto.

La firma GPG y la creación de commits deben resolverse expresamente antes de
publicar estos PRs; estos textos no eluden esa decisión. Tampoco acreditan
sincronización del vendor, ejecución remota de CI, creación de DNS/proyecto,
merge o despliegue. No publicar una release estable para desbloquear QA.
