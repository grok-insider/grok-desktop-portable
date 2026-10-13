# Evaluación de Grok Remote — 13 de octubre de 2026

Los veinte experimentos tienen un recibo verificable: **cinco `keep` y quince
`inconclusive`**. Esto cierra la recopilación automática actual, no acredita una
release ni sustituye las comprobaciones físicas pendientes. Las funciones
opcionales siguen desactivadas en las compilaciones ordinarias.

El [índice](index.json) vincula cada decisión con sus fuentes, artefactos,
comprobaciones y límites. El [catálogo](catalog.json) conserva los criterios
previos; no se rebajaron para convertir resultados pendientes en aprobaciones.

La [sesión física posterior del S24](mobile-01.md) añade instalación real,
recepción y descarte de texto compartido, una interfaz móvil reorganizada y
aceptada por el usuario, borrador conservado y una notificación Web Push real
consultable en Android. No cambia las decisiones de los veinte experimentos.

## Qué se ha implementado y comprobado

La base incluye familias revocables de sesiones de navegador, rotación atómica,
límites de comandos y adjuntos, continuidad mediante el líder ACP compartido,
operación del relay y publicación con consentimiento. Los candidatos opcionales
añaden borradores durables, carpetas autorizadas, transferencia de control,
gestión de navegadores, notificaciones, recepción de contenido compartido,
dictado, lectura en voz alta y optimizaciones de eventos, conversaciones y
publicación. El diagnóstico de instalación es de solo lectura y declara las
comprobaciones que todavía no puede realizar.

| Experimento | Decisión actual | Alcance o motivo pendiente |
|---|---|---|
| Autenticación | Conservar | Familias, rotación, respuesta perdida, cierre, revocación y compatibilidad nativa; cuentas sintéticas |
| Límites de adjuntos | Conservar | Fronteras exactas, Unicode, varios archivos y borrador previo; rechazo sin envío |
| Continuidad del terminal | Conservar | ACP compartido con Grok oficial 1.0.50 y 1.0.52; sin TUI interactiva ni cadena móvil en este recibo |
| Operación del relay | Conservar | Aislamiento, carga, consumidores lentos, reconexión, disponibilidad, cierre y rollback local |
| Publicación | Conservar | Publicador real con PostgreSQL y S3 de laboratorio; consentimiento y revocación |
| Distribución | Pendiente | Compilación ensamblada correcta; faltan release limpia, integración de vendor e instalación/actualización/rollback distribuidos |
| Borradores | Pendiente | Pruebas técnicas completas, incluido SIGKILL; faltan ciclo de vida Android y beneficio humano |
| Carpetas remotas | Pendiente | Confinamiento Unix y navegación comprobados; falta utilidad en tareas reales; no soportado en Windows |
| Notificaciones | Pendiente | API, cifrado, caducidad y revocación comprobados; falta entrega física en primer plano, suspensión y cierre |
| Transferencia de control | Pendiente | Cincuenta transferencias nativas y relevo en PWA; falta utilidad humana |
| Panel de navegadores | Pendiente | Seis controles técnicos, incluidos aislamiento, revocación y reconexión; falta utilidad humana |
| Diagnóstico inicial | Pendiente | Detecta ejecutable, directorio y origen incorrectos; servicio, líder activo, terminal, ruta y configuración completa sin acreditar |
| Multimodal | No habilitar | Ambas versiones oficiales anuncian imagen y audio no soportados por ACP; no se probó comprensión visual |
| Recibir contenido compartido | Pendiente | Ocho controles técnicos; recepción/descarte en WebAPK desde selector Android observados; faltan proceso cerrado, variantes físicas y beneficio |
| Dictado | Pendiente | Estado, cancelación y revisión comprobados; falta reconocimiento real y comparación con escritura, incluidas correcciones |
| Lectura en voz alta | Pendiente | Estado y cancelación comprobados; faltan audio, pausa, respuesta larga y comprensión reales |
| Integración con Syl | Pendiente | Grok oficial → ACP → Syl reales sobre objetivo sintético; permisos, frescura, revocación y no repetición de efectos ambiguos; falta utilidad humana |
| Entrega de eventos | Pendiente | Mejora en medición nativa; faltan cadena completa y guardas de recursos |
| Conversaciones largas | Pendiente | Mejora de interacción y comprobaciones funcionales; faltan guardas de recursos y validación física |
| Coste de publicación | Pendiente | Menor CPU en medición nativa; faltan subida interrumpida, revocación remota durante la subida y guardas de recursos |

`Multimodal` conserva `inconclusive` en el recibo: la decisión operativa es no
presentarlo como una capacidad soportada. Ninguna fila pendiente se descarta
solo por carecer de hardware o participación.

## Evidencia principal

- Frontend de la evaluación inicial: 652 pruebas en 59 archivos y TypeScript correctos. La cadena
  PWA real pasa 19 comprobaciones en Chromium y otras 19 en Firefox, con cuentas,
  WASM, Noise, relay y host nativo. Los mensajes de esa fixture son sintéticos:
  la inferencia y la continuidad ACP tienen pruebas independientes.
- Borradores: una muerte abrupta de Chrome descubrió pérdida de datos en
  localStorage. Ahora `Saved` espera la transacción estricta de IndexedDB. El
  último ensayo mata Chrome 3 ms después de observar esa confirmación y recupera
  el texto; también cubre actualización del worker, falta de red, cuota y TTL.
- Recuperación: ocho controles correctos tras cerrar el socket; una sola
  conexión, autoridad recuperada y borrador intacto sin navegar. Dos defectos del
  arnés anterior —código de cierre reservado y selector incorrecto— están
  documentados y sus resultados fallidos se conservan.
- Contenido compartido y publicación desde la interfaz: quince controles sobre
  POST/303 del worker, revisión, destino, duplicados, cierre/reapertura,
  descarte, vista previa nativa y cancelación del consentimiento.
- Relay: 3.600,651 segundos medidos, diez hosts y cien navegadores; 364.150 ecos
  acumulados en el arnés, sin errores, 600 muestras de memoria en cada ventana
  de diez minutos comparada y cierre en
  110,6 ms. Hubo compilaciones concurrentes: esta carga no mide CPU en reposo ni
  latencia en una máquina desocupada.
- Integración ordinaria `integration07`: compilación, formato, 41 pruebas,
  clippy, assets incrustados y CLI correctos. Usa copias congeladas de las
  bibliotecas canónicas y de la PWA con los experimentos desactivados. El rechazo
  del gate de release por fuentes sin commit se mantiene.
- Escritorio aislado: Chrome en Sway oculto a 2560 × 1440, DPR 1, sin cambiar el
  foco del escritorio. El diseño también se comprobó a 390 × 844, 844 × 390 y
  390 × 430: sin desbordamiento horizontal y con el editor accesible. El
  compositor usa software; no acredita el rendimiento de la GPU principal.
- Interfaz móvil UI04: 676 pruebas en 63 archivos y TypeScript correctos;
  seis tamaños, 90 comprobaciones de puntero y 18 secuencias de teclado.
  En el S24, el editor y el envío caben con el teclado real abierto y el
  borrador se conserva. En horizontal a 844 × 390 el conjunto del editor
  requiere un pequeño desplazamiento; el suplemento conserva esa limitación.
  La compilación ordinaria pasa el gate de 45 archivos con Noise y mantiene
  desactivadas las opciones experimentales.

## Incidencias y límites abiertos

WebKit supera las dieciocho comprobaciones funcionales, pero falla el control
estricto de diagnósticos durante navegación. La revisión del protocolo y del
código del motor confirma un mensaje nativo de acceso que Playwright convierte
en `pageerror`; no hubo `window.error` ni `unhandledrejection`. Existe una ruta
del motor compatible con la cancelación de una petición, pero su causa concreta
no está demostrada. No se filtró el mensaje ni se declaró compatible Safari.
El bloqueo anterior de suscripciones sin permiso sí está corregido y tiene dos
pruebas de regresión.

La sesión física del S24 se realizó parcialmente, con aceptación humana de la
interfaz y del alta de notificaciones. La primera consulta positiva de una
notificación llegó a los 1044 ms del evento; no es un percentil ni confirma que
el usuario viera el aviso. Una tentativa posterior en segundo plano perdió
el canal CDP antes de emitir el evento: queda inconclusa. El
[guion](../../remote-mobile-evaluation.md) sigue separando voz, proceso
eliminado, suspensión y cambio de red. ADB reverse no acredita Tailscale.
Las observaciones de instalación y compartir conservan su versión anterior
a UI04 y no se reasignan a la nueva interfaz.

Faltan mediciones reales de despertares, CPU en reposo y memoria comparada para
aceptar las optimizaciones de rendimiento. Los resultados de microbenchmarks no
sustituyen esas guardas. iPhone, macOS, DeX físico y el runtime Windows del nuevo
candidato no están acreditados por las pruebas Linux de esta entrega.
En Windows faltan instalación y actualización, tarea programada por usuario,
ACL y credenciales, IPC con named pipes, Job Objects y persistencia NTFS. Las
pruebas que inspeccionan el texto de PowerShell no lo ejecutan. La exploración
experimental de carpetas devuelve `remote_projects_unsupported` fuera de Unix.

No se hicieron commits, staging, publicaciones, despliegues ni cambios de la
instalación diaria o de NixOS. Se conservaron los cuatro índices Git, incluido
el trabajo previamente preparado en las bibliotecas, y los vendor reales.

Las evidencias privadas se trasladaron a
`~/.local/share/grok-remote-evaluation/2026-10-13/`, con permisos 0700. El índice
registra el traslado sin reescribir los recibos con hash. El navegador oculto,
los contenedores y los procesos propios están cerrados; también se localizaron
y pararon tres líderes Grok que habían quedado residentes en directorios de
prueba aislados.

El laboratorio de la sesión móvil también está cerrado: tres hosts revocados,
dos contenedores eliminados, puertos propios cerrados y Sway oculto terminado.
Se retiraron sólo la WebAPK, las pestañas, los datos de origen y los enlaces ADB
de la prueba. La suscripción y el aviso se retiraron; el permiso de notificación
volvió a `default` y el micrófono siguió en `prompt`. Los cuatro índices Git
siguen intactos. El runtime móvil quedó archivado con verificación de sus 236
archivos y sin reescribir los recibos históricos.

Se conserva una incidencia de cierre del laboratorio: el backend de cuentas
terminó antes de su TTL y eliminó su esquema; después los fixtures de conexión
única fallaron con `relay_closed`. El emisor de la señal no quedó registrado.
El ciclo de vida fallido y los intentos de revocación posteriores se conservan;
no se convirtieron en una aprobación ni se atribuyeron a una caducidad del
producto a los veinte minutos. Las comprobaciones de navegador citadas arriba
habían terminado antes. La siguiente sesión física deberá iniciar un nuevo
laboratorio desde el proceso principal.

Durante una inspección previa del wrapper de Grok se expusieron en la salida de
una herramienta valores de `FIRECRAWL_API_KEY` y `EXA_API_KEY`. No se incluyen en
estos informes. Su rotación queda pendiente; los ensayos finales usan los
binarios oficiales directamente y entornos sin esas credenciales.
