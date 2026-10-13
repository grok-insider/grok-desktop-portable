# Borradores de PR para la candidata de pruebas

Textos de referencia del 2026-10-13. Los cuatro PRs en borrador ya están
creados; sus enlaces, commits y evidencia comprobada constan en el
[recibo de la candidata](qualification-evidence-2026-10-13.md). Antes de copiar
estos textos a una revisión posterior, sustituir las referencias entre `<...>`
y actualizar los resultados afectados. El orden operativo está en
[qualification-merge-deploy.md](qualification-merge-deploy.md).
El recibo de preparación inicial conserva los fallos del entorno restringido;
no describe el resultado de las builds y verificaciones posteriores.

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
- Candidata del recibo: 564 pruebas del host/crypto correctas, incluidos
  sockets reales y el origen QA; tres experimentos ignorados. Formato y Clippy
  correctos. El middleware que aún fijaba el origen de producción se corrigió
  con cobertura para ambos orígenes y rechazos, y revisión independiente.
- El fallo remoto de Windows requiere corregir sus fixtures y confirmar CI;
  el resultado Linux no acredita compatibilidad Windows.

**Dependencias y pendientes antes de integrar:**

- Fijar `<SHA_LIBS_REVISADO>` y usar esa misma revisión para el Noise de Portable
  y el subtree de Spanreed; los consumidores no deben editar su copia vendorizada.
- Repetir las pruebas afectadas si cambia esa revisión; la aceptación local
  del host y frontend QA quedó registrada. Windows, servicios instalados,
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
- La build cifrada y la candidata limpia posterior pasaron la prueba completa
  de correspondencia de fuentes. Sus 37 comprobaciones de navegador incluyen
  descargas reales con hashes verificados y Origin de Chrome conservado hasta
  el host. El recibo enlazado identifica manifiesto, archivo y commits. Se
  usaron DNS/TLS de laboratorio; no acredita el hosting público. Los primeros
  fallos `EPERM` quedaron superados sin desactivar las atribuciones.

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
- Candidata del recibo: 2.246 pruebas principales y un fixture adicional
  correctos, once casos ignorados; formato y Clippy correctos. Doce pruebas del
  archivo de fuentes incluyen instaladores y ambas configuraciones de hosting.
- Build Linux optimizada y 18 comprobaciones de ciclo de vida con
  `--web-origin` correctas. Subtree canónico, embed QA y archivo real de fuentes
  verificados. Las identidades y la distinción entre la suite anterior al commit
  de manifiesto y la build final figuran en el recibo.

La integración separa código, sincronización canónica y assets. Los textos de
licencia originales mantienen sus bytes, incluidos los espacios. Los checks
de espacios del código no sustituyen los hashes y la correspondencia de los
assets. El fallo remoto de Windows impide considerar completo el CI del
consumidor.

**Dependencias y pendientes antes de integrar:**

- Sincronizar `<SHA_LIBS_REVISADO>` mediante `scripts/sync-fabrials-libs.sh`,
  resolver el lockfile sin actualizaciones ajenas y comprobar el consumidor.
  La candidata del recibo ya tiene ese vendor; una revisión nueva exige otro sync.
- Construir el embed desde `<SHA_PORTABLE_REVISADO>` con
  `FABRIALS_REMOTE_ORIGIN=https://grok.fabrials.com`, registrar sus fuentes,
  comprobar `remote-assets.py check --release` y generar el archivo desde el
  commit limpio resultante. Portable debe verificar después la misma candidata.
- Repetir sockets y ciclo de vida si cambia el código; cualificar servicios, Windows/macOS,
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
- Build limpia Node 22 de 65 páginas y 92 comprobaciones HTTP en cuatro
  combinaciones de flags correctas para Web `46bf727`, según el recibo de la
  candidata. Los primeros fallos `EPERM` quedaron superados; no se omitió la
  build. La comprobación HTTP de flags no autentica usuarios reales de SSO.
- Los hallazgos de secretos revisados corresponden a nombres de variables de
  laboratorio y checksums del manifiesto vendor preexistente. No se añadieron
  excepciones amplias al escáner.

**Dependencias y pendientes antes de integrar/desplegar:**

- Revisar la migración de autenticación y sus consumidores de SSO. Los productos
  que sólo comprueban la firma JWT necesitan adoptar la comprobación de familia
  antes de prometer revocación inmediata; un backend anterior no preserva esa
  garantía al hacer rollback.
- Repetir build/HTTP si cambia Web y completar SSO real. La fusión en
  `master` puede activar el despliegue de autenticación compartida: coordinarlo
  como operación separada. El frontend privado no depende de este despliegue.
- Mantener cerradas las publicaciones hasta superar aislamiento de nodos de
  claves, borrado/restauración de backups y snapshots, límites de perímetro,
  capacidad física y demás requisitos documentados en `docs/publications-v2.md`.

## Condiciones comunes de entrega

No activar auto-merge. Antes de abrir o fusionar, obtener un fetch reciente,
comparar cada base de destino, resolver divergencias y repetir las comprobaciones
afectadas. No presentar referencias locales como una actualización del remoto.

Los commits firmados y PRs en borrador ya existen. La verificación local del
vendor y de la candidata no reemplaza los checks remotos: resolver Windows y
consultar todos los resultados antes de fusionar. No se ha creado DNS/proyecto
ni se ha hecho merge o despliegue. No publicar una release estable para
desbloquear QA.
