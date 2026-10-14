# Candidata multidevice desplegada, 2026-10-14

Este recibo identifica la PWA que sirve `https://grok.fabrials.com` y el host
privado instalado en station. Las horas de los recibos están en UTC; la fecha
del documento corresponde a Europe/Paris. Los PRs siguen en borrador y las
publicaciones públicas siguen cerradas.

## Identidades

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
