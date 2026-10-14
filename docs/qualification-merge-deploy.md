# Integración y despliegue de pruebas en grok.fabrials.com

Pedido del 2026-10-13: crear commits y preparar la integración y el despliegue
de pruebas. El destino de esta candidata es `https://grok.fabrials.com`.
`https://desktop.grok.me` conserva el valor por defecto del producto.
Esta preparación no autoriza a abrir las publicaciones que siguen bloqueadas
por los requisitos de borrado, restauración y capacidad del
[plan de lanzamiento](public-release-plan.md).

## Orden de integración

| Repositorio | Rama del trabajo | Destino de PR | Dependencia |
| --- | --- | --- | --- |
| [fabrials-libs #1](https://github.com/grok-insider/fabrials-libs/pull/1) | feat/grok-remote | master | Núcleo de transporte, identidad, contenido y permisos |
| [grok-desktop-portable #7](https://github.com/grok-insider/grok-desktop-portable/pull/7) | feat/grok-remote | dev | SHA revisado de las librerías para Noise |
| [spanreed #56](https://github.com/grok-insider/spanreed/pull/56) | feat/grok-remote | dev | Subtree canónico y PWA construida desde commits exactos |
| [fabrials-web #7](https://github.com/grok-insider/fabrials-web/pull/7) | feat/grok-remote | master | Despliegue de autenticación separado; publicaciones cerradas |
| [fabrials-admin #1](https://github.com/grok-insider/fabrials-admin/pull/1) | feat/remote-browser-family | master | Introspección de la familia de navegador en Web |
| [ai-relay #29](https://github.com/grok-insider/ai-relay/pull/29) | feat/remote-browser-family | master | Introspección del panel; API nativa separada |

No fusionar directamente Spanreed en `master`: esa rama publica una release.
No activar auto-merge. El merge de Web puede activar su despliegue y modifica
autenticación compartida; requiere revisar sus consumidores y su migración por
separado. La prueba privada de la PWA no depende de desplegar Web.

Antes de actualizar o fusionar los PRs, hacer fetch de cada remoto, comparar el destino actualizado
con la base revisada y resolver cualquier divergencia en una rama de integración.
Las referencias locales coincidían con las bases del trabajo al preparar este
documento; no sustituyen un fetch reciente. Repetir los checks afectados después
de resolver conflictos. Los resultados históricos identifican sus propios
artefactos y no validan automáticamente el origen nuevo.

## Construcción desde commits revisados

1. Crear los commits de librerías y Portable; verificar su contenido, firma y
   ausencia de cambios pendientes. No incluir cachés, perfiles, claves o logs.
2. Crear el commit de integración de Spanreed y ejecutar su
   `scripts/sync-fabrials-libs.sh` con el checkout canónico y el SHA aprobado.
   El script debe registrar un subtree y su manifiesto; no editar el vendor.
3. Resolver el lockfile nativo para esa revisión sin actualizar paquetes ajenos
   al cambio. Ejecutar formato, Clippy y las suites del consumidor y del host.
4. Construir la PWA embebida con el origen de pruebas explícito y registrar sus
   fuentes limpias. Crear el commit de los assets y comprobar `--release`.
5. Crear el archivo de fuentes desde ese commit limpio y el Portable exacto.
   Construir y verificar el artefacto con `--for-deploy`; su shell, fuentes,
   instaladores y las dos configuraciones de hosting deben corresponder.

El embed del commit Spanreed `e6d9cc8` corresponde al origen QA y a fuentes
limpias verificadas; la candidata desplegada y sus hashes están en el
[recibo del 2026-10-14](qualification-evidence-2026-10-14.md). Cada revisión posterior
de librerías o Portable exige regenerar su identidad, crear un nuevo commit del
manifiesto y construir otro archivo de fuentes, aunque los bytes del shell no
cambien. No modificar a mano las identidades ni los textos de licencia.

Una corrección exclusivamente nativa puede distribuirse con su nuevo archivo
de fuentes sin volver a desplegar la PWA cuando sus 47 archivos siguen siendo
idénticos. En ese caso, conservar el archivo de fuentes y los metadatos
inmutables del shell ya publicado: no sustituir `/sources/<shell-id>.json`
por los del binario nuevo. La identidad del paquete nativo y la del shell son
evidencias distintas. Esta fue la estrategia del cierre WebSocket `f3ebb334`;
la candidata r3 posterior reconstruye también la PWA con Portable `abe4f35`.

Comandos de construcción, desde el worktree de Spanreed, con los SHA y las
rutas previamente revisados:

```sh
FABRIALS_REMOTE_ORIGIN=https://grok.fabrials.com \
  python3 scripts/remote-assets.py build \
  --portable ../remote-portable --libs ../remote-libs
python3 scripts/remote-assets.py check --release
```

Después de commitear esos assets, crear el archivo mediante
`scripts/source-bundle.py build` con `--version` igual a `Cargo.toml` y `--sha`
igual al HEAD limpio. Desde Portable, `scripts/build-remote-artifact.mjs` admite
`--origin https://grok.fabrials.com`, `--libs`, `--spanreed`, `--source-archive`
y `--output`. El directorio de salida debe ser nuevo y externo al checkout.

El workflow de artefactos diferencia la candidata de pruebas de la release
estable: el origen de pruebas construye su archivo de fuentes desde el checkout
nativo exacto; producción descarga el de la release publicada. Ambas rutas
deben pasar la misma verificación de correspondencia. No publicar una release
estable únicamente para obtener un artefacto de pruebas.

## Hosting que debe quedar preparado

El entorno de pruebas ya usa el servicio Compose `grok-remote-qa` de Coolify en
fabrials-1, UUID `em7w9gpwwbnznm6eyoaw4skp`, con el adaptador estático verificado
y la imagen fijada por digest. El procedimiento vigente está en
[remote-coolify.md](remote-coolify.md); Vercel sigue siendo el hosting de
`desktop.grok.me`. No trasladar ese origen ni el alias
`remote.fabrials.com` al servicio de pruebas. La configuración de pruebas rechaza otro
Host y marca las respuestas para que los buscadores no las indexen; `noindex`
no constituye control de acceso.

El hosting sirve archivos estáticos y fuentes. No necesita credenciales Grok,
claves de publicaciones ni acceso al equipo del usuario. Las sesiones privadas
siguen conectando con el host del usuario por HTTPS/WSS y Noise. El artefacto
debe incorporar la configuración de pruebas exacta, no una edición manual del
manifiesto de producción después de construirlo.

Conservar el artefacto anterior por hash para rollback y conservar los archivos
`/sources/` de las versiones que aún puedan ejecutar los clientes. Verificar el
archivo de fuentes de N y N−1 por HTTP antes de aceptar una actualización.
Una candidata inicial no demuestra la retención de fuentes durante una segunda
publicación. Limitar explícitamente la retención de artefactos de CI.

## Host de pruebas y aceptación en producción

Usar un directorio de estado separado, mediante `FABRIALS_AGENT_STATE_DIR`.
Ejecutar la candidata de Spanreed con
`remote private-serve https://HOST-PRIVADO --web-origin https://grok.fabrials.com`
y crear el enlace con el mismo endpoint y origen mediante `private-pair`.
`HOST-PRIVADO` debe ser un dominio HTTPS real del host, por ejemplo el nombre
Tailscale con certificado válido. No publicar el puerto ACP de Grok.

Para un host de laboratorio nuevo, mantenerlo en primer plano y detenerlo con `private-stop`
usando el mismo directorio de estado. No instalar un servicio de usuario para
esta candidata: los nombres de servicio son únicos por usuario y podrían
reemplazar o detener el host habitual. `service print`, `service install` y
`service uninstall` rechazan los overrides explícitos de estado, incluidos
`GROK_BRIDGE_STATE_DIR` y `GROK_LIGHT_STATE_DIR`. Station ya tiene una unidad QA
independiente, `spanreed-remote-qa.service`, cuyo perfil Nix y procedimiento de
actualización se documentan en Spanreed `docs/remote.md`. Conservar sus nombres,
estado y procesos compartidos; no reemplazarla mediante el instalador normal.

El origen se persiste junto a la identidad: un estado de producción no se
convierte en estado de pruebas al añadir el flag. Los estados antiguos mantienen
`desktop.grok.me`. Vincular de nuevo los dispositivos en el origen de pruebas;
el almacenamiento del navegador permanece separado por origen.

Antes de llamar al despliegue apto para pruebas de producto:

- Verificar HTTPS, Host, CSP, MIME de WASM/worker, cabeceras de caché y rutas 404.
- Verificar fuentes y licencias del shell cargado, con hashes coincidentes.
- Vincular por Tailscale, reconectar, revocar y probar con Fabrials inaccesible.
- Instalar en el S24 y medir teclado, rotación, suspensión, cambios de red y push.
- Probar continuidad con una sesión real del terminal y una imagen de prueba.
- Comprobar aislamiento entre equipos y que publicaciones siguen denegadas.
- Medir los objetivos y ejecutar las pruebas prolongadas del plan de lanzamiento.

El acceso opcional a SSO de pruebas necesita desplegar Web con los flags
descritos en su `docs/grok-remote.md`. Es una operación separada; el opt-in
no habilita las publicaciones ni amplía su consentimiento a este dominio.

## Estado de la preparación y evidencia

Los bloqueos iniciales de permisos SSH/GPG y `EPERM` de sockets y builds se
superaron cuando cambió el entorno. Se crearon commits firmados, seis PRs en
borrador, una build cifrada, un archivo real de fuentes y una candidata verificada
con navegador. Las identidades, hashes y límites están en el
[recibo fechado](qualification-evidence-2026-10-13.md). Los recibos de la fase
restringida siguen siendo históricos y no describen el resultado posterior.

Los tres workflows de la candidata nativa r3 pasan. Su instalador NSIS exacto
pasó 31 comprobaciones bajo un usuario estándar en la VM y la limpieza final
conservó los datos y registros anteriores. Una prueba interactiva posterior
del mismo instalador cubrió sus páginas, el primer arranque gráfico, la bandeja
y la desinstalación gráfica; SmartScreen, firma y distribución estable siguen
sin cualificar. Firefox de laboratorio pasó 80 comprobaciones
con dos escritores y 85 con varios hosts. Cada suplemento posterior de pruebas
o documentación necesita sus propios checks y no redefine los bytes de r3.
La candidata multidevice del 2026-10-14 ya está
desplegada en Coolify: TLS/CDN, recuperación real del contenedor, actualización
de shell N/N−1 y dos navegadores emparejados con station están comprobados.
La prueba física de r3 en el S24 pasó teclado vertical y horizontal,
recuperación tras forzar la parada de Chrome, notificación real en segundo
plano y su apertura; siguen pendientes instalación desde cero, suspensión
larga, cambio de red, pantalla bloqueada y compartir desde otra aplicación. La prueba de 24 horas iniciada
el 14 de octubre a las 03:13:42 UTC no cuenta como aprobada hasta terminar y
revisar sus invariantes, límites y limpieza. Las publicaciones siguen cerradas
por el contraejemplo de escritura tardía tras el borrado en S3.
La instalación QA de station usa un perfil y una unidad de usuario independientes,
preparados específicamente para conservar su estado y el líder compartido; no
se debe sustituir esa receta por el instalador de servicio normal. Guardar los recibos de reconstrucciones posteriores
fuera de los inputs del artefacto; una prueba no debe cambiar el commit que
identifica. Mantener cada candidata anterior y su evidencia con sus hashes.
