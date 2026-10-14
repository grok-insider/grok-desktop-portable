# Candidata multidevice desplegada, 2026-10-14

Este documento conserva los despliegues del día. La PWA vigente es la tercera,
descrita a continuación; las secciones posteriores conservan la
evidencia histórica de sus propias revisiones. Las horas están en UTC y la fecha
del documento corresponde a Europe/Paris. Los PRs siguen en borrador y las
publicaciones públicas siguen cerradas.

## Tercera candidata: PWA desplegada y nativo activado

| Componente | Revisión o SHA-256 |
| --- | --- |
| Portable del shell | `abe4f35895aacda102a09c3b50475379febf3b6c` |
| Librerías canónicas | `ee3060d023c5f5f34196e1ef7f439b65be9d0bb8` |
| Spanreed de la candidata y archivo de fuentes | `e6d9cc8cb076d7896edec98ee7338d4d4d8f1f7a` |
| Archivo de fuentes, 4.502.853 bytes | `d7482730885ea14e67d3df818a6680ea731173bf700c4c4f4bd2555b34a90bfc` |
| Shell | `e2ed580c58b2b07255d85205ec8a1ad0988a7a3c2f6ee1cef44f968e3f976a9e` |
| Binario GNU candidato | `5cdd5c4d8aa6c9d04cc99d9772b0964a3d2fde67658818f91a9180bdc2ff7e47` |
| Imagen desplegada | `sha256:659463d155c2fc1c1c29d2ec25851ad9cc9db77bed27513dae75f27a1cfac5c8` |
| Imagen de recuperación | `sha256:0ba1de4556e8071daf77101ac66e91ef66b11c6f5f088e1da93cde0651e8f249` |

La PWA incorpora tarjetas de equipos legibles a 390 px: identidad y endpoint
disponen de 261–276 px en vez de 31,73 px, y las acciones miden al menos 44×44 px.
Pasaron las 905 pruebas y los tipos. El laboratorio con los bytes finales pasó
107 comprobaciones entre dos hosts independientes, incluso con el mismo ID de
conversación sintético: rechazos de clave e instalación cruzadas, borradores e
historial separados, cambio de equipo tras un fallo de conexión, cancelación
de reintentos y revocación de uno sin afectar al otro. Es TLS de laboratorio y
dos procesos locales; no dos máquinas físicas con dominio propio.

El origen HTTPS pasó 243 comprobaciones y el CDN 245. Se activó realmente la
imagen de recuperación r2 conservando las fuentes de las cuatro versiones:
245 comprobaciones. Después se restauró r3: otras 245. El contenedor conserva
UID/GID 101, raíz de solo lectura, 128 MiB sin swap adicional, 0,5 CPU, 64 tareas,
sin capacidades ni puertos de host y con tmpfs de 16 MiB. Ambas imágenes están
protegidas frente a la retención del registro.

Dos ejecuciones de Chrome 155 en Syl Sway oculto pasaron 18 comprobaciones cada
una de actualización explícita, fuentes/avisos y recuperación sin red. Un control
negativo posterior con Chrome inexistente falló antes de navegar y retiró su
perfil y compositor. El recibo distingue los hashes del ejecutor antes y después
del refuerzo de limpieza; no atribuye una ejecución funcional al hash posterior.

La PWA r3 contra station todavía en `7e2a7816` pasó 24 comprobaciones de
vinculación simultánea, recarga y revocación independiente. Se verificaron los
bytes del proceso activo, las vinculaciones anteriores y la salida del grupo
Chrome. No se enviaron prompts. Este resultado cualifica la compatibilidad con
el host anterior; no afirma que el nativo r3 esté instalado.

El nativo r3 pasó por separado 22 comprobaciones con la TUI oficial Grok 1.0.52
y el shell final: turnos en ambas direcciones, recarga sin duplicados, permiso
pendiente conservado, aprobación desde el terminal con un único efecto y
denegación desde la PWA sin repetirlo. Se usaron perfil y proveedor sintéticos
aislados, sin inferencia de pago. Su ciclo de vida local pasó siete comprobaciones
y el doctor catorce tanto sobre el binario como sobre el paquete Nix. Los tres
workflows de `e6d9cc8` terminaron correctamente: CI, Desktop y Nix. Windows ejecutó
el merge sintético del PR; su árbol Git es idéntico al de la candidata. La etapa
firmada de macOS se omitió y no se acredita distribución de Apple. El suplemento
del doctor solo corrige expectativas del arnés y no cambia ese binario.

Station activó r3 a las 03:11:52 UTC mediante su perfil Nix independiente.
Se comprobaron los bytes del ejecutable activo, salud local y HTTPS, los cinco
archivos de identidad idénticos, el líder y terminal conservados y el daemon/CLI
habituales intactos. No se reconstruyó el sistema. El doctor operativo confirmó
sus comprobaciones básicas y de control, pero no acredita por sí solo el socket
del líder, continuidad del terminal, entorno del servicio ni ruta del navegador.

Después de activar, otros dos navegadores independientes pasaron las 24
comprobaciones con el binario y shell finales: vinculación, controles simultáneos,
recarga y revocación de uno sin afectar al otro. Se conservaron los accesos
anteriores y el proceso del host; se retiraron las dos vinculaciones propias y
el grupo Chrome. No hubo prompts ni inferencia. Esta comprobación posterior
complementa la compatibilidad con el nativo anterior, no la reemplaza.

Firefox 157 de Playwright 1.64 pasó 80 comprobaciones con dos escritores y 85
con varios hosts; Chrome 155 pasó otras 107 con el mismo ejecutor final. Los
tres recibos coinciden con los originales, incluidas sus horas. Los perfiles y
procesos propios se retiraron y no hubo errores inesperados. Esta evidencia
cubre Firefox de laboratorio en Linux, con TLS sintético: no acredita Firefox
de distribución habitual, Android ni GPU. Se omiten siete comprobaciones táctiles de CDP y
dieciséis de los dos tamaños que simulan un teclado horizontal; los otros cinco
tamaños sí se probaron. Alcance y recibo en
[cualificación de Firefox](remote-firefox-qualification.md).

El instalador NSIS sin firma construido exactamente desde `e6d9cc8` pasó 31
comprobaciones bajo un usuario estándar en la VM Windows 11: instalación en
perfil nuevo, desinstalación, actualización desde 0.7.0, reparación y nueva
desinstalación. Los binarios y avisos originales coinciden con el artefacto de
CI. Se retiraron la cuenta, tarea, perfil, hives y permiso temporal; se
conservaron los 351 archivos inventariados del usuario habitual, sus registros,
Defender y las definiciones normalizadas de servicios. La limpieza necesitó
reiniciar la VM. El guard inicial falló por el modo transitorio de
`IsolationSession`; el recibo conserva ese fallo y distingue la comprobación
posterior correcta. Esa prueba no acredita interfaz gráfica ni primer arranque
gráfico; los cubre la prueba interactiva descrita más abajo. Siguen sin
acreditarse SmartScreen, MSI, reemplazo real del actualizador CLI ni Windows
físico.
El [recibo nativo en un commit firmado](https://github.com/grok-insider/spanreed/blob/6fd1a55c986cb5fc9372f0ceee94326b05072b0b/docs/evaluation/windows-nsis-e6d9cc8-2026-10-14.json)
identifica sus bytes y estos límites. Es distinto del ensayo histórico de 25
comprobaciones sobre `9eaabe2`.

Recibos: [despliegue r3](evaluation/qualification-r3-deployment-2026-10-14.json),
[terminal r3](evaluation/terminal-continuity-r3-2026-10-14.json) y
[multihost](remote-multihost-qualification.md). Los originales están en
`.worktrees/remote-release-candidate-20261014-r3/`. El primer intento con el S24
encontró Android bloqueado y se detuvo; la prueba física posterior se describe
más abajo. El soak de 24 horas **falló** en el ciclo 87, tras 86 ciclos
completos: al reconectar, las páginas reciben una instantánea limitada a 512
mensajes y 256 KiB, y la historia más antigua desaparece sin aviso. No es un
duplicado; es un defecto del producto que la siguiente candidata corrige y
vuelve a probar durante 24 horas. La cohorte de siete días no cuenta como
completada. Las publicaciones siguen cerradas: el laboratorio
del almacenamiento reprodujo un PUT tardío que devuelve un objeto después de
DELETE 204 y HEAD 404; no se promete borrado físico sobre esa evidencia.

## S24 físico con la tercera candidata

Entre las 09:16 y las 09:30 UTC, el Samsung Galaxy S24 Ultra (Android 16,
Chrome 154) probó la PWA r3 contra el nativo r3 ya activado en station. Se usó
el WebAPK que ya estaba instalado, sin reinstalarlo. Al abrirse seguía con el
shell de la primera candidata (`fe9e3a52…`) y un service worker en espera; no
cambió nada hasta pulsar «Update and reload», que activó directamente el shell
`e2ed580c…`. La segunda candidata nunca llegó a este teléfono. El
emparejamiento guardado conectó sin volver a registrar el dispositivo.

Con el teclado de Android abierto en vertical, el editor y Enviar quedaron
enteros, sin recorte de ningún ancestro, y la comprobación de pulsación los
identificó. En horizontal se midió primero sin teclado (354 px de altura útil)
y después con el teclado abierto: **136 px de altura útil, editor entre 91,2 y
135,2 px y Enviar de 44 × 44 px, ambos visibles y pulsables**. No hubo
desplazamiento horizontal y el borrador sintético se conservó al girar. Es la
corrección que la candidata anterior no superaba. Un primer intento con
teclado dejó la altura en 354 px porque el teclado no llegó a abrirse; se
conserva como medida sin teclado.

Se forzó la parada de Chrome con `am force-stop` cuando la única pestaña era la
PWA. Al relanzar el WebAPK y pulsar Connect, la misma conversación volvió sin
volver a elegirla, con el mismo borrador sin enviar, el mismo shell y un
documento nuevo. Esto no es una expulsión del proceso por Android.

Se envió un único prompt sintético autorizado y se pasó a Inicio. El host
respondió con el texto pedido. Android publicó una notificación genérica
(«Grok», «There is activity on your computer.», visibilidad `PRIVATE` y
versión pública «Contenidos ocultos») **3,5 s después de completar el paso a
Inicio**. Los relojes del móvil y del host coincidían al segundo en una
comparación posterior, así que el margen es de al menos 2,5 s. Sustituyó a la
notificación de la primera prueba, que tenía la misma etiqueta y seguía en la
bandeja. No llevaba texto de la conversación. Al pulsarla en la bandeja de
Android, el mismo documento pasó a primer plano, conectado y listo, en la
conversación que ya mostraba. No se probó la navegación desde otra ruta ni la
apertura con la aplicación cerrada.

Al terminar, el borrador estaba vacío, la rotación automática restaurada, el
permiso de notificaciones conservado y no quedaba ningún reenvío de ADB. No se
creó ni revocó ningún emparejamiento y no se tocaron Wi-Fi ni Tailscale. La
conversación sintética se conserva para el propietario. El
[recibo saneado](evaluation/deployed-s24-r3-2026-10-14.json) guarda medidas y
hashes. Las capturas, el volcado de notificaciones, los nombres privados y los
identificadores se quedan en local.

Siguen pendientes en el S24: instalación desde cero, expulsión del proceso por
Android, suspensión de 30 minutos y de 8 horas, cambio de Wi-Fi a datos móviles,
notificación con la pantalla bloqueada, compartir desde otra aplicación,
TalkBack y apertura sin red del shell r3.

## Instalador de Windows con interfaz gráfica

El mismo instalador NSIS sin firma (`d0220e5f…`) se ejecutó de forma
interactiva con otra cuenta estándar nueva, en una segunda sesión de consola de
la VM, mientras la sesión de `friend` seguía abierta. Mostró bienvenida,
licencia, carpeta de instalación en `LocalAppData` y fin, y terminó con código
0. Las capturas no muestran ningún aviso de UAC; en esta VM aparecería en el
escritorio capturado, y el modo de usuario no pide elevación. El ejecutable instalado
coincide con el extraído en CI. El primer arranque gráfico mostró el resumen,
Ajustes y la licencia AGPL, y la bandeja ofreció sus cuatro acciones. El
registro de aplicaciones de Windows no anotó errores de Spanreed ni de
WebView2. La desinstalación gráfica terminó con código 0, retiró programa,
registro y acceso directo, y conservó los datos del usuario: la casilla
«Delete the application data» estaba desmarcada al confirmar.

La limpieza retiró la cuenta, el perfil, su directorio, la clave de
ProfileList, los hives y sus permisos en el directorio de prueba, sin
reiniciar. Durante la limpieza, Windows pasó `IsolationSession` de Manual a
Auto y volvió a Manual 34 s después sin intervención; BITS había hecho lo
mismo antes de empezar. Una comparación posterior de solo lectura encontró
iguales los archivos y el registro de `friend`, el registro de máquina,
Defender, la política de seguridad y los servicios, normalizados y sin
normalizar. No se atribuyen esos cambios a Spanreed ni se demuestra su causa.
La prueba la condujeron agentes de Codex mediante Syl hasta la desinstalación;
la limpieza y la comparación final se terminaron después mediante el agente de
QEMU. Recibo: [prueba interactiva](https://github.com/grok-insider/spanreed/blob/f0a91a3/docs/evaluation/windows-gui-e6d9cc8-2026-10-14.json).
No acredita SmartScreen (el instalador copiado no tenía la marca de descarga),
artefacto firmado, MSI, actualización con la aplicación abierta, reemplazo del
actualizador CLI, pérdida de corriente, Windows físico ni herramientas de
accesibilidad de Windows.

## Segunda candidata, histórica desde las 01:08 UTC

| Componente | Revisión o SHA-256 |
| --- | --- |
| Portable | `00393e13e45b7dfbbfcc9844b46d758f2a582486` |
| Librerías canónicas | `648741029f5daceeaeb61395f00f529213011926` |
| Spanreed y archivo de fuentes | `7e2a7816c73d7e58b64852509b47ede75527859a` |
| Archivo de fuentes, 4.469.779 bytes | `377d1352f3a6366472216216755b35fc8fc7cde89e3dd8fde4a6655588ef0197` |
| Shell | `ff22898fc96c5524cf91c5af7bf30934d03e2b71e70360fc69d43e7ff96631ac` |
| Binario GNU de station | `90d3f5078a3f392220f59d80d09ae96ad3f8bf4b33b28ab6f5f3d1ccbf4c6bf3` |
| Imagen desplegada | `sha256:6df6e4e20580c51a5f4cb4f09bf1fa694d0dcb03acb5f4c1d2bf874115149b24` |
| Imagen de recuperación | `sha256:cb2d1f85c12b0da067a3b2f727c9d006dc7506dfecd3b453d85f88e234f6ee3b` |

Incluye las correcciones de disposición horizontal y confirmación de revocación
descritas al final. La PWA pasó 905 pruebas, tipos y CI. Los avisos GNU incluyen
387 paquetes, 815 originales y 370 fuentes de registro; el suplemento WASM
conserva 49 paquetes y 182 originales. El wrapper Nix conserva exactamente el
binario cualificado y su cierre de ejecución. La prueba de ciclo de vida pasó
con estado propio; su primer intento quedó registrado como fallo del arnés por
una ruta de socket Unix demasiado larga, antes de arrancar la candidata.

Los dos adaptadores pasaron diez pruebas HTTP cada uno. Contra el despliegue
real pasaron 238 comprobaciones por Cloudflare y 236 contra el origen TLS.
Se activó realmente la recuperación desde Coolify, pasó otras 238 comprobaciones
y se restauró la candidata: 238 correctas. Ambos adaptadores conservan las
fuentes y avisos de los shells `ff22898f…`, `fe9e3a52…` y `a3612b47…`.
Los artefactos están protegidos frente a la retención del registro.

Chrome 155 en Sway oculto pasó 18 comprobaciones de actualización explícita
desde `fe9e3a52…`, descarga de fuentes y avisos, apertura sin red y recuperación
explícita sin red. Otros dos contextos independientes pasaron 19 comprobaciones
con el host real por Tailscale: emparejamiento, controles simultáneos, reconexión,
confirmación de «Forget this browser» y conservación del otro cliente. Las dos
retiradas se comprobaron también en el host; se conservaron los emparejamientos
preexistentes. No se enviaron prompts en esta prueba.

Station conserva idénticos sus cinco archivos de identidad y configuración.
El líder compartido, el terminal abierto y el daemon de uso habitual conservaron
su identidad de proceso. El servicio QA responde por loopback y Tailscale; no
se reconstruyó NixOS ni Home Manager. Mantener vivos esos procesos no acredita
todavía la continuación funcional de una conversación desde el terminal.

El [recibo saneado](evaluation/deployed-revocation-2026-10-14-r2.json) contiene
los hashes y límites de cada comprobación. Los originales están en
`.worktrees/remote-release-candidate-20261014-r2/`. Los cambios posteriores de
documentación no redefinen el artefacto. La prueba física anterior del S24,
incluida su notificación real, pertenece al shell y binario anteriores; esta
segunda candidata aún necesita su propia prueba física. No se inició un soak
de 24 horas ni una cohorte de siete días, ni se publicó una release estable.

## Primer despliegue: identidades históricas

| Componente | Revisión o SHA-256 |
| --- | --- |
| Portable del shell | `5bdcf17b493a25feb7101fba33fbde8a8a145713` |
| Librerías del artefacto | `6ae91bdca8fa9fcdae6971618363cb976d410087` |
| Spanreed del archivo de fuentes web | `8b12b86b67a0d6aceadfde3aeb4a88768335cdd0` |
| Archivo de fuentes web, 4.415.286 bytes | `8ce266700085c207c6d40a2dfa9e972e868b84a10f5981aaa904868cd69a083b` |
| Shell nuevo | `fe9e3a52d2d3603472c413511e075bd03bd0c80af282165cbe831b0790bac982` |
| Shell anterior conservado | `a3612b47d5994d284e5d9729dd2918dfdbea69cc1d262e0ef789a4f22c57fe6f` |
| Spanreed ejecutándose en station | `ce2692d2c7f7ca7db4d15f25c213a2a050baabba` |
| Binario CLI de station, 37.979.328 bytes | `e4fa51029b1d601f577808ec8e9dee2f8588542804d75e61081d0e8d467aca07` |

El commit nativo posterior añade la liberación explícita del bloqueo Unix del
actualizador y preserva los bytes de avisos legales con atributos Git. No cambia
el shell desplegado. Los checkouts congelados del shell, del archivo de fuentes
y del nativo permanecen limpios; los cambios posteriores de documentación no
redefinen estas identidades.

## Hosting, actualización y recuperación

Coolify sirve la imagen
`10.0.0.2:5000/grokinsider/grok-remote-qa@sha256:70146ff9cadbb8fb30738008838c9932a8163d3aae377546e769c7f4051bdd44`
en el servicio `em7w9gpwwbnznm6eyoaw4skp` de fabrials-1. La imagen de recuperación
`sha256:47dc752c0ca9495ab7dbda56415e0ec785075bc8fc67ab1ff798d34870e66f18`
sirve el shell anterior y conserva las fuentes y avisos de ambas versiones.
Ambas referencias están protegidas frente a la retención del registro.

La build/adaptador pasó 15 pruebas y el adaptador de recuperación 10 pruebas
HTTP. El origen con TLS verificado pasó 229 comprobaciones y el CDN público 231.
Se cambió realmente a la imagen anterior mediante Coolify, se verificó su salud
y se pasaron otras 231 comprobaciones. Después se restauró la imagen nueva:
salud correcta y 231 comprobaciones. El contenedor efectivo usa UID/GID 101,
raíz de solo lectura, tmpfs de 16 MiB, 128 MiB sin swap adicional, 0,5 CPU,
64 procesos, ninguna capacidad Linux, `no-new-privileges`, registros acotados
y ningún puerto publicado en el host.

Chrome 155, en Syl Sway oculto, pasó 18 comprobaciones contra el HTTPS público:
el shell anterior permaneció activo hasta pulsar Update, el nuevo tenía una
identidad diferente, los archivos de fuentes y avisos de N y N−1 se descargaron
con los hashes exactos, el nuevo abrió sin red y la recuperación explícita sin
red restauró el shell anterior. Esta prueba no incluyó borradores,
emparejamientos ni turnos activos durante el cambio de versión.

Recibos en `.worktrees/remote-release-candidate-20261014/receipts/`:
`coolify-image.json`, `coolify-runtime.json`, `origin-http.json`, `cdn-http.json`,
`coolify-rollback-observed.json`, `cdn-rollback-http.json`,
`coolify-restored-observed.json`, `cdn-restored-http.json` y
`browser-update-report.json`. El contexto reproducible es el directorio
adyacente `coolify/`; `coolify-rollback/` conserva la recuperación.

## Host privado y dos navegadores

La instalación QA de station se actualizó mediante su perfil Nix independiente,
sin reconstruir NixOS ni sustituir el CLI, daemon de uso o escritorio habituales.
Su unidad propia `spanreed-remote-qa.service` está activa. El estado existente
conservó exactamente identidad, emparejamientos, VAPID, origen y proyectos.
Tailscale Serve sigue publicando únicamente el listener loopback mediante HTTPS
privado, sin Funnel. `/healthz` conserva `protocolVersion: 2` del bridge legado;
el protocolo remoto negociado es 4.

Antes de detener la unidad anterior se trasladó su líder Grok compartido y sus
descendientes a un scope de usuario independiente, comprobando PID, inicio y
cgroup antes y después. El líder y el terminal que permanecía abierto siguieron
vivos. El procedimiento se probó antes con procesos sintéticos propios. Esta
migración puntual no resuelve por sí sola el ciclo de vida de futuros líderes:
la separación desde su creación necesita su propia implementación y pruebas.
No detener el scope preservado como limpieza de QA.

Dos contextos de navegador independientes pasaron 13 comprobaciones contra el
shell público y el Spanreed real por Tailscale: emparejamiento Noise de un uso,
consumo del fragmento, ambos con controles habilitados, ausencia de exclusión
entre dispositivos, reconexión sin nuevo emparejamiento y el otro navegador
todavía operativo. Solo se revocaron los dos emparejamientos creados por la
prueba. No se enviaron prompts: esta evidencia comprueba conexión y permiso
simultáneos, no la ejecución de dos turnos. La cola ya tiene su prueba separada
de 53 comprobaciones con ACP determinista.

Los recibos resumidos de navegador están en
`evaluation/deployed-update-2026-10-14.json` y
`evaluation/deployed-multiwriter-2026-10-14.json`.

## Aplicación nativa y límites

La build CLI desde el árbol limpio `ce2692d` y sus 18 comprobaciones de ciclo de
vida pasaron. El actualizador Unix pasó 32 pruebas; una mutación sin la
liberación explícita del bloqueo reproduce el fallo que originó el arreglo.

La aplicación Tauri Linux se construyó con avisos originales obligatorios.
En una instancia privada de Syl Sway se abrió Settings → View licenses y se
extrajo el texto mediante el menú nativo: 5.068.946 bytes, exactamente el conjunto
esperado tras la normalización de saltos de línea del textarea. El binario
conserva los 5.069.785 bytes originales, comprobados separadamente. Se cerraron
la aplicación, el lanzador y el compositor de esa prueba. No es una prueba de
instalación `.deb`, de NSIS ni de un paquete Nix general.

Siguen pendientes la instalación PWA desde cero, la corrección desplegada del
editor horizontal del S24, la expulsión del proceso o suspensión larga de Android,
los cambios físicos de red, instalación/recuperación completas de Windows,
el soak de 24 horas, la
infraestructura de borrado/restauración de publicaciones y la cohorte de tiempo
real. No se ha iniciado ni simulado como transcurrida la cohorte de siete días.

## S24 físico: versión desplegada y experimento de interfaz

El Samsung Galaxy S24 Ultra SM-S928B, Android 16 y Chrome 154.0.8037.126 ejecutó
el WebAPK que ya estaba instalado. La acción visible «Update and reload» pasó
de `index-jrE2fKnr.js` a `index-DpDoWcjC.js`, correspondiente al shell
`fe9e3a52…` de la tabla. El host permaneció en `ce2692d` durante toda la prueba.
No es una instalación nueva ni una cualificación del binario posterior con el
arreglo de ciclo de vida ACP.

El emparejamiento guardado conectó sin volver a registrar el teléfono. En
vertical, el teclado dejó 491,2 px de altura visible: el editor terminaba a
437,2 px y Enviar a 481,2 px. Se mantuvo el borrador sintético sin enviar, también
al girar, y no hubo desbordamiento horizontal. La apertura sin red cargó el shell
actual en modo independiente mientras fallaba una petición de red sin caché;
no mostró una conversación privada. Los dos shells conservados tenían 47
entradas cada uno, todas del mismo origen y ninguna de API o sesión. La red se
desactivó solo mediante CDP en esa página: Wi-Fi y Tailscale siguieron activos.
La prueba del borrador no demuestra que esa emulación cortase el WebSocket que
ya estaba abierto.

Se aceptó el diálogo normal de Android mediante Syl, sin sobrescribir permisos
desde DevTools: «Configured for this computer» y permiso `granted`. Un único
prompt sintético autorizado pidió responder «QA OK» sin herramientas ni
archivos; esa fue la respuesta. Android registró una notificación real de la
PWA con título «Grok» y texto «There is activity on your computer.», visibilidad
`PRIVATE` y versión pública «Contenidos ocultos». No llevaba conversación ni
detalles de aprobación. Se comprobó su registro, no la pantalla bloqueada ni
la apertura al pulsarla. Hubo una captura entre Enviar e Inicio de Android, por
lo que no se atribuye la entrega a un momento anterior o posterior exacto al
paso a segundo plano.

Durante el segundo plano se observó «Disconnected / Reconnecting». Al volver
al mismo WebAPK y al mismo target, la misma sesión estaba en Ready en la
observación realizada tras esperar un segundo. Esto comprueba esa recuperación
corta; no mide una latencia garantizada ni cubre expulsión del proceso,
suspensión larga o cambio de Wi-Fi a datos móviles.

La candidata desplegada **falló en horizontal**: a 750 × 354 px, el editor
ocupaba de 342,4 a 406,4 px y Enviar terminaba a 450,4 px, recortados por el
contenedor. El aviso de recuperación del shell seguía visible. Se probaron
cambios temporales de clases y reglas CSSOM en el teléfono, sin modificar el
despliegue. Permitir encoger el contenido y poner el editor en horizontal no
bastó; limitarlo a 44 px lo hizo accesible sin teclado, pero dejó casi sin
altura la conversación. Con el teclado abierto, la zona visible bajó a 136 px
y volvió el recorte. Comprobar solo el rectángulo DOM habría dado un falso
positivo: también se verificaron los contenedores que recortan y qué elemento
recibía la pulsación en ese punto.

El último experimento mantuvo el editor compacto, ocultó la cabecera del
ordenador y el aviso de actualización mientras el editor tenía foco y la
altura era como máximo 300 px, y retiró el margen interior del shell. Editor y
Enviar quedaron enteros entre 87,47 y 131,47 px, dentro del recorte disponible
de 48,53 a 135,47 px; el botón conservó 44 × 44 px. La comprobación con
`elementFromPoint` identificó el editor y el botón en sus respectivos centros.
No se pulsó Enviar durante ese experimento. La cabecera de sesión seguía
visible. **Este resultado
pertenece al experimento físico, no al código definitivo ni a un despliegue
corregido.** No se probaron en él una cola con mensajes, imágenes pendientes ni
avisos de validación.

Se retiraron todas las reglas y clases temporales, se vació el borrador y se
restauró la rotación automática. La PWA quedó conectada en vertical y se
conservó la autorización de notificaciones. No se creó ni revocó ningún
emparejamiento. Se cerraron la sesión propia de Syl y su forward ADB sin parar
la app. El [recibo saneado](evaluation/deployed-s24-2026-10-14.json) conserva
identidades, medidas y hashes de evidencia local; las capturas y registros
brutos, las direcciones privadas y los identificadores de sesión no se suben.

## Corrección de disposición horizontal, candidata local

La corrección posterior al S24 pasó 884 pruebas y comprobación de tipos. El
arnés de Chrome 155 en Sway oculto pasó 95 comprobaciones con dos mensajes en
una cola pausada, borrador guardado, historial local y un aviso de instalación
generado por el evento sintético del arnés. Incluyó controles táctiles en
390×844, 844×390, 750×354, 750×136, 667×136 y 390×430, además de 2560×1440.
El editor y Enviar pasan límites de viewport, recorte de ancestros y hit testing;
el documento no se desplaza y la navegación reaparece al salir del editor.
La cola se elimina explícitamente sin ejecutar sus mensajes. El borrador y la
selección se conservan durante los cambios de altura y el zoom no se interpreta
como teclado.

El [recibo local](evaluation/landscape-layout-2026-10-14.json) liga el arnés y los
bytes del shell probados. Todavía no cualifica el despliegue definitivo ni
imágenes seleccionadas dentro de esta matriz. El fallo intermitente de revocar
antes de negociar el protocolo observado en otra pasada se investiga por
separado; esta pasada correcta no demuestra que esa carrera esté resuelta.

## Cambio de shell con trabajo activo

La ampliación de `scripts/qualify-direct-browser.ts` pasó 71 comprobaciones con
dos contextos independientes en Chrome 155 dentro de Sway oculto. Sirvió los
artefactos exactos ya retenidos: shell actual `fe9e3a52…`, anterior `a3612b47…`
y vuelta al actual. El cambio de shell requirió una acción explícita. Durante
ambas transiciones había un turno ACP sintético activo, un sucesor en la cola
duradera y un borrador local sin enviar.

Se conservaron emparejamiento, borrador, identificador del turno y recibos; el
otro navegador permaneció operativo. La versión anterior mostró su aviso de
solo lectura y deshabilitó el editor. Al volver a la actual, ambos clientes
convergieron y la cola ejecutó exactamente una vez cada mensaje aceptado. El
mensaje retirado nunca se ejecutó. La prueba mantuvo el host activo.

El [recibo](evaluation/active-shell-upgrade-2026-10-14.json) identifica artefactos,
fuentes, ejecutable sintético y arnés. Esta prueba usa TLS de laboratorio y no
repite el despliegue CDN; el despliegue real anterior se comprobó por separado.
No cualifica Android ni inferencia, ni el binario posterior con el arreglo del
ciclo de vida ACP. No se abrió ninguna ventana en el escritorio del usuario.


## Imágenes y confirmación de revocación, candidata local posterior

La matriz se repitió tres veces con una imagen PNG sintética seleccionada:
96 comprobaciones correctas en cada pasada. Incluyó la cola pausada, el borrador,
el aviso de instalación y los siete tamaños anteriores. La imagen y el texto
se conservaron sin enviar; la retirada local de la imagen fue explícita.
El fixture ahora usa el supervisor normal del host, que proyecta las capacidades
ACP, en vez de adjuntar el proceso sin proyectarlas. Los hashes y las limitaciones
están en [el recibo](evaluation/landscape-images-revocation-2026-10-14.json).

Estas pruebas descubrieron dos carreras de «Forget this browser». Primero, una
pulsación antes de negociar las capacidades podía enviar el protocolo anterior;
ahora se restaura la autoridad y se valida la negociación antes de emitir una
única retirada. Después, una respuesta válida inmediatamente anterior al cierre
podía perderse en la cola asíncrona del WebSocket, o quedar invalidada cuando la
interfaz procesaba la revocación antes de terminar de leer esa respuesta.
Ahora se procesan los mensajes recibidos antes del cierre y, únicamente durante
la retirada explícita, se entrega el aviso de revocación después de validar su
respuesta. Un cierre anterior a la respuesta, una respuesta inválida o perdida
y una autoridad descartada manualmente siguen sin confirmar la operación.
No se repite el efecto automáticamente.

Pasaron las 905 pruebas de la PWA y la comprobación de tipos. Retirar por separado
cada una de las dos correcciones del cierre hace fallar las nuevas regresiones.
El host pasó además una prueba de orden de confirmación con 32 conexiones,
una suscripción y ocho lecturas en vuelo por conexión; no necesitó un cambio de
runtime para resolver esta carrera. Las tres pasadas de navegador usan el
fixture limpio, sin la instrumentación temporal de diagnóstico. Esta evidencia
sigue siendo local: no actualiza la identidad del despliegue de la tabla inicial.
