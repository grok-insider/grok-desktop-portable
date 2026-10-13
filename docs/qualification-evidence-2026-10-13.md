# Evidencia de la candidata de pruebas del 2026-10-13

Este registro identifica una candidata concreta: Portable `b738e4a`, librerías
`e287729` y Spanreed `c0094c7`. Las correcciones y reconstrucciones posteriores
necesitan recibos propios; no heredan automáticamente la cualificación de esta
candidata. Los fallos iniciales de permisos, firma, sockets y subprocesses se
superaron en esta ejecución sin desactivar verificadores.

## Identidades verificadas

| Elemento | Identidad |
| --- | --- |
| Portable | `b738e4a091d2e49355b7a2213d24a0ae2a40d1eb` |
| Librerías | `e287729b121dd8ec82a91d6031ba835f6082dfbd` |
| Spanreed | `c0094c710d43bd40906f608e6925c6162fa6e4de` |
| Web, cualificación independiente | `46bf727dfe542acd1934fa59439d1743506a8cf7` |
| SHA256 de deployment.json | `27f9b2b7f5c653ae4ed293c34c026c8272298433b2458a66608788aa0811d1d4` |
| SHA256 del archivo de fuentes | `a2117367e802639b18ed6213f1b293beecff40e12e3957573ce702f5c04ad388` |
| SHA256 del recibo de navegador | `cd3a1a0c2e0f996fce7897b8b09f25b3a505df7314491316dd9013d03e22b914` |
| SHA256 del bundle de 47 archivos embebidos | `7a107d0b30cb071afb308467bd74aef73b879a911e46a91112a5965e21b744c3` |

El artefacto tiene 54 archivos de payload y `deployCandidate=true`: pasó la
verificación de estructura y correspondencia completa de fuentes, incluida la
igualdad de PWA embebida, WASM, instaladores y configuración de hosting. Esa
bandera no certifica despliegue, licencias completas ni aceptación de producto.
El archivo de fuentes pesa 4.256.095 bytes. Los artefactos y recibos originales
se conservaron fuera de los repositorios para no cambiar sus identidades.

## Resultados y alcance

- 564 pruebas del host/crypto correctas, con tres experimentos ignorados;
  formato y Clippy correctos. Incluye sockets reales para el origen de pruebas.
- Spanreed: 2.246 pruebas principales y un fixture adicional correctos, once
  casos ignorados; build Linux optimizada y 18 comprobaciones del ciclo de vida
  con el origen QA. La suite precede el último commit exclusivo de su manifiesto;
  el código y los bytes del embed son idénticos y la build/ciclo usan el commit
  indicado en la tabla.
- Frontend: 799 pruebas, tipos, 18 pruebas de artefactos, 12 de fuentes y 14
  dirigidas a origen/fuentes/interfaz. Construcción real de WASM e interoperabilidad.
- Navegador: 37 comprobaciones en Chrome 155, dentro de Syl Sway oculto, a
  2560×1440, 390×844, 844×390 y 390×430. Emparejamiento Noise con Origin real
  `https://grok.fabrials.com`, reconexión, borradores e historial consentidos,
  apertura offline, revocación y borrado local correctos. Descarga real desde
  el navegador del archivo de fuentes, licencia y atribuciones, con hashes
  coincidentes. Sin errores inesperados ni peticiones externas. La apertura
  offline tardó 118 ms en este laboratorio; no es un objetivo de rendimiento
  acreditado en dispositivos de usuario.
- Web, por separado: build Node 22 de 65 páginas; 28 pruebas y 243 aserciones;
  92 comprobaciones HTTP en cuatro combinaciones de flags; tipos y lint
  correctos con dos avisos de imágenes blob verificadas. Publicaciones: 503 y
  doce gates cerrados.

## Integración e infraestructura pendientes

Se crearon commits firmados y cuatro PRs en borrador:
[librerías #1](https://github.com/grok-insider/fabrials-libs/pull/1),
[Portable #7](https://github.com/grok-insider/grok-desktop-portable/pull/7),
[Spanreed #56](https://github.com/grok-insider/spanreed/pull/56) y
[Web #7](https://github.com/grok-insider/fabrials-web/pull/7).
No hubo merge ni despliegue. La consulta de CI a las 12:42 UTC identificó un
[fallo de Windows en Spanreed](https://github.com/grok-insider/spanreed/actions/runs/38398281143/job/115298989844);
los checks remotos pendientes y sus correcciones impiden declarar los PRs
listos para fusionar. Consultar sus ejecuciones actuales antes de integrar.

La prueba de navegador resolvía el nombre QA localmente y usaba certificado
autofirmado, historial sintético y compositor por software. No acredita DNS,
TLS ni CDN públicos, Tailscale, S24/Apple, inferencia, entrega push ni GPU real.
`grok.fabrials.com` aún no resolvía desde station y no se encontró una sesión
Vercel autenticada; no se modificaron DNS, hosting ni el servicio habitual.
Siguen pendientes las atribuciones nativas/Rust/WASM completas, las pruebas de
retención de fuentes N/N−1, rollback, dispositivos y aceptación prolongada.
Las publicaciones conservan sus doce requisitos de apertura.
