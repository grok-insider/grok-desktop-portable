# Suplemento móvil — 13 de octubre de 2026

La sesión del S24 aporta pruebas físicas parciales. **El usuario acepta la
legibilidad y el manejo de UI04**, después de rechazar la interfaz anterior.
Esto no demuestra todavía el beneficio de las funciones experimentales ni
cierra el QA móvil. Las decisiones siguen en **5 `keep` y 15 `inconclusive`**;
no se promueve ninguna opción a las compilaciones ordinarias.

El [recibo saneado](mobile-01.json) contiene las identidades, hashes, límites y
pendientes. Este suplemento no reescribe los resultados anteriores. Combina la
revisión independiente de recibos con las comprobaciones y el cierre realizados
por el proceso principal.

## Atribución de las observaciones

El dispositivo es un Samsung Galaxy S24 Ultra con Android 16, API 36. La PWA
instalada se observó a 384 × 750 píxeles CSS. Se utilizó HTTP localhost mediante
ADB reverse, con contexto seguro; esto no acredita Tailscale, el ingreso HTTPS
de producción ni un cambio entre Wi-Fi y datos móviles. La cuenta y la sesión
del laboratorio son sintéticas.

| Candidato | Evidencia que le corresponde |
|---|---|
| Inicial, manifiesto `4fee7fa155f0381ab63ea9ef8ede29607d194b182cc560a7387ecfbecbca5d0c` | Instalación Android y recepción/descarte desde la hoja de compartir |
| UI04, manifiesto `fc444d833b4ae1945540d63d05290d22dd31d089c2fb9e421bf0e8180bd8e0f4` | Página actualizada en el teléfono, borrador conservado, aceptación de legibilidad y regresión responsive con límites explícitos |

La sustitución de archivos del servidor a las 01:30:34 UTC no recargó por sí
misma el teléfono. El recibo posterior, a las 01:31:03 UTC, identifica el script
`assets/index-SiypjReX.js`, cuyo nombre coincide con el manifiesto congelado de
UI04. No se recalculó el hash de los bytes descargados por el teléfono. La
instalación y la hoja de compartir anteriores conservan su candidato original;
no pasan a ser pruebas nuevas de UI04.

## Qué se observó

- **Instalación inicial:** apareció un WebAPK nuevo, con modo `standalone` y
  contexto seguro. No se repitió la instalación desde cero con UI04.
- **Compartir texto y cancelar:** se utilizó el selector real de Android y la
  PWA instalada. Hubo revisión editable; añadir permaneció desactivado sin un
  destino. Se descartó el contenido y no se envió un prompt. No quedaron
  acreditados la inserción en una conversación, URL, archivos, duplicados ni
  la reapertura desde un proceso cerrado.
- **Actualización de la interfaz:** el recibo del teléfono declara el borrador
  intacto, muestra `Saved draft` y mantiene `standalone`. Esta observación no
  acredita recuperación tras matar el proceso de Android o reiniciar el móvil.
- **Participación humana:** el rechazo inicial impidió continuar las tareas y
  motivó reorganizar la composición móvil. A las 01:36:23 UTC, ante la pregunta
  sobre legibilidad y manejo de UI04, el usuario respondió «Sí, ahora se puede
  usar». Es una aceptación de la interfaz; no sustituye las tareas de utilidad
  de dictado, notificaciones u otras funciones.
- **Comprobaciones locales:** 676 pruebas en 63 archivos correctas. El operador
  confirmó TypeScript y su log no contiene diagnósticos. Son comprobaciones de
  código, distintas de las pruebas físicas y del navegador.
- **Teclado físico del S24:** al abrir el teclado Android, el viewport pasó de
  unos 750 a 491 píxeles CSS. El editor quedó entre 350 y 434 y el envío terminó
  en 478: ambos visibles, sin desbordamiento horizontal y con el borrador intacto.
  Se comprobó apertura y geometría, no una tarea humana de escritura.
- **Permiso prioritario:** un evento nativo sintético cerró los ajustes, recibió
  foco y quedó visible a 384 × 750, conservando el nodo y el contenido del editor.
  El fixture sólo ofrecía `allow-once`: la interfaz lo rechazó como oferta
  incompleta, sin botones de aprobación. No se ejecutó ni aprobó una operación.
  La limpieza mediante recarga y revocación del emparejamiento quedó comprobada.

## Regresión de UI04: fallo conservado y reensayo

`compact-regression07` terminó con **`failed`**: «the resting composer is visible
without scrolling». Sus diagnósticos corresponden a 384 × 750 tras un cambio de
tamaño. El diagnóstico posterior reproduce la causa en cinco de cinco
transiciones de 844 a 750 píxeles de alto: el viewport ya había cambiado, pero
la variable CSS aún valía `844px`. Tras esperar su actualización a `750px`, el
compositor volvió a quedar visible. La medición del arnés se había adelantado
a esa actualización.

Antes del fallo completó 2560 × 1440 y 390 × 844 sin desbordamiento horizontal,
con compositor visible y borrador intacto. En cada tamaño registró quince
comprobaciones de puntero, apertura/cierre de ajustes y dictado sin activar el
micrófono, y activar/desactivar borradores. El worker estaba activo y controlaba
la página; el informe no contiene errores de página. Esos resultados parciales
no convierten la ejecución fallida en QA final aprobado.

El reensayo `compact-regression08`, con el mismo manifiesto de UI04 y la espera
corregida, termina en `passed`: seis tamaños, noventa comprobaciones de puntero,
dieciocho secuencias de teclado y cero errores de página. Los tamaños son
2560 × 1440, 390 × 844, 384 × 750, 384 × 694, 844 × 390 y 384 × 430; todos
conservan el borrador y no desbordan horizontalmente. Hay un límite que el
resultado global no debe ocultar: en horizontal a 844 × 390, el borde inferior
del compositor queda a 398 píxeles y `resting.visible` es falso. Los controles
superan las comprobaciones de puntero, pero no queda acreditado que todo el
compositor sea visible sin desplazarse en ese tamaño.

Los registros de teclado muestran foco inicial dentro de los diálogos. Al hacer
Shift+Tab desde el título, el documento pierde foco; el siguiente Tab vuelve a
un botón del diálogo. No se documenta foco en un control del fondo. Este detalle
no se interpreta como una comprobación completa del ciclo de foco, lector de
pantalla o teclado Android. El ensayo responsive excluye expresamente teclado
Android físico, lector de pantalla real, composición NVIDIA, Safari e iOS.
La comprobación física posterior del teclado descrita arriba es independiente
de ese arnés. Interacciones obligatorias distintas de permisos y la combinación
de publicación activa con desconexión no se probaron en ese fixture.

## Voz, notificaciones y ciclo de vida

La respuesta de voz preparada contiene dos mensajes y una última respuesta de
1209 unidades UTF-16, con tres fragmentos esperados. Es preparación de datos
sintéticos: todavía no acredita reconocimiento real, reproducción audible,
pausa/reanudación ni comprensión. No hay tareas humanas de voz completadas en
los recibos incluidos.

A las 01:38:22 UTC, el usuario informa «Aparece Configured» y el recibo del S24
confirma permiso `granted`, suscripción presente y estado configurado. A
continuación, un evento nativo de fin de turno produce una notificación
consultable desde el navegador Android, con la PWA visible: la primera consulta
con resultado positivo llega a los 1044 ms; antes no había ninguna. Es una
observación de la cadena evento → servicio Web Push real → worker de Chrome
Android, no un percentil de latencia ni confirmación de que el usuario haya
visto u oído el aviso del sistema. El recibo exige esa confirmación humana,
todavía pendiente aquí. Tampoco hay resultados de suspensión o aplicación
cerrada. Detectar las APIs, configurar la suscripción y observar la entrega son
hechos distintos.

Una tentativa en segundo plano envió Android al inicio, pero la espera de
visibilidad del documento dejó de responder y una conexión CDP nueva agotó
30 segundos. El segundo evento nativo aún no se había emitido. Se terminó el
sondeo propio y se reabrió la WebAPK: CDP respondió y el borrador seguía intacto.
La causa del bloqueo no quedó establecida y no se atribuye a la entrega Push.
No se infiere de esto entrega en segundo plano, Doze o muerte de proceso.

Siguen pendientes los ciclos de borradores tras muerte de proceso y suspensión,
las variantes restantes de compartir y la comparación de utilidad con tareas
humanas. El resultado de conservar un borrador durante esta actualización no
se extiende a esos casos.

## Primer arranque del laboratorio: límite del socket Unix

El primer managed falló en `native-additional`: su ruta a `control.sock` medía
108 bytes, mientras Linux requiere menos de 108. El fixture terminó con código
101 y `path must be shorter than SUN_LEN`. El reintento emplea una raíz corta,
con 49 bytes para ese socket.

El panic procede del `unwrap` del fixture, pero el enlace de control es el mismo
que usa el producto. Un directorio de estado personalizado o XDG demasiado largo
también puede impedir arrancarlo. No es un límite del teléfono, de Noise ni del
relay. Conviene validar las tres rutas antes de registrar hosts y, en el código
Unix, validar con `SocketAddr::from_pathname` antes de modificar el estado. Este
suplemento documenta el hallazgo; no implementa esa corrección.

## Cierre y límites restantes

La compilación ordinaria de UI04 pasa el gate de 45 archivos con el paquete
Noise compilado. No registra share target ni manejadores Push. Las 162 entradas
de fuentes coinciden con el manifiesto ensayado. El empaquetador avisa de un
chunk JavaScript de unos 641 kB minificados; no se midió carga fría ni se afirma
una mejora de rendimiento de descarga.

El cierre está ejecutado y comprobado. Se retiraron binding y registro de
notificaciones, se cerró el aviso y se canceló la suscripción. Se limpiaron sólo
el almacenamiento del origen y las cookies sintéticas propias, conservando las
demás. Se cerraron las pestañas propias y se desinstaló únicamente la WebAPK de
esta prueba. Una pestaña temporal con una imagen del mismo origen confirmó
`Notification.permission=default`, notificaciones y micrófono en `prompt` y
cero workers; también se cerró. Se quitaron únicamente los enlaces ADB propios.

Después se revocaron los tres hosts, se cerraron relay, hosts y backend, se
eliminaron el esquema y los dos contenedores y se cerró Sway oculto. Los puertos
propios están cerrados. El runtime quedó archivado, con sus 236 archivos
verificados sin alterar recibos, y los cuatro índices Git permanecen iguales.
No hubo commits, publicaciones, despliegues ni cambio de la instalación diaria.

Quedan pendientes la confirmación humana de visibilidad del aviso, los demás
estados de notificaciones, voz, muerte de proceso y las variantes físicas de
compartir y cambio de red. El límite horizontal de ocho píxeles queda registrado;
los controles son accesibles mediante desplazamiento. Estos límites impiden
presentar la sesión como aceptación móvil completa.
