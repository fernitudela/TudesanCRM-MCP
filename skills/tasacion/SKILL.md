---
name: tasacion
description: "Usa esta skill para redactar el correo de solicitud de tasación de una operación hipotecaria. Actívala siempre que el usuario mencione: pedir tasación, solicitar tasación, correo para tasar, email a la tasadora, 'necesito tasar la operación de [cliente]', o similar. Localiza la operación en el CRM (MCP 'tudesancrm-cloud'), reúne los datos y adjuntos necesarios (cliente+DNI, inmueble, banco, importe mínimo, referencia catastral, contacto para la visita) y genera el correo listo para copiar/enviar, avisando de qué adjuntos hay que anexar y cuáles faltan. Solo lectura en el CRM; pregunta lo que no pueda verificar."
---

# Skill: Correo de solicitud de tasación

Redacta el correo con el que Fernando (broker de TUDESAN) solicita una tasación a la tasadora, a partir de una operación del CRM. El correo debe salir **completo a la primera**: con todos los datos que la tasadora necesita y la lista de adjuntos que Fernando debe anexar al enviarlo.

## Paso 1 — Localizar la operación y los datos

Acceso vía MCP `tudesancrm-cloud` (**solo lectura**; si falla por sesión Cloudflare Access caducada, pedir a Fernando: `cloudflared access login https://tudesancrm-cloud.fernitudela.workers.dev` y reintentar):

- `list_operations` (q=nombre del cliente) → si hay varias candidatas, `AskUserQuestion`, no asumir.
- `get_operation` → dirección del inmueble, valor de compraventa, banco(s), notas.
- `list_clients` (operationId) → titulares y DNI.
- `list_operation_banks` → a qué banco va la operación (si hay varios, preguntar para cuál se tasa).
- `list_documents` (operationId) → qué adjuntos existen: DNI, nota(s) simple(s) de vivienda y garaje, informe CEE, IBI, arras…
- `list_inmuebles` si aporta detalle del inmueble (garaje, trastero, anejo).

Contraste de datos: los datos que van al correo deben salir de los adjuntos o del CRM contrastado. La **referencia catastral** se saca de la nota simple, el IBI o el CEE (leyéndolos con `read_document_file` si hace falta). El DNI del titular, del adjunto DNI si está disponible.

## Paso 2 — Checklist de datos del correo

Obligatorios. **Regla de oro: ante la duda, se pregunta.** Si un dato falta O es ambiguo O el CRM da un valor que no es inequívoco (p. ej. varios bancos en la operación, o no está claro si el importe mínimo es el valor de compraventa), preguntar a Fernando con `AskUserQuestion` — él facilitará el dato. Agrupar todas las preguntas en una sola llamada, ofreciendo como opciones los valores candidatos encontrados en el CRM (con "Other" siempre disponible para que escriba otro):

- [ ] **Titular principal**: nombre completo + DNI/NIE. ⚠️ En el correo va **SOLO el titular principal, nunca todos los titulares**: la tasación y su factura tienen que ir a un único nombre. Si la operación tiene varios titulares y no está claro cuál es el principal, preguntar a Fernando — no elegir por cuenta propia.
- [ ] **Inmueble**: dirección completa con municipio y CP
- [ ] **Garaje / trastero / ascensor**: indicar SIEMPRE si tiene o no tiene (aunque sea "sin garaje ni trastero"); si tiene garaje como finca independiente, se necesita también su nota simple
- [ ] **Banco** para el que se tasa — si la operación tiene varios bancos o ninguno claro, preguntar SIEMPRE
- [ ] **Importe mínimo de valoración** (valor necesario): en la mayoría de los casos es **el valor cuyo 80% da el préstamo que se necesita** → `importe mínimo = préstamo necesario ÷ 0,80`, donde préstamo necesario = valor de compraventa × % de financiación solicitada (datos del CRM: `valorCompraventa`, `financiacionPctSolicitada`). Por eso suele salir POR ENCIMA del valor de compraventa (solo coincide con él cuando se financia exactamente el 80%). Calcular ese candidato y preguntar SIEMPRE a Fernando con `AskUserQuestion` proponiendo como opciones: (a) el importe calculado con la fórmula, (b) el valor de compraventa — salvo que él ya lo haya dicho en la conversación. NUNCA asumirlo en silencio
- [ ] **Contacto para la visita** (inmobiliaria o cliente): nombre + teléfono (+ email si se tiene)

Recomendables:

- [ ] **Referencia catastral**
- [ ] Enlace a **visita virtual** (Matterport, tour del portal…) si existe — ayuda al tasador
- [ ] Cualquier particularidad útil (inquilinos, obras, acceso, urgencia)

## Paso 3 — Adjuntos

Listar en el correo los adjuntos que Fernando debe anexar, y comprobar contra `list_documents` que existen:

- DNI del titular principal (solo el suyo)
- Nota simple de la vivienda (y del garaje si es finca independiente)
- **Informe completo de CEE** — si hay dudas de si el documento CEE disponible es suficiente, aplicar los criterios de la skill `cee` (informe completo = certificado + Anexos I–IV firmado; la etiqueta sola NO basta)

Si algún adjunto no existe en el CRM ni lo tiene Fernando → avisar claramente ANTES del correo: "Falta X, pídelo a Y antes de enviar" (no bloquear el borrador: entregarlo igualmente marcando el hueco).

## Paso 4 — Redactar el correo

Tono: cercano y directo, como escribe Fernando. **Formato validado por Fernando (07/09/2026) — seguirlo tal cual**, en este orden: banco → inmueble (dirección, características, ref. catastral) → valor → comprador → contacto → adjuntos:

```
Buenos días,

Solicitamos tasación para el banco [BANCO],
sobre vivienda en [DIRECCIÓN COMPLETA], [CP] [MUNICIPIO] ([PROVINCIA]).
Vivienda [con/sin] garaje y trastero ([anejos/fincas independientes]) y [con/sin] ascensor.
Referencia catastral: [REF]

Valor mínimo necesario: [XXX.XXX €]

Comprador e interesado:
[NOMBRE COMPLETO DEL TITULAR PRINCIPAL] - [DNI]

Contacto para la visita:
[Nombre]
[Teléfono]
[Email]

Adjunto DNI, nota simple e informe completo de CEE.

[P.D.: enlace a visita virtual si existe]

¡Muchas gracias!
```

Detalles del formato:

- El banco va en la primera frase, SOLO el banco — el cliente NO va ahí: va después, en su propio bloque "Comprador e interesado:" con nombre completo y DNI en línea aparte.
- El bloque del inmueble va junto: dirección ("sobre vivienda en…"), línea de garaje/trastero/ascensor y referencia catastral, sin líneas en blanco entre ellas.
- La etiqueta del importe es "Valor mínimo necesario:" (no "importe mínimo de valoración").
- Ajustar la línea de adjuntos a lo que realmente se adjunta (p. ej. "notas simples de vivienda y garaje" si son fincas independientes).

Reglas de redacción:

- Todos los importes en formato español (189.900 €).
- No dejar placeholders sin resolver en el correo final: o el dato está, o se ha preguntado, o se marca explícitamente como pendiente ANTES del correo (nunca dentro).
- Solo el **titular principal** con su DNI, aunque la operación tenga más titulares (la tasación y la factura van a un único nombre).

## Paso 5 — Entrega

1. Correo completo en el chat, listo para copiar y pegar.
2. Debajo, **lista de adjuntos a anexar** (con el nombre del archivo tal como está en el CRM, para localizarlos rápido) y avisos de lo que falte.
3. **NUNCA crear borradores ni enviar por Gmail**: Fernando no usa Gmail para su actividad profesional de broker. La entrega es siempre el texto en el chat, listo para copiar; él lo envía desde su correo profesional. No ofrecer Gmail como opción.

## Reglas

- **Solo lectura** en el CRM: esta skill no escribe ni modifica nada.
- Datos dudosos o ausentes → se preguntan, no se inventan (especialmente importe mínimo, banco y contacto de visita).
- El correo nunca sale con datos que contradigan un adjunto leído; si adjunto y CRM discrepan, manda el adjunto y se avisa a Fernando.
