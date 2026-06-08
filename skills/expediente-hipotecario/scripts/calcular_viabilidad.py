#!/usr/bin/env python3
"""
Calculadora de viabilidad hipotecaria — Tudesan

Uso:
  python calcular_viabilidad.py --capital 76000 --tasa 3 --años 30 \
         --ingresos 1600 --pagas 14 --deudas 0
"""
import argparse
import math

def calcular_cuota(principal, tasa_anual_pct, años):
    r = tasa_anual_pct / 100 / 12
    n = int(años * 12)
    if r == 0:
        return principal / n
    return principal * r * (1 + r)**n / ((1 + r)**n - 1)

def ingresos_12pagas(neto_mensual, num_pagas):
    return (neto_mensual * num_pagas) / 12

def ratio_endeudamiento(cuota, deudas, ingresos):
    if ingresos == 0:
        return 0
    return (cuota + deudas) / ingresos * 100

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--capital', type=float, required=True, help='Importe financiado (€)')
    p.add_argument('--tasa', type=float, default=3.0, help='Tipo de interés anual (%)')
    p.add_argument('--años', type=int, default=30, help='Plazo en años')
    p.add_argument('--ingresos', type=float, required=True, help='Ingresos netos mensuales')
    p.add_argument('--pagas', type=int, default=12, help='Número de pagas al año')
    p.add_argument('--deudas', type=float, default=0, help='Cuota mensual otras deudas (€)')
    args = p.parse_args()

    cuota = calcular_cuota(args.capital, args.tasa, args.años)
    ing_12 = ingresos_12pagas(args.ingresos, args.pagas)
    ratio = ratio_endeudamiento(cuota, args.deudas, ing_12)

    print(f"Cuota mensual:                € {cuota:,.2f}")
    print(f"Ingresos netos 12 pagas:      € {ing_12:,.2f}")
    print(f"Ratio de endeudamiento:       {ratio:.2f}%")
    print()
    if ratio < 25:
        print("✅ Ratio excelente (< 25%)")
    elif ratio < 30:
        print("✅ Ratio muy bueno (< 30%)")
    elif ratio < 35:
        print("✅ Ratio aceptable (< 35%)")
    else:
        print("⚠️  Ratio elevado (> 35%) — revisar operación")

if __name__ == '__main__':
    main()
