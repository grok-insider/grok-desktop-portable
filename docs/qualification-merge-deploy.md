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
| fabrials-libs | feat/grok-remote | master | Núcleo de transporte, identidad, contenido y permisos |
| grok-desktop-portable | feat/grok-remote | dev | SHA revisado de las librerías para Noise |
| spanreed | feat/grok-remote | dev | Subtree canónico y PWA construida desde commits exactos |
| fabrials-web | feat/grok-remote | master | Despliegue de autenticación separado; publicaciones cerradas |

No fusionar directamente Spanreed en `master`: esa rama publica una release.
No activar auto-merge. El merge de Web puede activar su despliegue y modifica
autenticación compartida; requiere revisar sus consumidores y su migración por
separado. La prueba privada de la PWA no depende de desplegar Web.

Antes de abrir PRs, hacer fetch de cada remoto, comparar el destino actualizado
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

Los archivos actuales de `assets/remote-web/` y `assets/remote-web.source.json`
son de la candidata histórica, con fuentes sucias y otro origen. Se conservan
en disco, fuera del índice del primer commit de Spanreed. Regenerarlos para el
commit de assets; no publicarlos ni limpiar a mano los textos de licencia, porque
se rompería su correspondencia con el manifiesto y las pruebas anteriores.

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

Usar un proyecto Vercel separado para `grok.fabrials.com`, con el Build Output
API precompilado y verificado. Confirmar la identidad del proyecto y el DNS antes
de asociar el dominio. No trasladar `desktop.grok.me` ni el alias
`remote.fabrials.com` a este proyecto. La configuración de pruebas rechaza otro
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

Mantener este host de pruebas en primer plano y detenerlo con `private-stop`
usando el mismo directorio de estado. No instalar un servicio de usuario para
esta candidata: los nombres de servicio son únicos por usuario y podrían
reemplazar o detener el host habitual. `service print`, `service install` y
`service uninstall` rechazan los overrides explícitos de estado, incluidos
`GROK_BRIDGE_STATE_DIR` y `GROK_LIGHT_STATE_DIR`.

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

## Restricciones observadas durante la preparación inicial

Los fetch fallaron por permisos de `~/.ssh/config`; Coolify exigió una aprobación
que la política de esta sesión no permite. La firma GPG falló porque
`~/.gnupg` está en solo lectura. Las comprobaciones de sockets y el build Next
recibieron `EPERM`. El build de Portable también quedó bloqueado en la ejecución
del generador de atribuciones; no se sustituyó su inventario ni se desactivó la
verificación. Los builds incompletos no son candidatas de despliegue.

El estado de los commits, la firma y los artefactos debe comprobarse en el recibo
de preparación de esta tanda. Ese recibo registra la fase inicial restringida;
no sustituye la evidencia de construcción e integración posterior. Los
resultados finales se guardan fuera de los inputs del artefacto para evitar
que registrar la prueba cambie los commits que esa prueba identifica.
