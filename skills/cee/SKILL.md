---
name: cee
description: "Usa esta skill para comprobar si la documentación de Certificado de Eficiencia Energética (CEE) de un cliente es suficiente para la tasación de una operación hipotecaria. Actívala siempre que el usuario mencione: comprobar CEE, revisar el certificado energético, informe de CEE, etiqueta energética, 'la tasadora pide el CEE', '¿es suficiente este certificado?', o cuando comparta un PDF de certificado energético y pregunte si vale o si falta algo. El documento puede venir como ruta local (PDF) o como adjunto de una operación del CRM (MCP 'tudesancrm-cloud'). La skill SOLO LEE: nunca escribe en el CRM."
---

# Skill: CEE — ¿Es suficiente para la tasación?

Comprueba si el/los documento(s) de Certificado de Eficiencia Energética que tiene Fernando para una operación bastan para lo que pide la tasadora (normalmente el **informe completo de CEE**), y si no, dice exactamente **qué falta y a quién pedírselo**.

## Conceptos clave — los 3 documentos del CEE

Del trabajo del técnico certificador salen tres documentos distintos y la gente los confunde:

1. **Informe completo de CEE** (lo que suele pedir la tasadora): documento de ~6+ páginas generado por el software homologado (CE3X, CE3D, CERMA, HULC, SG SAVE…). Contiene la página del certificado **+ Anexos I a IV**.
2. **Certificado resumen**: solo la(s) primera(s) página(s) con la calificación, sin anexos. A veces es lo único que el vendedor tiene a mano.
3. **Etiqueta energética**: hoja única con las flechas de colores A–G (consumo y emisiones). La emite el registro autonómico tras inscribir el certificado y lleva el **número de registro**. Sirve para publicidad y notaría, NO sustituye al informe.

## Paso 1 — Localizar el documento

- **Ruta local dada por Fernando** → leer el PDF directamente con `Read`.
- **Nombre de cliente/operación** → `list_operations` (q=nombre) para localizar la operación, `list_documents` (operationId) y buscar adjuntos tipo CEE (nombres con "CEE", "certificado", "eficiencia", "energétic", "etiqueta"). Leer con `read_document_file`. Si hay varias operaciones candidatas, preguntar con `AskUserQuestion`, no asumir.
- Si el MCP falla por sesión de Cloudflare Access caducada, pedir a Fernando que ejecute:
  `cloudflared access login https://tudesancrm-cloud.fernitudela.workers.dev` (sesión ~24 h) y reintentar.
- **Leer SIEMPRE el documento entero antes de opinar.** No juzgar por el nombre del archivo: un fichero llamado "certificado" puede ser el informe completo (caso real: Sergio Martín) y viceversa.

## Paso 2 — Checklist de suficiencia

Verificar contra el contenido leído (no contra el nombre del archivo):

### A. ¿Es el informe completo?
- [ ] Página del certificado: identificación del inmueble (dirección, **referencia catastral**, municipio, zona climática, año de construcción)
- [ ] Datos del técnico certificador (nombre, NIF, titulación habilitante, razón social) y software utilizado
- [ ] Calificación en las **dos escalas**: consumo de energía primaria no renovable (kWh/m²año) y emisiones (kgCO2/m²año), con letra y valor
- [ ] **Firma del técnico** (digital o manuscrita) y fecha
- [ ] **Anexo I** — descripción de características energéticas (envolvente térmica, instalaciones)
- [ ] **Anexo II** — calificación energética detallada
- [ ] **Anexo III** — recomendaciones de mejora
- [ ] **Anexo IV** — pruebas/comprobaciones y **fecha de visita** del técnico (obligatoria desde el RD 390/2021)

### B. Vigencia
- [ ] Fecha del certificado dentro de plazo: **10 años** de validez, **5 años si la calificación es G** (RD 390/2021). Convertir a fecha límite y comprobar contra hoy.

### C. Correspondencia con el inmueble
- [ ] La **dirección y/o referencia catastral coinciden** con el inmueble de la operación (contrastar con nota simple, contrato de arras o los datos del CRM). Si no coinciden → INSUFICIENTE aunque el informe esté completo.
- Avisar también de incoherencias menores (p. ej. campo "Nombre del edificio" con otra dirección, típico residuo de plantilla del técnico): no invalidan, pero conviene que el técnico lo corrija.

### D. Registro (no bloquea la tasación, sí la notaría)
- [ ] ¿Campo "Registro del Órgano Territorial Competente" cumplimentado, o etiqueta con nº de registro autonómico?
- Si NO está registrado: para la **tasación** el informe firmado suele bastar, pero para la **compraventa ante notario** se exige el certificado registrado → dejarlo anotado como pendiente y recomendar pedir al técnico el justificante de registro/etiqueta en cuanto lo tenga.

## Paso 3 — Veredicto

Entregar SIEMPRE en este formato:

1. **Veredicto en la primera línea**: ✅ SUFICIENTE / ❌ INSUFICIENTE (para lo que pide la tasadora).
2. Resumen de lo comprobado: qué documento(s) son, páginas/anexos presentes, técnico, fecha, calificación, inmueble.
3. **Qué falta y a quién pedírselo**, si aplica:
   - Solo etiqueta o resumen sin anexos → pedir el **informe completo al técnico certificador** (sus datos salen en el propio certificado) o al vendedor/inmobiliaria; también puede descargarse del registro autonómico con el nº de registro.
   - Sin registro → pedir al técnico el **justificante de registro/etiqueta** (pendiente para notaría, no bloquea tasación).
   - Caducado o de otro inmueble → hace falta un **CEE nuevo**.
4. Avisos menores (incoherencias cosméticas, campo de registro en blanco, etc.).

## Reglas

- Esta skill es **solo lectura**: no escribe nada en el CRM ni modifica archivos.
- Lo que no se ha leído no se afirma: el veredicto solo puede basarse en documentos abiertos de verdad.
- Si falta información para decidir (p. ej. no se sabe qué inmueble es), preguntar a Fernando en vez de suponer.
