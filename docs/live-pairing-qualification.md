# Vinculación simultánea contra station

`scripts/qa/qualify-live-pairing.mjs` comprueba el shell servido por
`https://grok.fabrials.com` contra la unidad QA de station. Usa dos almacenes de
navegador independientes en Chrome dentro de Syl hidden Sway a 2560 × 1440.
No abre una ventana en el escritorio habitual.

El ejecutor exige el SHA-256 esperado del binario y el identificador esperado
del shell. Comprueba los bytes del ejecutable del proceso activo mediante
`/proc/<pid>/exe`, además del paquete seleccionado, y verifica que el PID y su
instante de arranque se conservan durante la prueba. Una coincidencia de texto
de versión no sustituye esta comprobación.

```sh
REMOTE_QA_NATIVE_SHA256=<sha256-del-binario-calificado> \
REMOTE_QA_SHELL_ID=<identificador-del-shell-desplegado> \
REMOTE_QA_CHROME=<ruta-Nix-del-Chrome-sin-wrapper-de-perfil> \
REMOTE_QA_PLAYWRIGHT=<ruta-absoluta-a-playwright-core/index.mjs> \
node scripts/qa/qualify-live-pairing.mjs /tmp/<directorio-nuevo>
```

El directorio debe ser nuevo y se crea con permisos 0700. La unidad QA debe
estar activa y Tailscale debe servir su origen HTTPS privado habitual. El
ejecutor crea dos vinculaciones de prueba, comprueba que ambas conservan sus
controles, recarga una sin volver a vincularla y revoca cada una desde la
interfaz. La otra debe seguir siendo operativa tras la primera revocación.
Las vinculaciones anteriores se preservan.

La propiedad de una vinculación se determina leyendo exclusivamente su
`sessionId` del IndexedDB del contexto temporal, antes de esperar a que aparezcan
los controles. La limpieza vuelve a consultar ese contexto si falló la prueba.
Nunca se deduce qué acceso revocar de la diferencia global de dispositivos.
Un acceso nuevo sin atribución hace fallar el informe y queda para conciliación.

`report.json` incluye hashes, identidades del proceso, cada comprobación y la
confirmación de limpieza. Al terminar se revocan las vinculaciones propias que
queden, se espera la salida de Chrome y Syl y se elimina el perfil temporal. No
se imprime ni se conserva en el informe el enlace de vinculación. Un fallo de
limpieza hace fallar la ejecución. El grupo de procesos propio de Chrome debe
quedar vacío; antes de terminar un miembro que sobreviva se verifica también
su instante de arranque. El perfil se conserva si no pudo confirmarse esa salida.

Esta prueba no envía mensajes, genera inferencia, cambia proyectos ni toca
conversaciones existentes. Que los controles estén disponibles no acredita
por sí solo la ejecución de dos turnos simultáneos: esa garantía corresponde
a las pruebas de cola y al laboratorio ACP. Tampoco cualifica Android, push,
suspensión, rendimiento de GPU ni un inventario completo de descendientes
tras la limpieza. No sustituye las pruebas prolongadas.

## Evidencia inicial, 2026-10-14

La primera ejecución pasó 24 comprobaciones con station aún en `7e2a7816` y el
shell `ff22898f…`. Se inyectó además un fallo después de guardar el acceso en
el navegador y antes de comprobar los controles, vaciando deliberadamente la
lista en memoria del arnés. La limpieza recuperó el identificador desde su
contexto, lo revocó, conservó los anteriores y dejó el grupo Chrome vacío.
Esa ejecución terminó con el error inyectado, como debía.

El [recibo](evaluation/live-pairing-cleanup-2026-10-14.json) conserva los hashes
de ambos ejecutores y resultados. No valida el paquete posterior `f3ebb334` ni
supone que se haya actualizado station.
