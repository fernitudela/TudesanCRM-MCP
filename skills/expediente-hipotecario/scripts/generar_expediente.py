#!/usr/bin/env python3
"""
Generador de expedientes hipotecarios — Tudesan
Uso: python generar_expediente.py datos.json
     python generar_expediente.py --json '{"titulo": ...}'
"""

import sys
import json
import math
import argparse
from docx import Document
from docx.shared import Pt, RGBColor, Inches, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
import copy


# ── Utilidades de formato ────────────────────────────────────────────────────

def euros(valor):
    """Formatea un número como € 1,234.56"""
    if valor == 0 or valor is None:
        return "€ 0"
    return f"€ {valor:,.2f}"

def porcentaje(valor):
    """Formatea como 18.31%"""
    return f"{valor:.2f}%"


# ── Cálculo de viabilidad ────────────────────────────────────────────────────

def calcular_cuota(principal, tasa_anual_pct, años):
    r = tasa_anual_pct / 100 / 12
    n = int(años * 12)
    if r == 0:
        return principal / n
    return principal * r * (1 + r)**n / ((1 + r)**n - 1)

def calcular_ingresos_12pagas(neto_mensual, num_pagas):
    return (neto_mensual * num_pagas) / 12

def calcular_ratio(cuota, deudas, ingresos_12pagas):
    if ingresos_12pagas == 0:
        return 0
    return (cuota + deudas) / ingresos_12pagas * 100


# ── Helpers XML para estilos de párrafo ─────────────────────────────────────

def set_paragraph_border_bottom(paragraph, color="CCCCCC", size=6):
    """Añade línea horizontal debajo de un párrafo."""
    pPr = paragraph._p.get_or_add_pPr()
    pBdr = OxmlElement('w:pBdr')
    bottom = OxmlElement('w:bottom')
    bottom.set(qn('w:val'), 'single')
    bottom.set(qn('w:sz'), str(size))
    bottom.set(qn('w:space'), '1')
    bottom.set(qn('w:color'), color)
    pBdr.append(bottom)
    pPr.append(pBdr)


def shade_cell(cell, fill_hex):
    """Aplica color de fondo a una celda de tabla."""
    tc = cell._tc
    tcPr = tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), fill_hex)
    tcPr.append(shd)


def set_cell_borders(cell, color="CCCCCC"):
    """Pone bordes a una celda."""
    tc = cell._tc
    tcPr = tc.get_or_add_tcPr()
    tcBorders = OxmlElement('w:tcBorders')
    for side in ['top', 'left', 'bottom', 'right']:
        el = OxmlElement(f'w:{side}')
        el.set(qn('w:val'), 'single')
        el.set(qn('w:sz'), '4')
        el.set(qn('w:space'), '0')
        el.set(qn('w:color'), color)
        tcBorders.append(el)
    tcPr.append(tcBorders)


# ── Constructor principal del documento ─────────────────────────────────────

def generar_expediente(datos: dict) -> Document:
    doc = Document()

    # Márgenes A4 con márgenes normales
    for section in doc.sections:
        section.top_margin = Cm(2.5)
        section.bottom_margin = Cm(2.5)
        section.left_margin = Cm(2.5)
        section.right_margin = Cm(2.5)

    # Fuente por defecto
    style = doc.styles['Normal']
    style.font.name = 'Arial'
    style.font.size = Pt(11)

    viab = datos.get('viabilidad', {})
    titulo = datos.get('titulo', 'Hipoteca')
    destinatario = datos.get('destinatario', '')
    titulares = datos.get('titulares', [])

    # ── TÍTULO ───────────────────────────────────────────────────────────────
    h = doc.add_heading(titulo, level=1)
    h.runs[0].font.name = 'Arial'
    h.runs[0].font.size = Pt(20)
    h.runs[0].font.color.rgb = RGBColor(0, 0, 0)
    set_paragraph_border_bottom(h, color="BBBBBB", size=8)
    doc.add_paragraph()

    # ── INTRO DE LA OPERACIÓN ────────────────────────────────────────────────
    intro = datos.get('intro_operacion', '')
    if intro:
        for bloque in intro.split('\n\n'):
            bloque = bloque.strip()
            if bloque:
                for linea in bloque.split('\n'):
                    linea = linea.strip()
                    if linea:
                        p = doc.add_paragraph(linea)
                        p.runs[0].font.name = 'Arial'
                        p.runs[0].font.size = Pt(11)
                        p.paragraph_format.space_after = Pt(4)

    # ── TITULARES ────────────────────────────────────────────────────────────
    for i, titular in enumerate(titulares, start=1):
        label = "TITULAR:" if len(titulares) == 1 else f"TITULAR {i}:"
        p_label = doc.add_paragraph()
        run = p_label.add_run(label)
        run.bold = True
        run.font.name = 'Arial'
        run.font.size = Pt(11)
        p_label.paragraph_format.space_after = Pt(2)

        nombre = titular.get('nombre_completo', '')
        dni = titular.get('dni', '')
        dob = titular.get('fecha_nacimiento', '')
        edad = titular.get('edad', '')
        estado = titular.get('estado_civil', '')
        profesion = titular.get('profesion', '')

        # Fecha de nacimiento con edad entre paréntesis
        dob_str = ''
        if dob:
            if edad:
                dob_str = f"{dob} ({edad} años)"
            else:
                try:
                    from datetime import date as _date
                    partes = dob.replace('-', '/').split('/')
                    if len(partes) == 3:
                        if len(partes[0]) == 4:
                            yr, mo, dy = int(partes[0]), int(partes[1]), int(partes[2])
                        else:
                            dy, mo, yr = int(partes[0]), int(partes[1]), int(partes[2])
                        nacimiento = _date(yr, mo, dy)
                        hoy = _date.today()
                        anos = hoy.year - nacimiento.year - ((hoy.month, hoy.day) < (nacimiento.month, nacimiento.day))
                        dob_str = f"{dob} ({anos} años)"
                    else:
                        dob_str = dob
                except Exception:
                    dob_str = dob

        for linea in [nombre, dni, dob_str, estado, profesion]:
            if linea:
                p = doc.add_paragraph(linea)
                p.runs[0].font.name = 'Arial'
                p.runs[0].font.size = Pt(11)
                p.paragraph_format.space_after = Pt(2)
                p.paragraph_format.space_before = Pt(0)

        doc.add_paragraph()

    # ── SITUACIÓN ECONÓMICA ──────────────────────────────────────────────────
    p_se = doc.add_paragraph()
    run_se = p_se.add_run('SITUACIÓN ECONÓMICA ACTUAL:')
    run_se.bold = True
    run_se.font.name = 'Arial'
    run_se.font.size = Pt(11)
    p_se.paragraph_format.space_after = Pt(6)

    sit_eco = datos.get('situacion_economica', '')
    if sit_eco:
        for bloque in sit_eco.split('\n\n'):
            bloque = bloque.strip()
            if bloque:
                for linea in bloque.split('\n'):
                    linea = linea.strip()
                    if linea:
                        p = doc.add_paragraph(linea)
                        p.runs[0].font.name = 'Arial'
                        p.runs[0].font.size = Pt(11)
                        p.paragraph_format.space_after = Pt(6)

    doc.add_paragraph()

    # ── VIABILIDAD ───────────────────────────────────────────────────────────
    p_v = doc.add_paragraph()
    run_v = p_v.add_run('VIABILIDAD:')
    run_v.bold = True
    run_v.font.name = 'Arial'
    run_v.font.size = Pt(11)

    consideraciones = viab.get('consideraciones', '')
    if consideraciones:
        p_c = doc.add_paragraph()
        run_c = p_c.add_run(f'*Consideraciones: {consideraciones}')
        run_c.italic = True
        run_c.font.name = 'Arial'
        run_c.font.size = Pt(10)
        p_c.paragraph_format.space_after = Pt(6)

    # Calcular valores si no se proporcionan
    valor_inmueble = viab.get('valor_inmueble', 0)
    pct_financiacion = viab.get('porcentaje_financiacion', 80)
    importe_financiado = viab.get('importe_financiado') or valor_inmueble * pct_financiacion / 100
    interes = viab.get('interes', 3.0)
    plazo = viab.get('plazo_años', 30)
    cuota = viab.get('cuota') or calcular_cuota(importe_financiado, interes, plazo)
    ingresos_12 = viab.get('ingresos_netos_12pagas', 0)
    prestamos = viab.get('prestamos_deudas', 0) or 0
    ratio = viab.get('ratio_endeudamiento') or calcular_ratio(cuota, prestamos, ingresos_12)

    # Tabla de viabilidad
    filas = [
        ('normal',  'Valor Inmueble',                  euros(valor_inmueble)),
        ('normal',  'Porcentaje financiación',          f'{pct_financiacion}%'),
        ('grande',  'Importe financiado',               euros(importe_financiado)),
        ('normal',  'Interés',                          f'{interes:.2f}%'),
        ('normal',  'Plazo (años)',                     str(int(plazo))),
        ('cuota',   'Cuota',                            euros(round(cuota, 2))),
        ('normal',  'Ingresos netos mensuales 12 pagas', euros(ingresos_12) if ingresos_12 else ''),
        ('normal',  'Prestamos o deudas pendientes',   euros(prestamos) if prestamos else ''),
        ('ratio',   'Ratio de endeudamiento',           porcentaje(ratio)),
    ]

    table = doc.add_table(rows=0, cols=2)
    table.style = 'Table Grid'

    # Ancho de columnas (A4 con márgenes 2.5cm: ~16cm disponibles)
    col_widths = [Cm(9), Cm(7)]
    for i, col in enumerate(table.columns):
        for cell in col.cells:
            cell.width = col_widths[i]

    HEADER_FILL = "D6E4F0"   # azul grisáceo cabecera
    HIGHLIGHT_FILL = "F2F2F2"  # gris claro para filas importantes

    for tipo, dato, valor in filas:
        row = table.add_row()
        c_dato = row.cells[0]
        c_valor = row.cells[1]

        # Ajustar estilos según tipo de fila
        if tipo == 'cuota':
            # Cuota en grande y negrita
            shade_cell(c_dato, HIGHLIGHT_FILL)
            shade_cell(c_valor, HIGHLIGHT_FILL)
            p_d = c_dato.paragraphs[0]
            r = p_d.add_run(dato)
            r.bold = True; r.font.size = Pt(16); r.font.name = 'Arial'
            p_v2 = c_valor.paragraphs[0]
            r2 = p_v2.add_run(valor)
            r2.bold = True; r2.font.size = Pt(16); r2.font.name = 'Arial'

        elif tipo == 'grande':
            # Importe financiado en mediano negrita
            p_d = c_dato.paragraphs[0]
            r = p_d.add_run(dato)
            r.bold = True; r.font.size = Pt(13); r.font.name = 'Arial'
            p_v2 = c_valor.paragraphs[0]
            r2 = p_v2.add_run(valor)
            r2.bold = True; r2.font.size = Pt(13); r2.font.name = 'Arial'

        elif tipo == 'ratio':
            # Ratio de endeudamiento en grande negrita
            shade_cell(c_dato, HIGHLIGHT_FILL)
            shade_cell(c_valor, HIGHLIGHT_FILL)
            p_d = c_dato.paragraphs[0]
            r = p_d.add_run(dato)
            r.bold = True; r.font.size = Pt(14); r.font.name = 'Arial'
            p_v2 = c_valor.paragraphs[0]
            r2 = p_v2.add_run(valor)
            r2.bold = True; r2.font.size = Pt(14); r2.font.name = 'Arial'

        else:
            # Fila normal
            p_d = c_dato.paragraphs[0]
            r = p_d.add_run(dato)
            r.font.size = Pt(11); r.font.name = 'Arial'
            p_v2 = c_valor.paragraphs[0]
            r2 = p_v2.add_run(valor)
            r2.font.size = Pt(11); r2.font.name = 'Arial'

        set_cell_borders(c_dato)
        set_cell_borders(c_valor)

        # Padding de celdas
        for cell in [c_dato, c_valor]:
            tc = cell._tc
            tcPr = tc.get_or_add_tcPr()
            mar = OxmlElement('w:tcMar')
            for side in ['top', 'left', 'bottom', 'right']:
                m = OxmlElement(f'w:{side}')
                m.set(qn('w:w'), '120')
                m.set(qn('w:type'), 'dxa')
                mar.append(m)
            tcPr.append(mar)

    doc.add_paragraph()

    # ── FAVORABLE EN BASE A ──────────────────────────────────────────────────
    p_fab = doc.add_paragraph()
    run_fab = p_fab.add_run('FAVORABLE EN BASE A:')
    run_fab.bold = True
    run_fab.font.name = 'Arial'
    run_fab.font.size = Pt(11)
    p_fab.paragraph_format.space_after = Pt(4)

    favorable = datos.get('favorable_en_base_a', [])
    for punto in favorable:
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.left_indent = Pt(0)
        run = p.add_run(f'- {punto}')
        run.font.name = 'Arial'
        run.font.size = Pt(11)

    # Nota adicional (opcional)
    nota = datos.get('nota_adicional', '')
    if nota:
        doc.add_paragraph()
        p = doc.add_paragraph()
        run = p.add_run(nota)
        run.italic = True
        run.font.name = 'Arial'
        run.font.size = Pt(11)

    # ── CIERRE ───────────────────────────────────────────────────────────────
    # No se añade firma: el .docx se adjunta a un correo cuyo cliente ya pone
    # la firma de Fernando automáticamente. Evita firma duplicada.
    doc.add_paragraph()
    p_saludo = doc.add_paragraph('Un saludo, muchas gracias.')
    p_saludo.runs[0].font.name = 'Arial'
    p_saludo.runs[0].font.size = Pt(11)

    return doc


# ── Entry point ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Genera expediente hipotecario .docx')
    parser.add_argument('json_file', nargs='?', help='Archivo JSON con los datos')
    parser.add_argument('--json', help='JSON como string')
    args = parser.parse_args()

    if args.json:
        datos = json.loads(args.json)
    elif args.json_file:
        with open(args.json_file, encoding='utf-8') as f:
            datos = json.load(f)
    else:
        datos = json.load(sys.stdin)

    output_path = datos.get('output_path', 'expediente.docx')
    doc = generar_expediente(datos)
    doc.save(output_path)
    print(f"Expediente guardado en: {output_path}")


if __name__ == '__main__':
    main()
