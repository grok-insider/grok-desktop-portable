# Actualización y restauración de la PWA desplegada

`scripts/qa/qualify-deployed-update.mjs` comprueba el cambio de shell en
`https://grok.fabrials.com` dentro de Syl hidden Sway. Usa un perfil temporal,
sin conversaciones ni vinculaciones, y no toca el navegador habitual.

```sh
REMOTE_QA_PREVIOUS_SHELL_ID=<sha256-shell-anterior> \
REMOTE_QA_SHELL_ID=<sha256-shell-nuevo> \
REMOTE_QA_CHROME=<Chrome-Nix-sin-wrapper-de-perfil> \
REMOTE_QA_PLAYWRIGHT=<ruta-absoluta-a-playwright-core/index.mjs> \
node scripts/qa/qualify-deployed-update.mjs /tmp/<directorio-nuevo>
```

El servidor debe estar sirviendo el shell anterior al arrancar. El ejecutor
comprueba TLS real, su identidad y el control del service worker; después
escribe `baseline.ready`. El operador despliega la imagen nueva mediante
Coolify y verifica su identidad y salud antes de crear `deployment-ready`
en ese directorio. El ejecutor no despliega ni modifica el servidor.

La actualización debe ofrecerse y esperar una acción explícita. Tras aceptarla,
el shell debe coincidir con la identidad nueva esperada. Se descargan y
verifican mediante SHA-256 las fuentes, licencia y avisos de ambas versiones.
Después se corta la red del contexto, se recarga y se restaura explícitamente
la versión anterior sin conexión. Un plazo de dos horas limita la espera del
despliegue; las operaciones de navegador tienen sus propios plazos.

El informe conserva las identidades y cada comprobación. Al terminar se cierra
Chrome, se comprueba la salida de su grupo de procesos y se cierra Syl antes de
borrar el perfil propio. Un proceso superviviente sólo se termina si conserva
su PID e instante de arranque registrados. Un fallo de limpieza hace fallar el
resultado. El inventario no cubre descendientes que abandonen su grupo de procesos.

En la restauración del despliegue r3 del 14 de octubre pasaron 18 comprobaciones
con Chrome 155; el grupo Chrome quedó vacío y el perfil se eliminó. El ensayo
comprueba actualización estática y disponibilidad de fuentes: no contiene
turnos activos, borradores, inferencia, push ni interacción física con Android.
La prueba de cola y borradores durante N/N−1 y el acceso simultáneo a station
tienen sus propios ejecutores y recibos.
