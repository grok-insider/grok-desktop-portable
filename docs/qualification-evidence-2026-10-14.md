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

Siguen pendientes la cualificación física del S24 de esta candidata, push real,
suspensión y cambios de red, instalación/recuperación completas de Windows,
turnos y borradores durante una actualización real, el soak de 24 horas, la
infraestructura de borrado/restauración de publicaciones y la cohorte de tiempo
real. No se ha iniciado ni simulado como transcurrida la cohorte de siete días.
