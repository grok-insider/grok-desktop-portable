# Plan: Grok Light (`apps/light`) - WebUI local Work-only para Grok Build CLI

**Status:** plan approved; **implementation gated on explicit user permission**
**Saved as:** `docs/light/light-website-plan.md`
**Scope:** producto final Work-only, servido enteramente desde la maquina del usuario
**Nombre de producto/codigo:** **Grok Light** / package `@grok-desktop/light` / path `apps/light`
**Primer gate de cualificacion:** Linux
**Runtime de ejecucion:** Grok Build CLI oficial instalado y configurado por el usuario
**Transporte de produccion:** ACP v1 por `grok agent --no-leader stdio`
**Permisos v1:** matching nativo de las opciones ACP: `allow-once`, `reject-once` y `allow-edits-session` cuando Grok lo ofrezca
**Browsers soportados:** Chromium y Firefox 84+. WebKit, incluido Safari, no soportado
**Fuera de producto:** Chat general, Research, Isolated Guest/VM, Host Tools del daemon Desktop, vault daemon, automations, voice, computer-use de escritorio y Electron

> **Do not start implementation (Fase 0+) until the team explicitly grants permission to continue.**

---

## 1. Decisiones normativas

Estas decisiones sustituyen cualquier borrador o revision anterior del plan:

1. La aplicacion real no se aloja en un CDN. `grok-light-host` sirve la SPA y la API desde loopback.
2. El browser solo se conecta al origen local de Light. No existe backend, telemetria, sync ni servicio remoto de Light. La unica salvedad conocida es la resolucion del nombre del origen en browsers no conformes, documentada en 2.2 y 4.6.
3. El host local arranca con la sesion del sistema operativo; el proceso Grok Build arranca solo bajo demanda.
4. Produccion usa ACP por stdio. `grok agent serve` queda limitado a fixtures o pruebas de compatibilidad y nunca se expone al browser.
5. Light usa el `GROK_HOME`, autenticacion y configuracion efectiva del usuario sin ofrecer configuracion de Grok desde la web.
6. La configuracion completa del usuario esta en scope: modelos, endpoints, MCP, plugins, hooks, memoria y reglas de permisos pueden cambiar el comportamiento del CLI.
7. Light integra exclusivamente con el ejecutable y contrato ACP de Grok Build, pero no afirma que la configuracion efectiva del usuario sea Grok-only ni que toda accion genere un prompt.
8. Solo existe una pestana controladora y una sesion agent activa. La concurrencia multi-agent requiere un ADR posterior.
9. La web nunca introduce una ruta de filesystem. El host matricula workspaces mediante un selector local y entrega IDs opacos.
10. V1 no inventa un `Always for this session` general. Solo refleja las opciones ACP nativas aprobadas en este documento.
11. No existen grants `Always cwd` ni politicas persistentes propias de Light en v1.
12. Intencion, idempotencia, eventos y recovery se implementan antes que la UI final.
13. La extraccion de componentes visuales de Desktop ocurre despues de demostrar el host, ACP, permisos y recovery.
14. Linux es la primera plataforma de cualificacion. Windows y macOS se incorporan despues de superar el gate Linux.
15. Los motores de browser soportados son Chromium y Firefox 84+. WebKit, incluido Safari, no esta soportado y no se cualifica. Ver 4.6.
16. La cualificacion del ejecutable Grok es integridad de producto y soporte, no un control de seguridad. Ver 5.1.
17. El `clientIdentifier` de Light resuelve a `ClientType::Generic` en el CLI. Todo el contrato de permisos se deriva y se contract-testea contra esa semantica. Ver 8.1.
18. El programa tiene un hito de dogfood interno al cierre de Fase 5 cuya decision escrita condiciona la entrada en Fase 6.

---

## 2. Vision de producto

### 2.1 Promesa

Grok Light es una WebUI local para trabajar con el Grok Build CLI que el usuario ya tiene instalado y autenticado. Tras una instalacion inicial del host local, el usuario abre una URL estable en su browser y trabaja desde ella. Sin host o CLI disponible, la pagina local muestra setup y recovery, no una aplicacion parcialmente funcional.

### 2.2 Que significa "local"

- La SPA, fuentes, iconos, documentacion y API se sirven desde el binario instalado.
- El browser solo realiza requests HTTP y WebSocket al mismo origen loopback.
- `grok-light-host` no llama a APIs de Light, analytics, CDN, update service ni cloud storage.
- El estado propio de Light permanece en almacenamiento privado del usuario.
- El proceso `grok` conserva su comportamiento normal y puede comunicarse con xAI y con cualquier endpoint, MCP, hook o plugin habilitado por la configuracion del usuario.
- No es un producto offline: Grok Build necesita sus servicios configurados para autenticar y generar respuestas.

**Limite conocido: resolucion del nombre del origen.** "Sin red saliente" describe el trafico que
Light origina, no la resolucion del hostname del origen. Los browsers conformes de 4.6 cortocircuitan
`*.localhost` a loopback sin consultar DNS, asi que en la matriz soportada no sale nada. En un browser
o cliente que no implemente esa regla, `<install-id>.grok-light.localhost` se envia al resolver del
sistema y, por tanto, al proveedor DNS configurado. El resolver del sistema no mapea `*.localhost`
por defecto, de modo que esa consulta expondria un identificador de instalacion estable.

Consecuencias aceptadas:

- El `install-id` es un identificador estable por instalacion. Es aleatorio y no deriva de hardware,
  usuario ni red, pero es correlacionable entre consultas si llega a un resolver.
- Light no puede impedir esa consulta desde el host: ocurre en el browser antes de cualquier request.
- La mitigacion es la matriz de browsers conformes de 4.6 mas esta divulgacion, no un control tecnico.
- Si la consulta se resuelve fuera de loopback, el host nunca recibe la peticion y el usuario ve una
  pagina rota, no una sesion silenciosamente redirigida. La fuga es de privacidad, no de control.

### 2.3 Posicionamiento respecto a Grok Desktop

| Dimension | Grok Desktop | Grok Light |
|-----------|--------------|------------|
| Superficies | Chat, Research, Work, library, automations, integrations | Solo Work |
| Presentacion | Electron renderer | Browser del usuario contra origen local |
| Ejecutor | Daemon Rust + ACP gestionado + policy/guest/Host Tools | Grok Build CLI del usuario via host local |
| Configuracion Grok | Perfil privado y cerrado de Desktop | Configuracion completa del usuario |
| Deploy | Installer Electron + daemon | Host nativo con SPA embebida |
| Secretos | Vault y daemon Desktop | Auth y sesion propiedad del CLI |
| Threat model | Renderer no confiable y ejecucion gestionada | Browser no confiable; autoridad host del CLI del usuario |
| Persistencia | Daemon como system of record | Grok Build para sesiones; host Light para pairing, workspaces y journal |

Light no es un renderer del daemon Desktop y no usa Host Tools de Desktop. Es un cliente ACP con composition root, protocolo local y lifecycle propios.

### 2.4 Superficies de producto

1. **Setup local:** host, CLI, version, autenticacion, browser pairing y diagnostico.
2. **Workspaces:** workspaces matriculados localmente y recientes, representados por `WorkspaceRef`.
3. **Work sessions:** crear, cargar, cerrar y revisar sesiones soportadas por ACP.
4. **Session UI:** mensajes, thoughts cuando ACP los exponga, tool calls, diffs, planes y estados.
5. **Permission UX:** opciones exactas permitidas por el contrato v1.
6. **Run control:** prompt, cancel, reconnect, revision de `interrupted_needs_review` segun 7.5 y errores honestos.
7. **Settings Light:** tema, layout, pairing y datos locales de Light. Nunca configuracion del CLI, origen, puerto, ejecutable o policy.
8. **Docs locales:** install, auth, lifecycle, permisos, configuracion heredada y seguridad.
9. **Disconnected states:** host, CLI, auth, protocol mismatch, workspace y recovery.

### 2.5 Claims y non-claims

Light puede afirmar:

- La UI y el host de Light funcionan localmente.
- Light habla solamente con el contrato ACP del Grok Build CLI cualificado.
- El browser nunca recibe credenciales de autenticacion (tokens OAuth, refresh tokens, API keys, `auth.json`) ni el transporte ACP bruto.
- Light no modifica la configuracion de Grok desde la web.

Light no puede afirmar:

- Que la configuracion efectiva del CLI sea Grok-only.
- Que todos los tools, hooks, plugins o MCP pidan permiso a Light.
- Que el workspace sea una sandbox.
- Que Allow/Deny contenga codigo malicioso o prompt injection.
- Que el browser pueda iniciar un proceso nativo detenido visitando una URL HTTP ordinaria.
- Que exista sync, backup o ejecucion remota de Light.
- **Que el browser no vea ningun dato sensible.** El browser recibe tool output, diffs y contenido
  de archivos que el agente decidio leer, y ese material puede contener secretos del entorno del
  usuario. La garantia es sobre credenciales de autenticacion, no sobre el contenido que produce
  una sesion.
- **Que el nombre del origen local nunca se resuelva via DNS.** En browsers fuera de la matriz
  conforme de 4.6, el hostname del origen puede llegar al resolver del sistema. Ver 2.2.

---

## 3. Arquitectura de sistema

```text
 OS shortcut / bookmark
          |
          v
 http://<install-id>.grok-light.localhost:<stable-port>
          |
          | same-origin HTTP + WebSocket
          v
 +---------------------------------------------------+
 | grok-light-host (per-user, autostart)              |
 |                                                    |
 | embedded SPA | pairing | control lease            |
 | workspaces   | protocol | event journal | recovery |
 +-------------------------+-------------------------+
                           |
                           | supervised ACP JSON-RPC
                           | stdin/stdout
                           v
 +---------------------------------------------------+
 | official Grok Build CLI                            |
 | grok agent --no-leader stdio                       |
 | user GROK_HOME | user auth | user configuration    |
 +-------------------------+-------------------------+
                           |
                           v
              services configured by the user
```

### 3.1 Componentes

| Componente | Path propuesto | Rol |
|------------|----------------|-----|
| Light SPA | `apps/light` | Presentacion browser-only; assets embebidos por el host |
| Light host | `crates/grok-light-host` | Servidor local, lifecycle, pairing, workspaces, journal y ACP supervision |
| ACP adapter | Modulo de `grok-light-host` inicialmente | Cliente ACP stdio de Grok Build; se extrae solo si aparece un segundo consumidor real |
| Local protocol | Modulos Rust + TS generados/validados | `light.local.v1`, comandos HTTP y eventos WebSocket |
| Browser client | `packages/light-local-client` cuando sea util | Cliente tipado del protocolo local; no ACP |
| Shared UI | `packages/design-tokens`, `packages/ui` | Tokens y primitivas extraidos despues del backend funcional |
| Work presentation | `packages/chat-ui`, `packages/work-presentation` cuando maduren | Componentes por props, sin imports de daemon/Electron |
| Docs | `docs/light/` + bundle local | Arquitectura, threat model, protocolo, setup y runbooks |

### 3.2 Lifecycle

1. El installer instala un host por usuario, assets versionados y un shortcut `Grok Light`.
2. En Linux, el primer gate usa un servicio de usuario con autostart. Grok Build no se inicia en login.
3. El host adquiere un lock por usuario, valida su estado privado y ocupa su listener loopback.
4. `grok-light open` arranca el host si hace falta, obtiene un nonce mediante IPC privado y abre el browser.
5. Un bookmark funciona mientras el host de autostart este disponible.
6. El host inicia un unico child `grok` al abrir una sesion Work.
7. El child se ejecuta en process group propio, muere con el host y se cierra tras inactividad acotada.
8. Cerrar la pestana no apaga inmediatamente el host. La perdida del control lease aplica las reglas de recovery.

Una visita HTTP no puede iniciar un host detenido. Si el usuario deshabilita autostart debe usar el shortcut o `grok-light open`.

### 3.3 Por que no `grok agent serve`

`grok agent serve` ofrece ACP por WebSocket, no una WebUI ni una frontera de producto. En la revision cualificada actual:

- Solo expone `/ws`.
- Acepta bearer o `server-key` en query.
- El secreto generado por defecto es corto para esta frontera.
- No valida el `Origin` del browser.
- No implementa pairing, control lease, workspace enrollment, protocol allowlist ni journal de Light.
- Su semantica multi-client no equivale a una unica pestana controladora.

Produccion usa stdio. `agent serve` puede aparecer unicamente en contract tests de referencia y nunca como listener browser-facing.

### 3.4 Que no se reutiliza de Desktop

| Pieza Desktop | Decision Light | Motivo |
|---------------|----------------|--------|
| `grok-daemon` IPC / Host Work | No usar como backend | Trust model, lifecycle y configuracion distintos |
| Host Tools enrollment | No reutilizar | Light ejecuta el CLI del usuario, no tools del daemon |
| Electron preload/main | No reutilizar | No existe Electron |
| Desktop `GROK_HOME` | Prohibido leer o compartir | Credenciales y policy pertenecen a Desktop |
| `grok-acp` completo | No reutilizar por defecto | Contiene pin, home privado y policy cerrada de Desktop |
| ACP fixtures e ideas de bounds | Compartir cuando sean neutrales | Evita duplicar tests sin mezclar policy |
| ADR 0008 y bounds del daemon | **Entrada normativa de diseno**, no reuso de codigo | El modelo de event cursor ya esta resuelto y probado; ver 7.4 |
| Views acopladas a `DesktopClient` | No copiar directamente | Extraer presentacion solo cuando el host sea funcional |

**Sobre re-derivar lo ya resuelto.** No reutilizar el codigo del daemon es correcto: lleva policy,
lifecycle y trust model de Desktop. Pero varios mecanismos que `grok-light-host` necesita ya estan
disenados y probados en este monorepo, y volver a derivarlos desde cero es desperdicio, no
independencia. Se toman como entrada de diseno, con su motivo documentado si Light diverge:

- Event sequence, ACK acumulativo, replay acotado y snapshot: `docs/decisions/0008-resumable-run-event-long-poll.md`.
- Constantes de bounds de frame, cola, output y concurrencia del daemon.
- Runtime dir privado, permisos `0700`/`0600`, escritura atomica y revalidacion de identidad de archivo en el momento de uso.
- Supervision de child en process group propio con limpieza del arbol.

---

## 4. Origen local, pairing y control

### 4.1 Origen estable

Formato canonico:

```text
http://<random-install-id>.grok-light.localhost:<stable-high-port>
```

Reglas:

- `install-id` es aleatorio, estable por instalacion y no identifica hardware. Ver 2.2 sobre su exposicion al resolver en browsers no conformes.
- El host escucha solo en loopback.
- El puerto se asigna durante instalacion/reparacion y se persiste en estado owner-only.
- `Host` y `Origin` deben coincidir exactamente con hostname y puerto canonicos.
- Se rechazan aliases, proxy headers, `Origin: null`, peers no loopback y cualquier CORS.
- Un lock owner-only se adquiere antes del bind.

El hostname aleatorio evita compartir cookies sensibles con otros servicios que usan `localhost` en puertos distintos. Las cookies no estan acotadas por puerto, de modo que el hostname es la unica frontera de aislamiento de cookies disponible en loopback; esa es la razon de que sea aleatorio y no un nombre fijo.

**Seleccion de puerto.** El puerto canonico se asigna **fuera del rango efimero local** del sistema
(en Linux, `net.ipv4.ip_local_port_range`, habitualmente `32768-60999`). Asignar dentro de ese rango
garantiza colisiones periodicas con sockets salientes cuando el autostart arranca tarde. La
instalacion lee el rango efectivo y elige por debajo de el; en plataformas sin lectura fiable se usa
un rango reservado documentado.

**Puerto ocupado no es origen comprometido.** Son dos fallos distintos y no comparten remedio:

| Situacion | Respuesta |
|-----------|-----------|
| El puerto canonico esta ocupado al arrancar | Reintento de bind acotado con backoff, conservando hostname, puerto y pairings. Si persiste, el host queda en estado `port_unavailable` con diagnostico y el bookmark sigue siendo valido para cuando se libere |
| El puerto esta ocupado por un proceso que responde al protocolo Light | Fail closed inmediato. Estado `origin_conflict`, sin degradar ni compartir estado |
| El usuario ejecuta `grok-light repair` | Rota puerto, hostname y pairings. El bookmark anterior deja de ser valido. Es una accion explicita, nunca automatica |

Una carrera transitoria por el puerto no debe destruir el bookmark ni los pairings del usuario.
La rotacion de identidad es siempre una decision explicita.

### 4.2 Primer pairing

1. `grok-light open` se comunica con el host mediante Unix socket owner-only.
2. El host genera un nonce de 256 bits, un solo uso y TTL de 60-120 segundos.
3. El launcher abre `http://<origin>/#pair=<nonce>`.
4. El fragmento no llega en la request HTTP.
5. La SPA intercambia el nonce mediante un endpoint de pairing acotado.
6. La SPA elimina el fragmento inmediatamente con `history.replaceState`.
7. El host entrega una cookie host-only, `HttpOnly`, `SameSite=Strict`, `Path=/` y con expiracion acotada.
8. El host guarda solo un hash del token de browser y permite revocacion individual o total.
9. El usuario crea el bookmark despues de eliminar el fragmento.

No se usan tokens en query string, `localStorage`, bookmark, logs o WebSocket URL.

### 4.3 Requests y WebSocket

Mutaciones HTTP:

- Solo `POST`, `PUT` o `DELETE` con JSON acotado.
- Cookie emparejada obligatoria.
- `Origin` exacto obligatorio.
- CSRF token impredecible mantenido en memoria de la pagina.
- `Sec-Fetch-Site: same-origin` validado cuando exista, sin usarlo como unico control.
- Ninguna mutacion en `GET`.

Upgrade WebSocket:

- `Host` exacto.
- `Origin` exacto.
- Cookie emparejada.
- Subprotocolo versionado exacto.
- Frames, colas y outputs acotados antes de llegar a la SPA.

### 4.4 Una pestana controladora

- La primera pestana emparejada adquiere un control lease asociado a su WebSocket y a un epoch monotono.
- Prompt, cancel, workspace mutation y permission decision incluyen el epoch esperado.
- Una segunda pestana queda bloqueada; v1 puede mostrar solo status, nunca contenido sensible ni mutaciones.
- Heartbeats renuevan el lease.
- Una gracia corta permite reload/reconnect de la misma pestana.
- Al expirar la gracia se deniegan permisos pendientes, se intenta cancelar el turno y cualquier efecto ambiguo queda `interrupted_needs_review`.
- V1 no permite force takeover de una pestana controladora viva.

### 4.5 Headers y assets

- `Content-Security-Policy` estricta con `default-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`, `form-action 'self'` y `base-uri 'none'`.
- `Referrer-Policy: no-referrer`.
- `X-Content-Type-Options: nosniff`.
- `Cross-Origin-Opener-Policy: same-origin`.
- `Permissions-Policy` restrictiva.
- Entry document con `Cache-Control: no-store`.
- Assets hasheados pueden ser immutable.
- Sin scripts, estilos, fuentes, imagenes o iframes remotos.
- Sin service worker en v1.

### 4.6 Matriz de browsers

Light depende de que el browser aplique la regla de resolucion de `let-localhost-be-localhost`:
forzar `*.localhost` a loopback sin consultar DNS, y tratar ese origen como potentially trustworthy.
Esto no es un spike abierto; el estado esta establecido y es estable.

| Motor | Estado | Nota |
|-------|--------|------|
| Chromium: Chrome, Edge, Brave, Opera | Conforme | Fuerza resolucion y trata el origen como potentially trustworthy |
| Firefox 84+ | Conforme | Soporte de `http://localhost` y `http://*.localhost` como origenes trustworthy desde la 84 |
| WebKit: Safari, GNOME Web/Epiphany, WebKitGTK | **No conforme** | No implementa la regla de resolucion ni trata loopback como trustworthy. WebKit bug 171934, abierto desde 2017 y sin compromiso de cambio |

Reglas:

- La matriz soportada es Chromium y Firefox 84+. WebKit no esta soportado y no se cualifica.
- El setup detecta el motor y, si no es conforme, bloquea con diagnostico y guia en vez de fallar de forma opaca.
- El instalador de cada plataforma verifica la presencia de al menos un browser conforme.
- El resolver del sistema no mapea `*.localhost`, de modo que fuera de la matriz conforme el nombre del origen sale a DNS. Ver 2.2.
- Windows queda cubierto por Edge, que es Chromium. Linux requiere Chromium o Firefox, no Epiphany.
- macOS requiere Chrome o Firefox de forma explicita: Safari, su browser por defecto, no puede ejecutar Light. Ver Fase 9.

---

## 5. Contrato con Grok Build CLI

### 5.1 Ejecutable

- La web no elige path, argv, variables de entorno ni version.
- El host resuelve y persiste localmente el ejecutable cualificado.
- Cada spawn revalida path canonico, identidad de archivo y version.
- Una version fuera de la matriz queda `unsupported_cli`; no existe fallback silencioso.
- El child se lanza directamente, nunca mediante shell.
- El browser no puede habilitar `--always-approve`, `--plugin-dir`, custom endpoints ni flags arbitrarios.

**Que es y que no es la cualificacion del ejecutable.** Sirve a la **integridad de producto**:
acotar el soporte a un contrato ACP conocido, evitar conducir un fork sin querer y dar un
diagnostico honesto cuando el CLI cambia. **No es un control de seguridad**, y el plan no debe
presentarlo como tal.

La razon es 5.2: la configuracion completa del usuario esta en scope, incluidos plugins, hooks,
servidores MCP y endpoints personalizados, todos ejecutandose con la misma autoridad que el propio
CLI. Fijar el binario defiende contra un `grok` sustituido; la superficie de configuracion ya
aceptada es un agujero estrictamente mayor. Tratar la procedencia como frontera de seguridad seria
incoherente con esa decision y daria una falsa sensacion de contencion.

De ahi se sigue la politica cuando no hay procedencia criptografica verificable:

- Si la plataforma publica firmas o checksums verificables del artifact, el host los usa y lo registra.
- Si no los publica, la cualificacion se apoya en **version mas identidad de archivo** (path canonico, identidad de inodo/handle retenida entre verificacion y uso) y se documenta como tal.
- La ausencia de firma **no bloquea** Fase 1 ni el gate Linux, porque la procedencia nunca fue la frontera de seguridad. Lo que si bloquea es una version fuera de la matriz o un contrato ACP que no case con sus fixtures.

Invocacion de produccion:

```text
grok agent --no-leader stdio
```

**Por que `--no-leader`.** El CLI distingue un modo leader, en el que una instancia asume estado
compartido del usuario, de un modo no-leader. Light supervisa un child dedicado y de vida corta por
sesion Work, y no debe disputar ese rol con una instancia interactiva que el usuario tenga abierta.
`--no-leader` es lo que permite que Light coexista con un `grok` TUI en ejecucion.

Consecuencias que hay que tener presentes:

- `--no-leader` es tambien el modo en el que `--plugin-dir` deja de ignorarse. Light nunca pasa ese flag, pero la eleccion de modo no es neutral respecto a la resolucion de plugins y debe contract-testearse.
- Fase 1 debe verificar el comportamiento con un leader vivo en paralelo y con ninguno, y documentar cual es el estado esperado en cada caso.
- Si una version cualificada cambiara la semantica de leader, se trata como drift de contrato.

La posicion exacta de flags se contract-testea contra cada version cualificada.

### 5.2 Configuracion completa del usuario

Light usa el `GROK_HOME` normal del usuario. No copia auth, no crea un home paralelo y no modifica configuracion desde la web.

Consecuencias normativas:

- El CLI puede usar modelos o endpoints personalizados.
- Plugins, hooks, MCP, memoria, skills, project config y folder trust siguen aplicando.
- Reglas de allow/deny/ask, permission mode, safe commands y grants persistidos siguen aplicando.
- Una accion autoaprobada por Grok puede no producir `session/request_permission`; Light no puede interponerse en una solicitud que ACP no emite.
- Hooks pueden ejecutarse conforme al lifecycle nativo del CLI antes de ciertos prompts.
- Light debe mostrar el modo efectivo y explicar que respeta la configuracion del usuario.
- Esta decision requiere un ADR y una excepcion explicita en `AGENTS.md`; no debe debilitar los invariantes de Grok Desktop.

### 5.3 Auth y secretos

- Grok Build posee login, refresh, logout y `auth.json`.
- Light usa los metodos ACP de auth/status que la version cualificada anuncie.
- Tokens OAuth, API keys, refresh tokens y auth files nunca entran al browser ni al protocolo Light.
- Light no importa cookies de browser ni credenciales desde Desktop.
- Errores de auth se proyectan como estados no secretos.

### 5.4 Capabilities y drift

- El handshake ACP negocia version y capacidades reales.
- Plan mode solo aparece cuando el CLI lo anuncia y su comportamiento esta contract-testeado.
- Tool, MCP y payload renderers toleran tipos desconocidos mediante una vista acotada, nunca mediante eval.
- Cada release Light mantiene `minGrokVersion`, versiones cualificadas y fixtures golden.
- Un cambio incompatible del CLI bloquea la sesion con diagnostico local.

---

## 6. Workspaces

Entidad local:

```text
WorkspaceRef {
  id,
  displayName,
  canonicalPath,
  filesystemIdentity,
  revision,
  lastOpenedAt
}
```

Reglas:

- La API de sesiones acepta `workspaceId`, nunca un cwd suministrado por el browser.
- La web solo puede pedir al host que abra el selector local.
- Linux usa `xdg-desktop-portal` como primera ruta de producto; un comando local `grok-light workspace add` es fallback de setup, no un textarea web.
- El host canonicaliza y registra identidad del directorio seleccionado.
- Antes de cada session start reabre y revalida identidad, symlinks y mount behavior.
- Raices de filesystem y home completo requieren disclosure reforzado o se rechazan en v1 segun threat model.
- Workspace enrollment no es containment. El CLI y sus child processes conservan la autoridad del usuario del sistema.
- Folder trust propio de Grok sigue vigente y Light no pasa `--trust` silenciosamente.

---

## 7. Protocolo `light.local.v1`

### 7.1 Superficie cerrada

HTTP commands iniciales:

- `Bootstrap`
- `GetHostStatus`
- `ListWorkspaces`
- `OpenWorkspacePicker`
- `RemoveWorkspace`
- `ListSessions`
- `LoadSession`
- `CreateSession`
- `Prompt`
- `CancelTurn`
- `CloseSession`
- `DecidePermission`
- `AcknowledgeEvents`
- `RevokeBrowserPairing`

No existe metodo generico para enviar ACP, ejecutar JSON-RPC, lanzar procesos, editar config, seleccionar path, cambiar origen o cambiar policy.

### 7.2 Envelope de comando

```json
{
  "protocolVersion": 1,
  "requestId": "opaque-id",
  "idempotencyKey": "opaque-key",
  "controllerEpoch": 7,
  "sessionId": "optional-session-id",
  "expectedRevision": 4,
  "deadlineUnixMs": 0,
  "operation": {}
}
```

Cada operacion tiene schema cerrado y bounds propios. IDs, revisions, deadlines e idempotency se validan antes de dispatch.

### 7.3 Eventos

```json
{
  "protocolVersion": 1,
  "eventSequence": 42,
  "sessionRevision": 5,
  "event": {}
}
```

Tipos iniciales:

- `host.status`
- `session.snapshot`
- `session.status`
- `message.delta`
- `thought.delta`
- `tool.start`
- `tool.progress`
- `tool.end`
- `plan.updated`
- `permission.request`
- `turn.interrupted`
- `error`

### 7.4 Invariantes de recovery

- El host persiste intencion antes de enviar un prompt o una permission decision al CLI.
- Cada evento tiene sequence monotona y requiere ACK acumulativo.
- Reconnect envia el ultimo sequence reconocido.
- El host hace replay acotado o entrega snapshot cuando el cursor expiro.
- Ningun prompt ambiguo se reenvia automaticamente.
- Ninguna permission decision se repite tras timeout o resultado incierto.
- Un side effect no idempotente sin resultado durable queda `interrupted_needs_review`.
- El cierre del child deniega permisos pendientes y elimina cualquier grant solo-en-memoria del CLI.
- Sizes, queues, concurrency, output, diagnostics y retention se acotan desde la primera implementacion.

El diseno de sequence monotona, ACK acumulativo, replay acotado y snapshot en expiracion de cursor
tiene precedente implementado y probado en este monorepo:
`docs/decisions/0008-resumable-run-event-long-poll.md`. Ese ADR y las constantes de bounds del
daemon Desktop son **entradas normativas de diseno** para 7.4. Light no reutiliza el codigo, que
lleva policy de Desktop, pero no vuelve a derivar el modelo ni sus casos de prueba desde cero. Toda
divergencia respecto al ADR 0008 se documenta con su motivo.

No se expone `machineIdPublic`. La instalacion usa un ID local aleatorio sin significado fuera del origen.

### 7.5 Ciclo de vida de `interrupted_needs_review`

`interrupted_needs_review` es un invariante de producto heredado de `AGENTS.md`: un side effect no
idempotente interrumpido nunca se reproduce automaticamente. Para que sea un estado y no una
etiqueta, v1 define su ciclo completo.

**Entrada.** El host marca el registro cuando un efecto no idempotente quedo despachado sin
resultado durable conocido: perdida de la pestana controladora con permiso pendiente, muerte del
child a mitad de turno, caida del host tras persistir intencion, o timeout de una decision cuyo
resultado no se pudo confirmar.

**Contenido.** El registro guarda `sessionId`, `turnId`, la identidad de la operacion, el digest de
la intencion persistida, el instante y la causa. No guarda cuerpos de prompt, de archivo ni de tool
output, conforme a 9.

**Acciones del usuario en v1.** Exactamente dos, ambas explicitas y ninguna automatica:

| Accion | Efecto |
|--------|--------|
| Acknowledge | Marca el registro como revisado por el usuario y lo saca de la vista activa. No reintenta nada ni afirma que el efecto ocurriera o no |
| Descartar | Elimina el registro tras acknowledge, sujeto a la politica de retencion |

V1 **no** ofrece reintentar ni deshacer. Light no sabe si el efecto se materializo y no debe
insinuar que puede resolverlo. La resolucion real ocurre en el workspace del usuario.

**Bloqueo.** Un registro pendiente **no** bloquea abrir sesiones nuevas: eso convertiria un aviso en
una parada dura. Si que se muestra de forma persistente en la superficie de Run control de 2.4 hasta
que se haga acknowledge, y el estado se refleja en la sesion afectada.

**Retencion.** El journal acota numero y antiguedad de registros segun 9. La expiracion por
retencion nunca implica que el efecto quedara resuelto, y el copy debe decirlo.

---

## 8. Permisos v1: matching nativo

### 8.1 Semantica observada en Grok Build

**El client type de Light es `Generic`, no una clase propia.** `ClientType::from_client_identifier`
(`permission/types.rs`) solo reconoce `grok-web`, `nebula`, `grok-code-extension`, `grok-desktop`
y `grok-pager`. Cualquier otro identificador, incluido `grok-light`, cae en el brazo por defecto
`_ => Self::Generic`, documentado en el propio enum como "show simple permission options with full
command text". Light no obtiene un bucket propio y no debe asumirlo.

Consecuencias normativas:

- La tabla siguiente describe la semantica **para `ClientType::Generic`**. Cualquier fila derivada
  de observar TUI, Pager o Desktop no es valida para Light hasta re-derivarla contra `Generic`.
- Fase 1 debe re-derivar y fijar esta tabla ejecutando los contract tests con el client identifier
  real de Light, no con otro cliente.
- Un contract test debe afirmar explicitamente que Light resuelve a `Generic`, de forma que la
  suite rompa si xAI anade un brazo `grok-light` o cambia el default.

| Access kind | Opcion nativa | Duracion real observada |
|-------------|---------------|-------------------------|
| Edit | `allow-once` | Una solicitud |
| Edit | `allow-edits-session` | Booleano en memoria de la sesion ACP |
| Bash | `AllowAlways` exacto/prefijo | Persistido por cwd/client cuando esta habilitado |
| MCP | `AllowAlways` tool/server | Persistido por cwd/client cuando esta habilitado |
| Web fetch | `allow-always-domain` | Persistido aunque el label pueda decir "this session" |
| Global | `enable-always-approve` | El cliente nativo puede activar y persistir yolo |
| Cualquiera | `reject-once` | Rechaza la solicitud actual |
| Cualquiera | `reject-always` | Rechazo persistente; presente al menos junto a opciones Bash |
| Read/Grep/WebSearch/safe commands | Sin prompt habitual | Auto-resolucion del permission manager/configuracion |

No existe una opcion ACP general "Always for this session" para todas las acciones. `PermissionOptionKind::AllowAlways` no determina por si solo el lifetime; option ID, access kind, client type y configuracion cambian la semantica.

**Invariante de opcion no persistente.** En la revision auditada, todos los sets de opciones
construidos por `prompter.rs` incluyen simultaneamente `allow-once` y `reject-once`, incluso
cuando ademas ofrecen `always-allow`, `allow-always-domain` o `allow-always-mcp`. Light depende de
ese invariante: renderiza solo un subconjunto y, sin una opcion de una sola vez, un prompt quedaria
sin via de avance. Por tanto:

- Un contract test verifica, por access kind, que la version cualificada ofrece `allow-once` y `reject-once`.
- Una version que no los ofrezca en algun access kind queda `unsupported_cli`. No se cualifica.
- Si aun asi llega en runtime un prompt sin opcion de una sola vez, Light no renderiza un dialogo
  con solo Deny: muestra un estado de incompatibilidad que nombra las opciones recibidas, y falla
  cerrado cancelando o denegando segun permita el contrato ACP.

### 8.2 Contrato aprobado de Light v1

Light muestra y responde solamente:

1. **Allow once:** el ID nativo exacto `allow-once` cuando ACP lo ofrece.
2. **Deny:** el ID nativo exacto `reject-once` cuando ACP lo ofrece.
3. **Allow edits for this session:** solo cuando ACP ofrece el ID nativo exacto `allow-edits-session` para un access kind Edit.

Reglas:

- Light nunca fabrica option IDs ni responde una opcion que el CLI no ofrecio.
- Light no implementa matching propio de comandos, tools o dominios en v1.
- Light no presenta `AllowAlways` persistente para Bash, MCP o web fetch.
- Light no presenta ni activa `enable-always-approve`.
- Light no envia `x.ai/yolo_mode_changed` para habilitar yolo.
- Light no escribe permission state ni `config.toml` de Grok.
- Light no ofrece `Always cwd`.
- **Light no presenta `reject-always`.** El rechazo persistente es una politica duradera con la
  misma naturaleza que los grants `AllowAlways` que v1 excluye, y su alcance real depende del
  permission manager del CLI. Deny mapea siempre a `reject-once`; si una version cualificada
  ofreciera `reject-always` sin `reject-once`, aplica la regla de incompatibilidad de 8.1.
- Timeout, saturacion, pestana perdida o controller epoch incorrecto fallan cerrado con Cancel/Deny cuando el contrato ACP lo permita.
- El browser devuelve solo `requestId`, `expectedRevision` y `optionId` exactos; el host verifica que la opcion seguia activa y ofrecida.

El cliente ACP se identifica con un `clientIdentifier` propio, por ejemplo `grok-light`. Como se
detalla en 8.1, ese identificador resuelve a `ClientType::Generic`; Light asume y contract-testea
la semantica de `Generic`, no la de un bucket propio. Light no se hace pasar por Desktop, Pager o
Grok Web para obtener opciones adicionales, y un cambio del brazo por defecto en el CLI se trata
como drift de contrato.

### 8.3 Configuracion preexistente

La decision de respetar configuracion completa implica:

- Yolo, auto mode, safe-command allows, policy allows y grants persistidos pueden resolver una accion sin prompt Light.
- Deshabilitar una fila en Light no revoca grants que ya existen en `GROK_HOME`.
- Light proyecta la informacion efectiva que ACP exponga y muestra disclosure; no promete mediacion total.
- El usuario gestiona o revoca esas reglas con Grok Build fuera de la WebUI.

### 8.4 Fuente de verdad del matching

El contrato se deriva del comportamiento del CLI cualificado, no de labels ni de una interpretacion generica de `PermissionOptionKind`:

- Construccion de opciones y constantes de option ID: `grok-build-repo/crates/codegen/xai-grok-workspace/src/permission/prompter.rs`.
- Mapping de `optionId` a outcome: `map_selected_outcome` en el mismo modulo.
- Lifetime, auto-resolucion y persistencia: `grok-build-repo/crates/codegen/xai-grok-workspace/src/permission/manager.rs`.
- Estado por cwd/client: `grok-build-repo/crates/codegen/xai-grok-workspace/src/permission/state.rs`.
- Resolucion de client type: `ClientType` y `ClientType::from_client_identifier` en `grok-build-repo/crates/codegen/xai-grok-workspace/src/permission/types.rs`, mas el initialize ACP del shell.

Contract tests obligatorios por version cualificada:

1. El `clientIdentifier` de Light resuelve a `ClientType::Generic`.
2. Cada access kind ofrece `allow-once` y `reject-once`.
3. Los IDs que Light renderiza existen con la semantica esperada: `allow-once`, `reject-once` y `allow-edits-session`.
4. Los IDs que Light oculta siguen identificados y no se responden nunca: `always-allow`, `reject-always`, `allow-always-mcp`, `allow-always-domain`, `enable-always-approve`.

Cada version de Grok aceptada por Light debe repetir estos contract tests contra el artifact publicado. Un cambio de option ID, kind, client type, brazo por defecto o lifetime bloquea esa version hasta revisar el contrato Light.

Nota de mantenimiento: `grok-build-repo/` es una copia de trabajo local y no esta versionada en este
monorepo. Los contract tests se ejecutan contra el artifact publicado e instalado, y las rutas de
arriba son referencia de lectura para derivar el contrato, no una dependencia de build.

---

## 9. Persistencia local

| Dato | Owner |
|------|-------|
| Auth, CLI config, sessions y transcripts Grok | Grok Build bajo `GROK_HOME` |
| Install ID, hostname y puerto | Host Light, owner-only |
| Hashes de browser pairing | Host Light, owner-only |
| `WorkspaceRef` | Host Light, owner-only |
| Command/effect journal y event cursors | Host Light, owner-only y bounded |
| Registros `interrupted_needs_review` | Host Light, owner-only, bounded y con retencion declarada; ver 7.5 |
| Tema/layout | Browser local storage del origen Light |
| Permission grants propios | Ninguno en v1 |

Light no duplica transcripts por defecto. Usa list/load/search ACP cuando la version cualificada lo soporte. Si una feature futura necesita un indice propio, requiere threat review, retention y migracion explicitos.

El journal no almacena cuerpos completos de prompts, archivos o tool output. Guarda IDs, digests, estados, revisions y evidencia minima de recovery. Cualquier dato sensible inevitable usa almacenamiento privado y la politica de cifrado definida en el threat model.

En Linux:

- Directorios privados `0700`.
- Archivos sensibles `0600`.
- Creacion atomica y fsync donde la durabilidad lo requiera.
- No seguir symlinks ni aceptar ownership inesperado.

No existe sync ni backup cloud. Export/import es una feature local posterior y debe comunicar que el historial vive con el CLI en esa maquina.

---

## 10. Estructura objetivo del monorepo

```text
apps/
  desktop/
  light/                    # SPA embebida; se implementa despues del host
packages/
  light-local-client/       # cuando la separacion aporte valor
  design-tokens/            # extraccion posterior
  ui/                       # extraccion posterior
  chat-ui/                  # convergente, no gate del backend
  work-presentation/        # convergente, no gate del backend
crates/
  grok-light-host/          # binario, server local, protocol, ACP y recovery
docs/
  light/
    light-website-plan.md
    overview.md
    architecture.md
    protocol.md
    threat-model.md
    connect-guide.md
    adr/
```

Reglas de ownership:

- Mantener ACP adapter dentro del host hasta demostrar una abstraccion compartible.
- No extraer un package por anticipacion.
- No hand-edit de generated protocol output si se elige generacion.
- Rust host no depende de React.
- SPA no depende de Electron, Node runtime, daemon DTOs ni ACP types.
- Assets Light se construyen y embeben/versionan junto con el host.
- No existe `deploy:light` a CDN. Los previews de UI usan fake local explicitamente etiquetado.

---

## 11. Implementacion por fases

El programa entrega un producto final completo, pero reduce riesgo con vertical slices. La UI final es deliberadamente tardia.

El programa tiene un punto de decision explicito: el **hito de dogfood interno** al cierre de Fase 5,
donde la premisa del producto queda demostrada o refutada con uso real. Fases 0 a 5 construyen y
validan; fases 6 a 10 endurecen y publican. No se entra en Fase 6 sin la decision registrada de ese
hito.

### Fase 0 - ADRs, invariantes y contratos

Entregables:

- ADR: Light es producto Work-only y composition root separado.
- ADR: configuracion completa del CLI del usuario en scope y limites de claims.
- Actualizacion de `AGENTS.md` que preserve los invariantes Desktop y documente la excepcion Light.
- ADR: host local con SPA embebida; no CDN ni backend Light.
- ADR: ACP stdio; `agent serve` no es frontera de produccion.
- ADR: pairing, origen, control lease y una agent session.
- ADR: permisos v1 con matching ACP nativo exacto, incluyendo client type `Generic` y el invariante `allow-once`/`reject-once` de 8.1.
- ADR: matriz de motores de browser de 4.6 y exclusion de WebKit.
- ADR: la cualificacion del ejecutable es integridad de producto y no control de seguridad, segun 5.1.
- `docs/light/threat-model.md` baseline, incluyendo el limite multiusuario de 13.1 y la exposicion del `install-id` al resolver de 2.2.
- `docs/light/protocol.md` draft de `light.local.v1`.
- Naming de crates/packages y copy de claims/non-claims.

Gate:

- ADRs aceptados.
- Root guidance no contiene contradicciones sobre Light.
- Schemas y bounds iniciales revisados.
- Ningun claim del documento afirma ausencia total de red ni mediacion total de permisos.

### Fase 1 - Spikes Linux y cualificacion del CLI

Entregables:

- Matriz de versiones Grok publicadas y prueba del artifact real instalado.
- Politica Linux de identidad y version del ejecutable, con firma o checksum si la plataforma los publica y con la salida documentada de 5.1 si no.
- Harness ACP stdio contra fake agent y CLI real.
- Contract fixtures para initialize, auth, session/new, session/load, prompt, cancel y permissions.
- Verificacion de que el `clientIdentifier` de Light resuelve a `ClientType::Generic`, y re-derivacion de la tabla de 8.1 contra ese client type.
- Verificacion del invariante `allow-once`/`reject-once` por access kind.
- Golden tests que prueben `allow-once`, `reject-once` y `allow-edits-session` exactos, y que `always-allow`, `reject-always`, `allow-always-mcp`, `allow-always-domain` y `enable-always-approve` nunca se responden.
- Comportamiento de `--no-leader` con y sin una instancia leader viva en paralelo.
- Prueba de que `agent serve` no participa en produccion.
- Verificacion de la matriz de 4.6 en Linux: resolucion de `*.localhost` sin consulta DNS, secure context, cookies y WebSocket en Chromium y Firefox, y bloqueo con diagnostico en un motor WebKit.
- Spike systemd user autostart y `xdg-desktop-portal` folder picker.
- Lectura del rango efimero del sistema y eleccion de puerto canonico fuera de el, segun 4.1.

Gate:

- Un proceso local de prueba completa una tarea ACP real sin browser y sin `--always-approve`.
- La version cualificada coincide con sus fixtures y permission semantics, incluida la resolucion a `Generic`.
- La matriz de browsers de 4.6 se confirma en Linux y un motor no conforme se detecta y bloquea.
- Los spikes no descubren un bloqueo de origen, cookie, autostart o picker.

### Fase 2 - Host local foundation

Entregables:

- `crates/grok-light-host`.
- Single-instance lock y owner-only control socket.
- Stable local origin y port state.
- Server HTTP con placeholder HTML embebido.
- `grok-light serve|open|status|doctor|stop|repair`.
- User-service integration Linux.
- Security headers, no CORS y no outbound Light network.
- Pair nonce, cookie session, CSRF y revocation.
- Control lease de una pestana.

Gate:

- Clean Linux account abre el bookmark despues de login.
- Un sitio de otro origen no puede leer ni mutar el host.
- Host stopped requiere shortcut/open y nunca arranca desde una request web.

### Fase 3 - Protocolo, journal y fake agent

Entregables:

- Schemas Rust/TS `light.local.v1`.
- Request validation, idempotency, revisions y deadlines.
- Event sequence, ACK, replay y snapshot.
- Journal intent-before-dispatch.
- Fake ACP child con streaming, tools, permission y crash controls.
- Bounds de frames, queues, output, diagnostics y concurrency.
- Recovery de browser, child y host crash.

Gate:

- Tests demuestran que reconnect no duplica prompts ni permission decisions.
- Un efecto ambiguo termina `interrupted_needs_review`.

### Fase 4 - Grok Build ACP real

Entregables:

- Resolucion y revalidacion del ejecutable.
- Spawn `grok agent --no-leader stdio` en process group propio.
- Initialize y capability negotiation.
- Auth/status no secretos.
- One active agent session.
- Create/load/prompt/cancel/close.
- Event mapping acotado.
- Permission matching v1 exacto.
- Sanitized diagnostics.

Gate:

- Operador humano completa una tarea real desde un cliente tecnico minimo.
- `allow-once`, `reject-once` y `allow-edits-session` se comportan igual que en el CLI cualificado.
- Ninguna opcion persistente oculta se responde nunca, verificado en runtime y no solo en fixtures.
- Configuracion preexistente autoaprobada se muestra como limitacion, no como decision de Light.

### Fase 5 - Workspaces e historial

Entregables:

- Portal-native picker y fallback CLI local.
- `WorkspaceRef`, canonicalizacion y revalidacion.
- Session list/load/search usando ACP disponible.
- Recovery tras CLI exit y host restart.
- Estados unsupported/missing/auth/config/protocol.

Gate:

- El browser nunca suministra un path.
- Symlink/mount/replacement tests fallan cerrado.
- Sessions sobreviven segun la persistencia nativa de Grok sin duplicar transcripts.

---

### Hito de dogfood interno (cierre de Fase 5)

Punto de decision explicito del programa. Al cerrar Fase 5 existe, por primera vez, un artefacto
que un miembro del equipo puede usar a diario en Linux: host local, ACP real, permisos v1,
workspaces y recovery. La UI todavia es minima y el empaquetado no existe.

Este hito no es un release ni un gate de calidad; es el momento en que la premisa del producto
—una WebUI local para el CLI que el usuario ya tiene— queda demostrada o refutada con uso real, y
por tanto el momento en que el programa se puede parar, re-escopar o continuar **con informacion**
en vez de por inercia.

Salida requerida:

- Al menos un operador usa Light para trabajo real durante un periodo acordado.
- Registro de friccion, drift del CLI y huecos de permisos observados.
- Decision escrita: continuar a Fase 6, re-escopar, o detener.

Sin esta decision registrada no se entra en Fase 6. Las fases 6 a 10 son hardening, empaquetado y
GA: coste alto y valor incremental, y no deben iniciarse sobre una premisa no validada.

---

### Fase 6 - Hardening funcional

Entregables:

- Origin, Host, CSRF, cookie, DNS rebinding y cross-site WebSocket tests.
- Port squatter, stale lease y second-tab tests.
- Oversized ACP/browser message y reconnect storm tests.
- Child process tree cleanup y host crash tests.
- Log/diagnostic redaction tests.
- No-outbound-network tests para SPA y host Light, acotados al trafico originado por Light y excluyendo explicitamente la resolucion del nombre del origen.
- Deteccion y bloqueo de browser fuera de la matriz conforme de 4.6.
- Cross-user probe test en maquina Linux multiusuario segun 13.1.
- Compatibility failure UX para CLI drift.

Gate:

- Threat model review pass.
- No known path de browser no emparejado a command dispatch.
- No replay automatico de side effects ambiguos.

### Fase 7 - SPA y sistema visual

Entregables:

- `apps/light` Vite + React + TypeScript.
- Setup, workspace list, session, permission, recovery, settings Light y docs locales.
- Extraccion de `design-tokens` y primitivas UI solo cuando reduzca duplicacion real.
- Chat/work presentation por props, sin `DesktopClient` ni ACP types.
- A11y WCAG AA en pairing, permission y recovery.
- Browser E2E contra fake host y host real.

Gate:

- Todos los flows funcionales ya probados por debajo de la UI siguen verdes.
- Visual review contra DESIGN.md sin regresion Desktop.
- Browser network muestra solo el origen local para codigo Light.

### Fase 8 - Packaging y release Linux

Entregables:

- Artifact Linux reproducible con host + SPA embebida.
- Install/uninstall, user service, shortcut y repair.
- Version policy host/SPA/CLI.
- SBOM y signing/provenance segun politica del repo.
- Clean-machine guide local.
- Release qualification Linux x64.

Gate:

- Usuario nuevo completa setup y Work siguiendo solo la guia instalada.
- Bookmark funciona tras nuevo login.
- Upgrade compatible conserva origin, pairings y workspaces; security migration puede revocarlos explicitamente.

### Fase 9 - Windows y macOS

- Windows user lifecycle, named pipe, native picker, installer y browser matrix. Edge es Chromium, de modo que el browser por defecto ya es conforme segun 4.6.
- macOS launch agent, native picker, signing/notarization y browser matrix.
- **macOS requiere Chrome o Firefox de forma explicita.** Safari, el browser por defecto de la plataforma, es WebKit y no es conforme segun 4.6: no fuerza la resolucion de `*.localhost` ni trata loopback como origen potentially trustworthy. Esto es una restriccion conocida y estable, no un riesgo a descubrir en la fase.
- El gate macOS incluye: requisito de browser declarado en instalador y documentacion, deteccion con diagnostico al abrir en Safari, y guia de setup que no asume el browser por defecto.
- Ninguna plataforma se declara soportada por paridad de compilacion; requiere su propio gate real.

### Fase 10 - Operacion continua

- Owner de compatibility matrix y freeze cuando falla el probe del CLI estable.
- Proceso de bump de versiones Grok cualificadas.
- Renovate/dependency policy.
- Runbooks de incidentes de pairing, protocol drift y release.
- No scope creep hacia Chat/Research/Guest sin ADR de producto.

---

## 12. Testing strategy

| Capa | Cobertura obligatoria |
|------|-----------------------|
| Domain/protocol | revisions, idempotency, deadlines, bounds, event cursor y recovery |
| Host HTTP/WS | exact Host/Origin, pairing, CSRF, cookies, leases y malformed frames |
| ACP adapter | fake child, real CLI fixtures, timeouts, cancellation y process death |
| Permission contract | client type resuelve a `Generic`, presencia de `allow-once`/`reject-once` por access kind, identidad de las opciones ofrecidas, Allow once, Deny, edit-session y opciones persistentes ocultas jamas respondidas |
| Workspace | portal result, canonical identity, symlink/mount/replacement races |
| Persistence | private permissions, atomic writes, restart, corrupt/truncated journal |
| Browser | one controller, reload grace, second tab, no external requests, matriz conforme de 4.6 y bloqueo de no conformes |
| Adversarial web | cross-origin fetch/form/WS, DNS rebinding shapes y port squatting |
| Adversarial local | cross-user probe del listener, control socket owner-only y permisos del estado del host |
| Manual Linux | installed CLI versions, auth, user config, systemd user service, clean account y cuenta secundaria |
| UI packages | Testing Library y visual/a11y review despues de extraccion |
| Desktop regression | Full relevant gates cuando se extraigan shared packages |

Escenarios de recovery minimos:

| Fallo | Resultado requerido |
|-------|--------------------|
| Tab reload corto | Recupera lease y eventos desde ACK |
| Tab/controller perdido | Deniega pending permission, cancela acotadamente y expira lease |
| CLI crash | Pending permissions denegados; turno failed/interrupted; no replay |
| Host crash | Child muere con parent; journal no terminal requiere review |
| OS reboot | Host reinicia; ningun prompt in-flight se reenvia |
| Port ocupado | Fail closed; repair explicito rota origin y pairings |
| CLI version drift | Unsupported state local; no compatibility fallback |

---

## 13. Seguridad y privacidad

Documento obligatorio: `docs/light/threat-model.md`.

Controles base:

1. Loopback only. Ver el limite multiusuario mas abajo: loopback acota la maquina, no la cuenta.
2. Stable random `.localhost` origin, dentro de la matriz de browsers conformes de 4.6.
3. Pairing de 256 bits y cookie host-only.
4. Exact Host/Origin y no CORS.
5. Una pestana controladora y epochs monotonicamente crecientes.
6. Workspace IDs opacos y picker local.
7. Browser nunca recibe ACP bruto ni credenciales de autenticacion. Si recibe tool output, que puede ser sensible; ver 2.5.
8. Closed Light operation union.
9. Intent-before-effect y no ambiguous replay.
10. Bounds en cada frontera.
11. Child directo, sin shell y con lifecycle supervisado.
12. Logs sin prompt bodies, file bodies, OAuth tokens, API keys ni tool output sensible.
13. SPA y host Light sin trafico saliente originado por Light. Excluye la resolucion del nombre del origen por el browser; ver 2.2.
14. Configuracion completa del CLI claramente disclosed como autoridad del usuario.

El browser, contenido del modelo, archivos, tool output, plugins, hooks y MCP son input no confiable. Pairing y approvals mejoran control de usuario; no son containment.

### 13.1 Limite multiusuario

Loopback es una frontera de maquina, no de cuenta de usuario. En un host Linux compartido, cualquier
usuario local puede abrir una conexion TCP contra el listener de Light. Esto es explicito y no un
descuido: el control de acceso no es la interfaz de escucha.

Lo que sostiene la frontera:

- El nonce de pairing solo se emite por el control socket Unix owner-only de 4.2; otro usuario no puede solicitarlo.
- El estado del host, incluidos hashes de pairing y puerto, es owner-only con permisos `0700`/`0600`.
- Sin cookie emparejada, toda operacion del protocolo se rechaza.

Lo que no protege:

- Un usuario local no privilegiado puede detectar que el puerto esta abierto y sondear el endpoint.
- Un usuario con privilegios de root o capaz de leer el home del usuario objetivo esta fuera del modelo de amenaza; en ese escenario tambien posee `GROK_HOME` y el CLI.

`docs/light/threat-model.md` debe declarar este limite, y la suite incluye un test cross-user en
maquina Linux multiusuario segun 12.

---

## 14. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigacion |
|--------|---------|------------|
| CLI publicado difiere del contrato cualificado | Alto para soporte, no frontera de seguridad | Exact version matrix y contract tests contra artifacts reales; ver 5.1 sobre por que la procedencia no es control de seguridad |
| Config del usuario autoaprueba sin UI Light | Alto | Disclosure, effective-state projection y no claim de mediacion total |
| Hook/plugin ejecuta antes de prompt | Alto | Config completa explicitamente in-scope; threat copy y diagnostics |
| Browser no emparejado intenta controlar loopback | Critico | Pairing, cookie, exact Host/Origin, CSRF, control lease y closed API |
| Proceso local suplanta el puerto | Alto | Random hostname/port, autostart, lock, private launcher IPC; HTTPS local si entra en threat model futuro |
| `install-id` observable por el resolver DNS | Medio, privacidad | Matriz de browsers conformes de 4.6, divulgacion en 2.2 y non-claim en 2.5. Sin control tecnico posible desde el host |
| Browser fuera de la matriz conforme | Medio | Deteccion y bloqueo con diagnostico en setup; requisito declarado en instalador y docs |
| Usuario local no privilegiado sondea el listener | Bajo | Control socket owner-only, estado owner-only y rechazo sin cookie emparejada; ver 13.1 |
| Puerto estable colisiona con rango efimero | Medio | Asignacion fuera del rango efimero y reintento de bind sin rotar identidad; ver 4.1 |
| Browser/host crash duplica un efecto | Critico | Durable intent, idempotency, event ACK y no replay ambiguo |
| Workspace path replacement | Alto | Host-owned picker, canonical/file identity y revalidation al uso |
| Permission label no coincide con lifetime real | Alto | Match por option ID/access kind; solo tres decisiones aprobadas en v1 |
| `grok agent serve` se usa como atajo | Alto | Prohibicion normativa y tests que produccion solo spawnea stdio |
| UI extraction rompe Desktop | Medio | Backend primero; extraction incremental con Desktop como primer consumer cuando aplique |
| Host no esta corriendo al abrir bookmark | Medio | User-service autostart, shortcut y `grok-light open` |
| Historial esperado en otra maquina | Medio | Copy local-only; no prometer sync; export futuro explicito |

---

## 15. Criterios de producto listo

- [ ] Installer Linux configura host local y autostart por usuario.
- [ ] Bookmark abre la SPA local tras login sin iniciar Grok hasta Work.
- [ ] Ni la SPA ni el host Light originan trafico saliente; la unica salvedad documentada es la resolucion del nombre del origen en browsers no conformes.
- [ ] Un browser fuera de la matriz conforme de 4.6 se detecta y se bloquea con diagnostico.
- [ ] El unico proceso de provider es el CLI configurado por el usuario.
- [ ] Executable Grok real pasa los gates de identidad, version y ACP.
- [ ] Browser nunca recibe credenciales de autenticacion, paths seleccionables ni ACP bruto.
- [ ] Una sola pestana puede mutar o decidir permisos.
- [ ] Workspace enrollment es host-owned y revalidado.
- [ ] Prompt/cancel/reconnect no duplica side effects.
- [ ] Resultado ambiguo queda `interrupted_needs_review`, con acknowledge explicito y sin reintento ofrecido.
- [ ] Permission UI ofrece unicamente `allow-once`, `reject-once` y `allow-edits-session` nativos.
- [ ] `always-allow`, `reject-always`, `allow-always-mcp`, `allow-always-domain`, yolo y Always cwd no aparecen en v1 Light.
- [ ] Contract tests fijan la resolucion a `ClientType::Generic` y la presencia de `allow-once`/`reject-once` por access kind.
- [ ] El hito de dogfood de Fase 5 tiene decision escrita antes de entrar en Fase 6.
- [ ] Preexisting CLI auto-approvals se comunican como configuracion del usuario.
- [ ] Sessions/history usan persistencia nativa del CLI cuando esta disponible.
- [ ] Threat model, protocol, setup y recovery docs estan instalados localmente.
- [ ] Linux real qualification y todos los gates relevantes estan verdes.
- [ ] Shared UI packages no introducen regresiones en Desktop.

---

## 16. Orden de PRs sugerido

1. `docs(light): ADRs, threat model, protocol draft and AGENTS scope`
2. `feat(light-host): Linux skeleton, instance lock, local origin and fake page`
3. `feat(light-host): pairing, cookie, CSRF and control lease`
4. `feat(light-protocol): commands, event ACK, journal and fake ACP child`
5. `feat(light-acp): qualified Grok stdio integration and contract fixtures`
6. `feat(light-host): workspace enrollment and Linux portal picker`
7. `test(light-host): recovery, adversarial loopback and bounds`
8. `feat(light): functional SPA against the proven host`
9. `refactor(ui): extract only shared tokens and primitives with real consumers`
10. `feat(light): complete Work presentation, docs and accessibility`
11. `ci(light): Linux packaging, signing evidence and clean-install qualification`
12. `docs(light): final local run, security and recovery guides`

---

## 17. Decisiones de release no bloqueantes para Fase 0

1. Nombre publico final: **Grok Light** u otro nombre de marketing.
2. Licencia y org de publicacion del host; por defecto debe alinearse con AGPL del monorepo.
3. Si se propone upstream un subcomando `grok light` o se mantiene un binario hermano.
4. Politica EN-only inicial o EN+ES; la arquitectura externaliza strings desde el inicio.
5. Matriz posterior de distros Linux y versiones concretas dentro de la matriz de motores ya fijada en 4.6.

No existe decision de hosting de SPA: el producto real siempre se sirve localmente.

La matriz de **motores** de browser no es una decision de release abierta: quedo fijada en 4.6
(Chromium y Firefox 84+ soportados, WebKit no soportado). Lo que queda abierto son versiones
minimas concretas y distros, no si Safari entra.

---

## 18. Checkpoint de autorizacion

El plan esta aprobado, pero **ninguna fase de implementacion esta autorizada por este documento**. El siguiente paso requiere una instruccion explicita del equipo para comenzar. La primera fase autorizable es Fase 0; no se inicia UI ni scaffolding de producto antes de ese permiso.
