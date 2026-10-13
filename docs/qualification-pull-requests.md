# PRs de integración

Seis PRs en borrador, sin auto-merge. Las fuentes y pruebas del despliegue QA
están en [el recibo del 2026-10-14](qualification-evidence-2026-10-14.md).
Los commits posteriores de documentación no cambian ese artefacto.

| PR | Destino | Alcance |
| --- | --- | --- |
| [fabrials-libs #1](https://github.com/grok-insider/fabrials-libs/pull/1) | master | Host ACP, transporte Noise, cola compartida y seguridad nativa |
| [Portable #7](https://github.com/grok-insider/grok-desktop-portable/pull/7) | dev | PWA directa, múltiples dispositivos, distribución y hosting QA |
| [Spanreed #56](https://github.com/grok-insider/spanreed/pull/56) | dev | Host privado, subtree canónico, actualización y distribución nativa |
| [Web #7](https://github.com/grok-insider/fabrials-web/pull/7) | master | Familias de autenticación y publicaciones con apertura bloqueada |
| [Admin #1](https://github.com/grok-insider/fabrials-admin/pull/1) | master | Introspección de familias de navegador y cierre seguro |
| [ai-relay #29](https://github.com/grok-insider/ai-relay/pull/29) | master | Introspección del panel separada de clientes nativos |

## Integración privada

Librerías primero; después Portable y el sync oficial de Spanreed, con el mismo
SHA canónico. Cada cambio de fuentes distribuibles exige reconstruir y verificar
el manifiesto, embed y archivo de fuentes correspondientes. Spanreed y Portable
se integran en `dev`; una release posterior lleva su proceso propio.

La PWA admite varios dispositivos emparejados del mismo dueño. La cola del host
es duradera, FIFO y con un turno activo por conversación. Enviar no exige CAS;
configurar, interrumpir y vaciar sí usan las revisiones pertinentes. Un resultado
ambiguo necesita revisión y nunca se reenvía automáticamente. Los modelos y
esfuerzos vienen de confirmaciones ACP actuales. No describir el producto como
control exclusivo entre pestañas: esa limitación ha sido sustituida.

La candidata QA ya está desplegada en Coolify y station está actualizado con su
instalación independiente. El recibo separa las pruebas reales de TLS, Tailscale,
dos navegadores y actualización N/N−1 de la ejecución con ACP determinista y de
las comprobaciones físicas todavía pendientes. Los PRs deben conservar esa
separación; ni un CI verde ni una build Linux acreditan los instaladores Windows
ni la suspensión y push del S24.

## Autenticación y publicaciones

Desplegar el endpoint compatible de introspección de Web antes que sus
consumidores, en todas las réplicas. Admin y ai-relay verifican primero firma y
claims y después la familia viva; un fallo de introspección deniega el acceso.
El modo privado directo no depende de este rollout. La recuperación de SSO no
puede volver a un backend que ignore revocaciones de familias.

Las publicaciones conservan la retirada y caducidad terminales, siete días
sin contenido realmente nuevo y límites duraderos. Su implementación y pruebas
no abren el acceso público. Borrado de claves, eliminación de metadatos,
purga del contenido cifrado, procesos con texto en claro, copias y restauraciones
son garantías diferentes que deben estar verificadas antes de habilitarlo.

## Antes de fusionar

Actualizar remotos y comparar los destinos con las bases revisadas; resolver
conflictos sin sobrescribir trabajo ajeno. Verificar el CI del HEAD final y
repetir los checks afectados tras cambios. Actualizar cada descripción con sus
resultados finales y bloqueos concretos. No activar auto-merge ni publicar una
release estable para obtener artefactos de QA. El orden y las recetas están en
[qualification-merge-deploy.md](qualification-merge-deploy.md).
