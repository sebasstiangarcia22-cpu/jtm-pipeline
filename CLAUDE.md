# CLAUDE.md — Instrucciones permanentes para mantener este dashboard

## Propósito del repo y destinatarios

Dashboard ejecutivo del pipeline LATAM de JT Markets, publicado en GitHub Pages:
**https://sebasstiangarcia22-cpu.github.io/jtm-pipeline/**

Lo revisan **Nishil Patel (Regional Director)** y otros stakeholders externos. Todo lo que se publique aquí es público — ver sección de seguridad más abajo.

---

## Estructura del HTML (`index.html`)

El archivo es un HTML monolítico con CSS inline, 4 tabs navegables y un bloque `<script>` al final.

### KPI Bar (`.kpi-bar`)
5 valores hardcodeados en la parte superior: **Total Deposited**, **May So Far**, **Total FTDs**, **May Target**, **Pipeline Potential**. Se actualizan manualmente — no se calculan desde el array.

### Las 4 tabs
| ID del panel | Tab visible | Contenido |
|---|---|---|
| `tab-deposits` | Deposits | Month Cards + Stats row + Ranking dinámico + Tabla completa |
| `tab-ib` | IB Funnel | Tabla de 12+ IBs con status y notas expandibles |
| `tab-bdm` | BDM Pipeline | Tabla de hiring pipeline + tabla de equipo activo |
| `tab-asm` | Account Sales Manager — Cristian | Tabla de clientes directos de Cristian |

### Month Cards (`.month-grid`)
Divs **hardcodeados** (no se generan desde el array `DEPOSITS`). Cada tarjeta tiene:
- `.mc-label` — nombre del mes (ej. "May 2026 🔄")
- `.mc-amount` — total en USD del mes
- `.mc-meta` — cantidad de depósitos
- `.mc-ftd` — cantidad de FTDs del mes

Variantes de estilo: `active-month` (borde naranja, mes en curso), `best-month` (borde verde, mejor mes), `future` (borde punteado, sin datos).

### Array `DEPOSITS`
Ubicado al final del `<script>`. Array de objetos en **orden cronológico inverso** (el más reciente primero, `n` más alto arriba). Campos de cada objeto:

```js
{
  n:      número secuencial (el más nuevo tiene el n más alto),
  date:   'Mmm DD'           // ej. 'May 13'
  month:  'May'              // ej. 'May', 'Apr', 'Mar', 'Feb'
  year:   2026,
  asm:    'Sebastian Garcia' // ver tabla de comerciales abajo
  client: 'Nombre del cliente',
  ftd:    true | false,      // true = primer depósito del cliente
  source: 'IB Direct' | 'IB Referral' | 'Meta Funnel' | 'Direct',
  country:'Colombia',        // país del cliente
  amount: 500.00             // número, sin símbolo $
}
```

### Tablas con notas expandibles
En IB Funnel, BDM Pipeline y ASM Cristian, cada fila de datos tiene:
- Un botón `›` (`.notes-toggle`) en la última columna
- La fila siguiente `<tr class="notes-row">` contiene `<div class="notes-content">` con el historial de notas
- `toggleNote()` muestra/oculta la fila al hacer clic

### Colores de badges y dots
| Color | Badge | Dot | Uso |
|---|---|---|---|
| Rojo | `b-red` | `dot-red` | HOT, Closing |
| Naranja | `b-orange` | `dot-orange` | Active, Negotiating, Re-engaging, Call scheduled, Meeting sched. |
| Verde | `b-green` | `dot-green` | Generating, Active (funded), Deposited |
| Azul | `b-blue` | `dot-blue` | Funded con monto específico |
| Amarillo | `b-yellow` | `dot-yellow` | Proposal pending, Counteroffer sent |
| Gris | `b-gray` | `dot-gray` | Lost, Former |
| Morado | `b-purple` | _(no existe dot-purple)_ | Badge de owner Nishil |

---

## Cómo agregar un depósito nuevo

### 1. Agregar al array `DEPOSITS`

Insertar el nuevo objeto **al inicio del array** (antes del elemento actual `n:26`), incrementando `n` en 1.

```js
const DEPOSITS = [
  {n:27, date:'May 15', month:'May', year:2026, asm:'Cristian Llanos', client:'Nuevo Cliente', ftd:true, source:'Meta Funnel', country:'Colombia', amount:300.00},
  {n:26, date:'May 13', ...},
  ...
```

**Reglas de cada campo:**
- `date`: formato `'Mmm DD'` sin cero inicial (ej. `'May 5'`, no `'May 05'`)
- `month`: nombre corto en inglés con mayúscula inicial: `'Feb'`, `'Mar'`, `'Apr'`, `'May'`, etc.
- `asm`: usar exactamente los nombres de la tabla de comerciales (ver abajo)
- `ftd`: buscar el nombre del cliente en todo el array; si **no aparece antes**, es `true`; si ya existe, es `false`
- `source`: solo los 4 valores válidos: `'IB Direct'`, `'IB Referral'`, `'Meta Funnel'`, `'Direct'`
- `amount`: número con decimales, sin símbolo (ej. `1250.00`)

### 2. Actualizar la Month Card correspondiente

Localizar el `.month-card` del mes en el bloque `<!-- Month Cards -->` y actualizar:
- `.mc-amount` — sumar el nuevo depósito al total del mes
- `.mc-meta` — incrementar el conteo de depósitos
- `.mc-ftd` — incrementar si `ftd: true`

### 3. Actualizar los KPIs superiores

En `.kpi-bar`, actualizar manualmente cuando aplique:
- **Total Deposited** — siempre sumar el nuevo monto
- **May So Far** — solo si el depósito es del mes en curso
- **Total FTDs** — solo si `ftd: true`

### 4. Actualizar notas del cliente en IB Funnel / ASM / BDM

**REGLA OBLIGATORIA**: Siempre que se registre un depósito, buscar al cliente en las tablas con notas expandibles (IB Funnel Active IBs, ASM Cristian, BDM Active) y agregar una entrada al inicio de su `<div class="notes-content">` con este formato:

```html
<strong>YYYY-MM-DD</strong> — Deposit: $X,XXX.XX (IB Direct / IB Referral / Meta Funnel / Direct). [Nota adicional si aplica]
```

Si el cliente aparece como IB, también actualizar el campo "Direct Clients" (portfolio acumulado) si el monto acumulado cambió significativamente.

---

## Cómo actualizar notas en IB Funnel / BDM Pipeline / ASM Cristian

### REGLA CRÍTICA: NUNCA reemplazar notas existentes

Siempre agregar una entrada **nueva al inicio** del bloque `<div class="notes-content">`, separada de la entrada anterior con `<br><br>`.

**Formato exacto de cada entrada:**
```html
<strong>YYYY-MM-DD</strong> — texto de la nota
```

**Ejemplo de nota con dos entradas (más reciente arriba):**
```html
<div class="notes-content">
  <strong>2026-05-20</strong> — Confirmó reunión para el jueves. Muy interesado.<br><br>
  <strong>2026-05-14</strong> — Primer contacto. Solicitó información sobre condiciones IB.
</div>
```

### Si el status cambia

También actualizar el dot y el badge en la `<tr>` principal de esa fila usando el mapeo de la tabla de colores de arriba.

---

## Tabla de comerciales conocidos

| Nombre exacto en el array | Rol |
|---|---|
| `Sebastian Garcia` | GM LATAM |
| `Cristian Llanos` | ASM activo |
| `Augusto Mejia` | Former |
| `David Zapata` | Former |
| `Pulse Operations` | IB |

---

## IBs activos conocidos

No inventar nombres. La lista actual de IBs en el funnel:

Álvaro Cuartas, Sergio Monroy, Dionisio Sifontes, Alexis Aguilar, Dan, Christian Farfan, Mariano (Trading Emergente), Keylin Masis, Carol Rodriguez, Ashley Hurtado, Leonardo Guaran, Mario Andino, Mishelle Gómez, Mario Alvino, Marcelo Padovani.

---

## Regla crítica de seguridad

Este repositorio es **público**. Está estrictamente prohibido escribir en cualquier archivo del repo (HTML, commits, CLAUDE.md, ni ningún otro):

- Información interna de DOO (Desk Over Offering) de otros brokers
- Montos exactos de comisiones internas de JT Markets
- Spreads internos no públicos
- Datos personales de clientes más allá del nombre y país

Si una actualización requiere incluir información de este tipo, solicitar al usuario que la reformule antes de escribirla.

---

## Formato de commits (semánticos, en inglés)

```
deposit: <client> $<amount> - <source> - <YYYY-MM-DD>
funnel: update <prospect> → <new status>
bdm: <prospect> moved to <status>
asm: update Cristian client <name>
eod: end-of-day funnel update <YYYY-MM-DD>
```

---

## Flujo esperado de cada interacción

1. Leer el HTML **solo en las secciones relevantes** (no el archivo entero si no hace falta)
2. Hacer los cambios mínimos necesarios
3. Mostrar un **diff resumido** al usuario (no el archivo completo)
4. **Esperar confirmación** antes de hacer commit
5. Ejecutar: `git add . && git commit -m "..." && git push`
6. Confirmar al usuario que el dashboard ya está actualizado y dar el link:
   **https://sebasstiangarcia22-cpu.github.io/jtm-pipeline/**

---

## Idioma

- Hablar siempre **en español** con el usuario
- Commits y comentarios en código: **en inglés**

---

## Idioma del contenido del dashboard

Todo el contenido visible del dashboard (notas en expandibles, status badges, next action, KPI labels, headers de tablas) va **siempre en inglés**, porque el destinatario principal (Nishil Patel) trabaja en inglés y lee el dashboard directamente.

**Regla**: Cuando agregues o modifiques cualquier texto que termine renderizado en el HTML, escríbelo directamente en inglés, **sin pedir confirmación**. El usuario (Sebastián) te hablará en español en el chat — eso es solo el canal de comunicación, no refleja el idioma del dashboard.

**Excepciones**: Solo los nombres propios van en su forma original:
- Nombres de clientes (ej. "Armando Castro", "Javier Lemus")
- Nombres de IBs (ej. "Álvaro Cuartas", "Sergio Monroy")
- Ciudades y países (ej. "Bogotá", "Colombia", "Bolivia")
