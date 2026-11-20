// ── dashboard/yard-lang.js — English / Spanish switch for the YARD screens ──
//
// Apsara, 2026-11-19: "Some of the customers are in spanish. Can i switch the language in app per customer basis..
// add a toggle in app at the top right". Asked the scope, she answered "yard only and website" — the Edge Metals
// freight side is an optional add-on module and stays English; the phone app is not part of this.
//
// HOW IT WORKS, AND WHY THIS SHAPE
// The yard screens are ~16,000 lines of template strings with the English written straight in. Rewriting every
// one of them to call a translate function would touch every yard screen at once — exactly the kind of wide,
// behaviour-changing edit CLAUDE.md rule 1 warns about. So this file translates what is ON THE SCREEN instead:
// text, placeholders, titles and dropdown labels are looked up in the table below and swapped in place, and put
// back when the person switches to English or leaves the yard screens.
//
//   * ENGLISH IS THE DEFAULT AND IS UNTOUCHED. With the switch on EN (the starting state for everyone) this file
//     changes nothing on the page: no node is rewritten, no dialog is wrapped differently.
//   * ONLY THE YARD TABS (and the sign-in screen). Freight tabs are never translated, even with ES chosen.
//   * NOTHING SENT TO THE SERVER CHANGES. Typed values are never touched. A dropdown option with no value=""
//     takes its value FROM its label, so before an option's label is translated its English label is pinned as
//     its value — the form keeps posting "Cash", never "Efectivo". (CLAUDE.md, 2026-09-16: a <select> whose value
//     drifts silently posts "" and the save fails.)
//   * The choice is per browser (localStorage), so each person at a customer picks their own language.
//   * A string missing from the table simply stays English. tests/yard-spanish.js lists the screens' main labels
//     and fails if one of them has no Spanish, so new yard wording does not slip through untranslated for long.
//
// The Spanish is Claude's; it has not yet been checked by a Spanish speaker in the trade (Apsara knows this).
(function () {
  'use strict';
  var KEY = 'yard_ui_lang';
  var YARD_TABS = { loads: 1, inventory: 1, petty: 1, 'trucker-bills': 1, expenses: 1, contacts: 1, spend: 1 };

  var ES = {
    // sign-in and menu
    'Sign in': 'Iniciar sesión', 'SIGN IN': 'INICIAR SESIÓN', 'Internal access only.': 'Solo acceso interno.',
    'PASSWORD': 'CONTRASEÑA', 'Password': 'Contraseña',
    'Loads': 'Cargas', 'Inventory': 'Inventario', 'Petty Cash': 'Caja chica', 'Trucker Bills': 'Facturas de transportistas',
    'Expenses': 'Gastos', 'Price Lists': 'Listas de precios', 'Both companies': 'Ambas empresas', 'Spend Report': 'Reporte de gastos',
    'Design': 'Diseño', 'Bot & Automation': 'Bot y automatización', 'Contacts & Outreach': 'Contactos y difusión', 'System': 'Sistema',
    'Settings': 'Configuración', 'Admin access': 'Acceso de administrador', 'Staff access': 'Acceso de personal',
    'Sign out': 'Cerrar sesión', 'Collapse the menu': 'Contraer el menú', 'Notifications': 'Notificaciones',
    'Checking…': 'Revisando…',

    // loads list
    'Camera or upload gross/tare weight, computed net, generated PDF ticket.': 'Foto o archivo del peso bruto y la tara, neto calculado y boleta en PDF.',
    'loads': 'cargas', 'net weight': 'peso neto', 'bought': 'comprado', 'sold': 'vendido',
    '+ Load': '+ Carga', '+ Sale': '+ Venta', 'All': 'Todo', 'Purchases': 'Compras', 'Sales': 'Ventas',
    'purchases': 'compras', 'paid': 'pagado',
    'Filter by item detail': 'Filtrar por detalle del material', 'Search by date, seller, item, price…': 'Buscar por fecha, vendedor, material, precio…',
    'All months': 'Todos los meses', 'SALE': 'VENTA', 'Open': 'ABIERTA', 'PDF ready': 'PDF listo', '1 item': '1 material', '1 load': '1 carga',
    'Generate PDF': 'Generar PDF', 'Edit': 'Editar', 'Delete': 'Eliminar', 'Pay': 'Pagar', 'Receive payment': 'Recibir pago',
    'Send to seller (WhatsApp)': 'Enviar al vendedor (WhatsApp)', 'Sign': 'Firmar', 'Continue': 'Continuar',
    'Unfinished — not saved as loads yet': 'Sin terminar — aún no guardadas como cargas',
    'Generating…': 'Generando…', 'Deleting…': 'Eliminando…', 'Saving…': 'Guardando…', 'Saving draft…': 'Guardando borrador…',

    // load / sale form
    'New load': 'Nueva carga', 'New sale': 'Nueva venta', 'Date': 'Fecha', 'Buyer (our company)': 'Comprador (nuestra empresa)',
    'Seller (our company)': 'Vendedor (nuestra empresa)', 'Seller': 'Vendedor', 'Seller address': 'Dirección del vendedor',
    'Seller phone (optional)': 'Teléfono del vendedor (opcional)', 'Buyer': 'Comprador', 'Buyer address': 'Dirección del comprador',
    'Item detail': 'Detalle del material', 'Description': 'Descripción', 'Gross': 'Bruto', 'Tare': 'Tara', 'Net': 'Neto',
    'Price': 'Precio', 'Amount': 'Monto', '+ Add item': '+ Agregar material', 'Trucking': 'Transporte',
    'Hauled by (optional)': 'Transportado por (opcional)', 'Deduct from seller ($)': 'Descontar al vendedor ($)',
    'Charge to buyer ($)': 'Cobrar al comprador ($)', 'Note (optional)': 'Nota (opcional)',
    'Also record this as a Trucker Bill': 'Registrar también como factura de transportista',
    'Tick when an outside hauler is owed. Leave clear if you collected it yourself — a bill would be a payable to nobody.':
      'Márquelo si se le debe a un transportista externo. Déjelo sin marcar si usted mismo lo recogió — la factura sería una deuda con nadie.',
    'Autosaves as soon as you enter an item': 'Se guarda solo en cuanto escribe un material',
    'Cancel': 'Cancelar', 'Save load': 'Guardar carga', 'Record sale': 'Registrar venta', 'Save changes': 'Guardar cambios',
    'Open the calendar': 'Abrir el calendario', 'Type description…': 'Escriba la descripción…',
    'Add gross weight photo': 'Agregar foto del peso bruto', 'Add tare weight photo': 'Agregar foto de la tara',
    'Net weight': 'Peso neto', 'Insert a blank item below': 'Insertar un renglón vacío abajo',
    'Duplicate this item below': 'Duplicar este renglón abajo', 'Remove item': 'Quitar renglón',
    '/net ton': '/ton neta', '/gross ton': '/ton bruta', '/piece': '/pieza', 'needs gross': 'falta el bruto',
    'Net is gross minus tare. Waiting on: gross.': 'El neto es el bruto menos la tara. Falta: el bruto.',
    'Seller name': 'Nombre del vendedor', 'Buyer name': 'Nombre del comprador',
    'e.g. 456 Scrap Ave, Dallas, TX': 'p. ej. 456 Scrap Ave, Dallas, TX',
    'type the full number with country code, e.g. 15550100100': 'escriba el número completo con código de país, p. ej. 15550100100',
    'who collected it': 'quién la recogió', 'e.g. collected from his shop': 'p. ej. recogida en su taller',
    'Start typing an item — e.g. sealed': 'Empiece a escribir un material — p. ej. sealed',
    'Ferrous': 'Ferroso', 'Non-ferrous': 'No ferroso', 'Choose…': 'Elegir…',
    'Ferrous or non-ferrous? Tap to choose': '¿Ferroso o no ferroso? Toque para elegir',
    'Ferrous is iron and steel (a magnet sticks). Non-ferrous is copper, aluminium, brass, stainless and the like.':
      'Ferroso es hierro y acero (se pega un imán). No ferroso es cobre, aluminio, latón, acero inoxidable y similares.',
    'Include the Summary section (totals + item-type breakdown) on this PDF?': '¿Incluir la sección de resumen (totales y desglose por material) en este PDF?',
    'Yes': 'Sí', 'No': 'No', 'OK': 'Aceptar', 'Close': 'Cerrar',
    'Checking photo…': 'Revisando foto…', 'Preparing photo…': 'Preparando foto…', 'Reading scale…': 'Leyendo la báscula…', 'Preparing…': 'Preparando…',

    // pay / receive
    'Record payment': 'Registrar pago', 'Payment mode': 'Forma de pago', 'Bank': 'Banco', 'Reference (optional)': 'Referencia (opcional)',
    'Payment via': 'Pagado por', 'Which bank': 'Qué banco', 'Which account': 'Qué cuenta', 'Settle it': 'Compensar',
    'Apply to this load': 'Aplicar a esta carga', 'This settles the load in full.': 'Esto liquida la carga por completo.',
    'This moves no cash.': 'Esto no mueve efectivo.', 'Cash': 'Efectivo', 'Wire': 'Transferencia (wire)', 'Cheque': 'Cheque',
    'Bank transfer': 'Transferencia bancaria', 'Others': 'Otros', 'Unassigned': 'Sin asignar', 'Card': 'Tarjeta', 'Other': 'Otro',
    'cheque no. / txn id': 'n.º de cheque / id de transacción', 'e.g. Wells Fargo': 'p. ej. Wells Fargo',
    'Payments made': 'Pagos hechos', 'Payments received': 'Pagos recibidos', 'Recording…': 'Registrando…', 'Settling…': 'Compensando…',
    'Applying…': 'Aplicando…', 'Pick what to settle this against.': 'Elija contra qué compensar.',
    'How much of it should be settled?': '¿Cuánto se debe compensar?', 'Enter an amount greater than zero.': 'Escriba un monto mayor que cero.',
    'That is not an amount.': 'Eso no es un monto.', 'Nothing was recorded.': 'No se registró nada.',
    'How much of the credit should go on this load?': '¿Cuánto del crédito se aplica a esta carga?',
    'That supplier is not holding any prepayment now.': 'Ese proveedor no tiene ningún anticipo ahora.',
    'A prepayment is money paid OUT to a supplier, so it does not apply to a sale.': 'Un anticipo es dinero pagado a un proveedor, así que no aplica a una venta.',
    'Checking the other side…': 'Revisando el otro lado…',
    'Generate the PDF first.': 'Primero genere el PDF.',
    'No phone number on file for this seller. Click Edit to add one first.': 'Este vendedor no tiene teléfono guardado. Haga clic en Editar para agregarlo.',

    // inventory
    'Computed live from every current load — deleting a load removes its material.': 'Calculado en vivo de todas las cargas actuales — al eliminar una carga se quita su material.',
    'item types': 'tipos de material', 'on hand': 'en existencia', 'live from loads': 'en vivo de las cargas',
    'From': 'Desde', 'To': 'Hasta', 'Apply': 'Aplicar', 'Clear': 'Borrar', 'By item type': 'Por material', 'Per day': 'Por día',
    'Per seller': 'Por vendedor', 'Item type': 'Material', 'Items': 'Renglones', 'Net in': 'Neto entrado', 'Shipped': 'Enviado',
    'On hand': 'En existencia', 'Export': 'Exportar', 'Net total': 'Neto total', 'Amount total': 'Monto total', 'Load tickets': 'Boletas de carga',
    'How many separate loads carried this item': 'Cuántas cargas distintas trajeron este material',
    'How many weighed lines, across all those loads': 'Cuántos renglones pesados, en todas esas cargas', 'Loads ': 'Cargas ',

    // petty cash
    'Petty cash': 'Caja chica', 'Cash paid against a load comes out of this balance.': 'El efectivo pagado por una carga sale de este saldo.',
    'cash in hand': 'efectivo en caja', '+ Add cash': '+ Agregar efectivo', 'Borrowing': 'Préstamos',
    'Cash payments are refused while this is empty. Add cash before paying a load in cash.': 'No se aceptan pagos en efectivo mientras esté vacía. Agregue efectivo antes de pagar una carga en efectivo.',
    'Nothing recorded yet.': 'Todavía no hay nada registrado.', 'Outstanding': 'Pendiente', 'Nothing owed between accounts.': 'Nadie se debe nada entre cuentas.',
    'Every movement': 'Todos los movimientos', 'Move cash between accounts': 'Mover efectivo entre cuentas',
    'No cash has moved between accounts yet.': 'Todavía no se ha movido efectivo entre cuentas.',
    'How much cash is going into the box?': '¿Cuánto efectivo entra a la caja?',
    'Delete this cash entry? The balance will drop by that amount.': '¿Eliminar este movimiento de efectivo? El saldo bajará por ese monto.',

    // trucker bills
    'Trucker bills': 'Facturas de transportistas', 'What the yard owes its hauliers, and what has been paid against each.': 'Lo que el patio debe a sus transportistas y lo que se ha pagado de cada una.',
    'billed': 'facturado', 'outstanding': 'pendiente', '+ Add bill': '+ Agregar factura', 'Company': 'Empresa', 'Ticket': 'Boleta',
    'Status': 'Estado', 'Actions': 'Acciones', 'No trucker bills yet.': 'Todavía no hay facturas de transportistas.',
    'Add trucker bill': 'Agregar factura de transportista', 'Amount ($)': 'Monto ($)', 'Load ticket (optional)': 'Boleta de carga (opcional)',
    'Save bill': 'Guardar factura', 'e.g. Ace Haulage': 'p. ej. Ace Haulage',

    // expenses
    'Admin only. Syncs to the Expenses Google Sheet automatically.': 'Solo administradores. Se sincroniza solo con la hoja de Gastos de Google.',
    'all-time': 'desde siempre', 'today': 'hoy', 'entries': 'registros', 'admin only': 'solo administradores', 'syncs to sheet': 'se sincroniza con la hoja',
    '+ Add expense': '+ Agregar gasto', 'No expenses recorded yet.': 'Todavía no hay gastos registrados.', 'Add expense': 'Agregar gasto',
    'Category': 'Categoría', 'Vendor (optional)': 'Proveedor (opcional)', 'Paid by': 'Pagado con', 'Save expense': 'Guardar gasto',
    'e.g. Diesel for the loader': 'p. ej. Diésel para el cargador', 'e.g. Shell': 'p. ej. Shell',
    'Fuel': 'Combustible', 'Freight': 'Flete', 'Equipment': 'Equipo', 'Repairs & maintenance': 'Reparaciones y mantenimiento',
    'Labour': 'Mano de obra', 'Rent': 'Renta', 'Utilities': 'Servicios', 'Supplies': 'Suministros', 'Permits & fees': 'Permisos y cuotas',
    'Insurance': 'Seguro', '— not recorded —': '— sin registrar —',

    // price lists
    'Price lists': 'Listas de precios', '+ Add group': '+ Agregar grupo', '+ Add contact': '+ Agregar contacto',
    'No saved contacts yet.': 'Todavía no hay contactos guardados.', 'Defaults to the group\'s own name': 'Si se deja vacío, usa el nombre del grupo',
    'Add a WhatsApp group': 'Agregar un grupo de WhatsApp', 'Find group by name': 'Buscar grupo por nombre', 'Search': 'Buscar',
    'Save as (display name)': 'Guardar como (nombre a mostrar)', 'Standing — also auto-notify this group when a price changes': 'Fijo — avisar también a este grupo cuando cambie un precio',
    'Save group': 'Guardar grupo', 'Contact name:': 'Nombre del contacto:',
    'say "send price list to <name>"': 'diga "send price list to <nombre>"',
    'Save a name once, then just say "send price list to <name>".': 'Guarde un nombre una vez y luego solo diga "send price list to <nombre>".',
    'Save a name once, then just say "send price list to <name>" on WhatsApp instead of typing a number. Groups work the same way — search by name, save it, then send to it exactly like an individual contact. "Standing" contacts (individual or group) also get the auto-notify when a price changes.':
      'Guarde un nombre una vez y luego solo diga "send price list to <nombre>" en WhatsApp en vez de escribir un número. Los grupos funcionan igual — búsquelo por nombre, guárdelo y envíele como a un contacto individual. Los contactos "fijos" (individuales o grupos) también reciben el aviso automático cuando cambia un precio.',

    // spend report
    'Spend report': 'Reporte de gastos',
    'Money OUT — what you paid sellers and spent on expenses, by month and by how it was paid. Sales income is shown separately.':
      'Dinero que SALE — lo que pagó a vendedores y gastó, por mes y por forma de pago. Los ingresos por ventas se muestran aparte.',
    'out': 'salida', 'Export ▾': 'Exportar ▾', 'Period': 'Periodo', 'This month': 'Este mes', 'Last month': 'Mes pasado',
    'This year': 'Este año', 'All time': 'Todo el tiempo', 'Unclassified': 'Sin clasificar', 'Petty cash over this period': 'Caja chica en este periodo',
    '— the whole box, not narrowed by the filters above': '— toda la caja, sin los filtros de arriba', 'Opened': 'Inicial', 'Cash in': 'Entradas',
    'Cash out': 'Salidas', 'Should hold': 'Debería tener', 'Open it up': 'Ver detalle', 'Money out': 'Dinero que sale', 'Whose money': 'De quién es el dinero',
    'Nothing was paid out in this period.': 'No se pagó nada en este periodo.', 'Export as Excel': 'Exportar a Excel', 'Export as PDF': 'Exportar a PDF',

    // yard assistant
    'Yard assistant': 'Asistente del patio', 'Answers questions · cannot change anything': 'Responde preguntas · no puede cambiar nada',
    'What do we still owe?': '¿Qué debemos todavía?', 'Which seller have we bought most from?': '¿A qué vendedor le hemos comprado más?',
    'What did we buy this month?': '¿Qué compramos este mes?', 'What stock is on hand?': '¿Qué hay en existencia?', 'Ask': 'Preguntar',
    'Ask about loads, sellers, stock…': 'Pregunte sobre cargas, vendedores, existencias…', 'Ask about the yard': 'Preguntar sobre el patio',
    'Ask me anything about the yard — loads, sellers, stock, or what is still owed. I can also record a payment, start a draft load, or edit a load. I’ll always show you the exact change and wait for you to confirm it. I can’t delete anything.':
      'Pregúnteme lo que sea del patio — cargas, vendedores, existencias o lo que aún se debe. También puedo registrar un pago, empezar un borrador de carga o editar una carga. Siempre le muestro el cambio exacto y espero a que lo confirme. No puedo eliminar nada.'
  };

  var DAYS = { Monday: 'lunes', Tuesday: 'martes', Wednesday: 'miércoles', Thursday: 'jueves', Friday: 'viernes', Saturday: 'sábado', Sunday: 'domingo' };
  var DAYS3 = { Mon: 'lun', Tue: 'mar', Wed: 'mié', Thu: 'jue', Fri: 'vie', Sat: 'sáb', Sun: 'dom' };
  var MONTHS = { January: 'enero', February: 'febrero', March: 'marzo', April: 'abril', May: 'mayo', June: 'junio', July: 'julio', August: 'agosto', September: 'septiembre', October: 'octubre', November: 'noviembre', December: 'diciembre' };
  var MON3 = { Jan: 'ene', Feb: 'feb', Mar: 'mar', Apr: 'abr', May: 'may', Jun: 'jun', Jul: 'jul', Aug: 'ago', Sep: 'sep', Oct: 'oct', Nov: 'nov', Dec: 'dic' };
  var D = '(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
  var M = '(January|February|March|April|May|June|July|August|September|October|November|December)';
  var M3 = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
  var pl = function (n, one, many) { return Number(n) === 1 ? one : many; };

  // Dynamic wording: a figure or a name inside a fixed sentence. Each pattern must match the WHOLE string.
  var PATTERNS = [
    [/^Gross weight: (.+)$/, 'Peso bruto: $1'], [/^Tare weight: (.+)$/, 'Tara: $1'], [/^Net weight: (.+)$/, 'Peso neto: $1'],
    [/^Amount: (.+)$/, 'Monto: $1'],
    [/^(\d+) loads?$/, function (m, n) { return n + ' ' + pl(n, 'carga', 'cargas'); }],
    [/^(\d+) items?$/, function (m, n) { return n + ' ' + pl(n, 'material', 'materiales'); }],
    [/^Total \((\d+) items?\)$/, function (m, n) { return 'Total (' + n + ' ' + pl(n, 'renglón', 'renglones') + ')'; }],
    [/^(Purchases|Sales|All) \((\d+)\)$/, function (m, w, n) { return ({ Purchases: 'Compras', Sales: 'Ventas', All: 'Todo' })[w] + ' (' + n + ')'; }],
    [new RegExp('^' + D + ', ' + M + ' (\\d+), (\\d{4})$'), function (m, d, mo, day, y) { return DAYS[d] + ', ' + day + ' de ' + MONTHS[mo] + ' de ' + y; }],
    [new RegExp('^' + M + ' (\\d{4})$'), function (m, mo, y) { return MONTHS[mo] + ' de ' + y; }],
    [new RegExp('^' + M + ' (\\d{4}) — (\\d+) loads?$'), function (m, mo, y, n) { return MONTHS[mo] + ' de ' + y + ' — ' + n + ' ' + pl(n, 'carga', 'cargas'); }],
    [new RegExp('^' + M3 + ' (\\d+)$'), function (m, mo, d) { return d + ' ' + MON3[mo]; }],
    [new RegExp('^' + M3 + ' (\\d+) – ' + M3 + ' (\\d+)$'), function (m, a, d1, b, d2) { return d1 + ' ' + MON3[a] + ' – ' + d2 + ' ' + MON3[b]; }],
    [new RegExp('^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), ' + M3 + ' (\\d+)$'), function (m, d, mo, n) { return DAYS3[d] + ', ' + n + ' ' + MON3[mo]; }],
    [/^Load total (.+) · already paid (.+) ·$/, 'Total de la carga $1 · ya pagado $2 ·'],
    [/^Sale total (.+) · already received (.+) ·$/, 'Total de la venta $1 · ya recibido $2 ·'],
    [/^(\$[\d,.]+) outstanding$/, '$1 pendiente'],
    [/^This is (.+) MORE than the load total\.$/, 'Esto es $1 MÁS que el total de la carga.'],
    [/^PARTIAL — (.+) will still be pending\.$/, 'PARCIAL — quedarán $1 pendientes.'],
    [/^Will record (.+)\. No load total, so no balance can be shown\.$/, 'Se registrarán $1. La carga no tiene total, así que no se puede mostrar el saldo.'],
    [/^Nothing open on the other side for (.+) — no sale of theirs is still owing\.$/, 'No hay nada abierto del otro lado para $1 — no tiene ventas pendientes.'],
    [/^Nothing open on the other side for (.+) — no purchase of theirs is still owing\.$/, 'No hay nada abierto del otro lado para $1 — no tiene compras pendientes.'],
    [/^Hold as prepayment — credit (.+), not this load$/, 'Guardar como anticipo — crédito para $1, no para esta carga'],
    [/^(.+) settled, no cash moved\.(.*)$/, function (m, a, rest) { return a + ' compensado, sin mover efectivo.' + rest; }],
    [/^Edit sale — (.+)$/, 'Editar venta — $1'], [/^Edit load — (.+)$/, 'Editar carga — $1'],
    [/^Load (\S+) · (.+)$/, 'Carga $1 · $2'], [/^Sale (\S+) · (.+)$/, 'Venta $1 · $2'],
    [/^Show every (.+) line, load by load$/, 'Ver cada renglón de $1, carga por carga'],
    [/^(\d+) loads? · (.+) · (.+)$/, function (m, n, w, a) { return n + ' ' + pl(n, 'carga', 'cargas') + ' · ' + w + ' · ' + a; }],
    [/^(\d{4}-\d\d-\d\d) · (.+) · no PDF yet$/, '$1 · $2 · sin PDF todavía'],
    [/^Is "(.+)" ferrous or non-ferrous\?$/, '¿"$1" es ferroso o no ferroso?'],
    [/^Ferrous · change$/, 'Ferroso · cambiar'], [/^Non-ferrous · change$/, 'No ferroso · cambiar'],
    [/^· (\d+) payments?$/, function (m, n) { return '· ' + n + ' ' + pl(n, 'pago', 'pagos'); }],
    [/^Split (.+)$/, 'Dividir $1'],
    [/^What is this price per\? \/piece is set in the (.+) app$/, '¿Por qué unidad es este precio? /pieza se configura en la app $1'],
    [/^Unfinished — not saved as loads yet \((\d+)\)$/, 'Sin terminar — aún no guardadas como cargas ($1)'],
    [/^PDF generation failed: (.*)$/s, 'No se pudo generar el PDF: $1'],
    [/^Could not add cash: (.*)$/s, 'No se pudo agregar efectivo: $1'],
    [/^Could not delete: (.*)$/s, 'No se pudo eliminar: $1'], [/^Delete failed: (.*)$/s, 'No se pudo eliminar: $1'],
    [/^Are you sure you want to delete sale (\S+)\?$/, '¿Seguro que quiere eliminar la venta $1?'],
    [/^Are you sure you want to delete load (\S+)\?$/, '¿Seguro que quiere eliminar la carga $1?'],
    [/^The material goes back into inventory as on hand\.$/, 'El material regresa al inventario como existencia.'],
    [/^It is removed from Loads, and its photos and ticket PDFs are trashed in Drive \(recoverable from Drive's Trash for 30 days\)\.$/,
      'Se quita de Cargas, y sus fotos y boletas en PDF van a la papelera de Drive (se pueden recuperar de ahí durante 30 días).'],
    [/^Move cash OUT of which account\?$/, '¿De qué cuenta SALE el efectivo?'], [/^And INTO which\?$/, '¿Y a cuál ENTRA?'],
    [/^Delete this (.*) payment\?$/, '¿Eliminar este pago de $1?']
  ];

  function tr(s) {
    var k = String(s).replace(/\s+/g, ' ').trim();
    if (!k) return null;
    if (Object.prototype.hasOwnProperty.call(ES, k)) return ES[k];
    for (var i = 0; i < PATTERNS.length; i++) if (PATTERNS[i][0].test(k)) return k.replace(PATTERNS[i][0], PATTERNS[i][1]);
    return null;
  }
  // A dialog message is often several paragraphs; each is looked up on its own, unknown ones stay English.
  function trMessage(msg) {
    if (msg == null) return msg;
    var whole = tr(msg); if (whole) return whole;
    return String(msg).split('\n').map(function (line) { var t = tr(line); return t == null ? line : t; }).join('\n');
  }

  var lang = 'en';
  try { lang = localStorage.getItem(KEY) === 'es' ? 'es' : 'en'; } catch (e) { /* storage blocked: English */ }

  function currentTab() { try { return typeof CURRENT_TAB === 'string' ? CURRENT_TAB : ''; } catch (e) { return ''; } }
  function onLoginScreen() { var pw = document.getElementById('pw'); return !!(pw && pw.offsetParent !== null); }
  function yardHere() { return onLoginScreen() || Object.prototype.hasOwnProperty.call(YARD_TABS, currentTab()); }
  function active() { return lang === 'es' && yardHere(); }

  var TEXT = new WeakMap();                 // text node -> { en, es }
  var ATTRS = ['placeholder', 'title', 'aria-label'];
  var anyTranslated = false;

  // Never inside the switch itself, scripts, or anything marked data-no-translate. A textarea's or editable
  // area's TEXT is what the person typed, so only its placeholder/title may change, never its contents.
  function skip(el) { return !el || el.closest('script,style,#yardLangToggle,[data-no-translate]'); }
  function skipText(el) { return skip(el) || el.closest('textarea,[contenteditable="true"],[contenteditable=""]'); }

  function translateNode(n) {
    var rec = TEXT.get(n), cur = n.nodeValue;
    if (rec && cur === rec.es) return;                           // already ours
    var t = tr(cur); if (t == null) { if (rec) TEXT.delete(n); return; }
    var lead = cur.match(/^\s*/)[0], trail = cur.match(/\s*$/)[0];
    var es = lead + t + trail;
    TEXT.set(n, { en: cur, es: es }); n.nodeValue = es; anyTranslated = true;
  }
  function translateEl(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i], v = el.getAttribute(a); if (!v) continue;
      var saved = el.getAttribute('data-i18n-' + a), mine = el.getAttribute('data-i18n-es-' + a);
      if (saved != null && v === mine) continue;
      var t = tr(v); if (t == null) continue;
      el.setAttribute('data-i18n-' + a, v); el.setAttribute('data-i18n-es-' + a, t); el.setAttribute(a, t); anyTranslated = true;
    }
    // An <option> with no value="" posts its LABEL. Pin the English label as the value first, so translating the
    // label can never change what the form sends.
    if (el.tagName === 'OPTION' && !el.hasAttribute('value')) el.setAttribute('value', el.textContent);
  }
  function walk(root, fnText, fnEl) {
    if (!root) return;
    if (root.nodeType === 3) { if (!skipText(root.parentElement)) fnText(root); return; }
    if (root.nodeType !== 1 || skip(root)) return;
    fnEl(root);
    var w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (x) { var el = x.nodeType === 1 ? x : x.parentElement; return skip(el) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
    });
    var x; while ((x = w.nextNode())) { if (x.nodeType === 3) { if (!skipText(x.parentElement)) fnText(x); } else fnEl(x); }
  }
  function translateAll(root) { walk(root || document.body, translateNode, translateEl); }
  function restoreAll() {
    walk(document.body, function (n) { var r = TEXT.get(n); if (r) { if (n.nodeValue === r.es) n.nodeValue = r.en; TEXT.delete(n); } }, function (el) {
      for (var i = 0; i < ATTRS.length; i++) {
        var a = ATTRS[i], en = el.getAttribute('data-i18n-' + a); if (en == null) continue;
        if (el.getAttribute(a) === el.getAttribute('data-i18n-es-' + a)) el.setAttribute(a, en);
        el.removeAttribute('data-i18n-' + a); el.removeAttribute('data-i18n-es-' + a);
      }
    });
    anyTranslated = false;
  }

  // ── WHERE THE SWITCH LIVES (2026-11-21) ──
  // Reported 2026-11-21: "in some of the browser, language space overlaps with +load on the screen". It floated over the page
  // (position:fixed, top right), and a floating thing lands on whatever the page puts under it — + Load sits top
  // right, and where exactly depends on the window width and the browser's fonts. A first fix nudged it to the top
  // edge; nudging cannot be right for every browser. So in the app it is no longer floating at all: it sits in the
  // menu's footer, above Sign out, in the page's own flow, where nothing can be drawn under it. On a narrow window
  // that menu folds behind ☰ and the switch goes with it, exactly like Sign out.
  // The sign-in screen has no menu and no + Load, so there it stays a small tab at the top-right edge.
  var FLOAT_CSS = 'position:fixed; top:0; right:72px; z-index:61; border:1px solid var(--steel-700, #444); border-top:none; border-radius:0 0 10px 10px; overflow:hidden; font:600 10px/1 var(--font-mono, monospace); letter-spacing:.08em;';
  var MENU_CSS = 'position:static; width:100%; margin-top:12px; border:1px solid var(--steel-700, #444); border-radius:16px; overflow:hidden; font:600 10.5px/1 var(--font-mono, monospace); letter-spacing:.08em;';
  function place(t) {
    var out = document.getElementById('btnSignout');
    var inMenu = !!(out && out.parentNode);
    if (inMenu && t.nextSibling !== out) out.parentNode.insertBefore(t, out);          // above Sign out
    else if (!inMenu && t.parentNode !== document.body) document.body.appendChild(t);
    var where = inMenu ? 'menu' : 'float';
    if (t.dataset.where !== where) {
      t.dataset.where = where;
      var disp = t.style.display;
      t.style.cssText = (inMenu ? MENU_CSS : FLOAT_CSS) + ' display:' + (disp || 'none') + ';';
      [].forEach.call(t.querySelectorAll('button'), function (b) {
        b.style.padding = inMenu ? '7px 0' : '5px 10px';
        b.style.flex = inMenu ? '1 1 0' : '';
      });
    }
  }
  function paintToggle() {
    var t = document.getElementById('yardLangToggle');
    if (!t) {
      t = document.createElement('div'); t.id = 'yardLangToggle'; t.setAttribute('role', 'group'); t.setAttribute('aria-label', 'Language / Idioma');
      t.style.display = 'none';
      ['en', 'es'].forEach(function (code) {
        var b = document.createElement('button'); b.type = 'button'; b.dataset.lang = code; b.textContent = code.toUpperCase();
        b.style.cssText = 'border:none; cursor:pointer;';
        b.addEventListener('click', function () { setLang(code); });
        t.appendChild(b);
      });
    }
    place(t);
    var disp = yardHere() ? 'flex' : 'none';
    if (t.style.display !== disp) t.style.display = disp;
    if (t.dataset.painted === lang) return;                                 // repaint only when the choice changes
    t.dataset.painted = lang;
    [].forEach.call(t.querySelectorAll('button'), function (b) {
      var on = b.dataset.lang === lang;
      b.style.background = on ? 'var(--accent, #2f9e44)' : 'var(--steel-900, #111)';
      b.style.color = on ? '#fff' : 'var(--text-muted, #aaa)';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  var lastTab = null, queued = [], scheduled = false;
  function flush() {
    scheduled = false;
    var tab = currentTab(), tabChanged = tab !== lastTab; lastTab = tab;
    paintToggle();
    if (active()) {
      if (tabChanged) translateAll(); else { var q = queued; queued = []; q.forEach(function (r) { if (r.isConnected) translateAll(r); }); }
      document.documentElement.setAttribute('lang', 'es');
    } else if (anyTranslated) { restoreAll(); document.documentElement.setAttribute('lang', 'en'); }
    queued = [];
  }
  function schedule(root) { if (root) queued.push(root); if (!scheduled) { scheduled = true; (window.requestAnimationFrame || setTimeout)(flush); } }

  function setLang(code) {
    lang = code === 'es' ? 'es' : 'en';
    try { localStorage.setItem(KEY, lang); } catch (e) { /* not remembered, still switches */ }
    if (active()) translateAll(); else restoreAll();
    document.documentElement.setAttribute('lang', active() ? 'es' : 'en');
    paintToggle();
  }

  // Native dialogs: translated only while active, return values untouched.
  ['alert', 'confirm', 'prompt'].forEach(function (name) {
    var orig = window[name]; if (typeof orig !== 'function') return;
    window[name] = function (msg) {
      var args = [].slice.call(arguments);
      if (active()) args[0] = trMessage(msg);
      return orig.apply(window, args);
    };
  });

  function start() {
    paintToggle();
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        var tgt = m.target && (m.target.nodeType === 1 ? m.target : m.target.parentElement);
        if (tgt && tgt.closest && tgt.closest('#yardLangToggle')) continue;     // our own switch repainting itself
        if (m.type === 'childList') for (var j = 0; j < m.addedNodes.length; j++) schedule(m.addedNodes[j]);
        else schedule(m.target);
      }
      schedule(null);
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title', 'class', 'style'] });
    schedule(null);
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);

  window.yardLang = { set: setLang, get: function () { return lang; }, tr: tr, active: active, _ES: ES, _PATTERNS: PATTERNS };
})();
