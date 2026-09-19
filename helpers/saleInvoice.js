// ── helpers/saleInvoice.js — a sale row becomes an invoice ──────────────────
//
// Apsara, 2026-09-19: "if all important details of bills is entered,if i say
// create invoice(it needs to ask-separate invoice and packing list/normal)
// -upon my confirmation-it needs to create automatically (get verfiication
// from me by showing that on screen)andupon confirm- mail it to the customer
// with loading photos"
//
// ── WHY IT STARTS FROM THE SALE AND NOT THE BILL ────────────────────────────
// Her word was "bills", and the answer to the question is the SALE. A bill is
// what she PAID a supplier for a container; an invoice is what she BILLS a
// customer for it. The customer's name and the selling price exist only on
// the sale — a bill has neither and never will. Asked directly on 2026-09-19
// she chose the sale row, which is the same answer for the same reason.
//
// The bill is still needed, and this file goes and gets it: the weighbridge
// figures a packing list is made of (gross, truck, container tare, chassis,
// boxes) are recorded when the metal is BOUGHT, and the loading photos she
// wants in the email are pasted onto the bill. So an invoice is built from
// both sides, joined on the pair that identifies a physical container.
//
// ═══ THE REASON THIS FILE IS WORTH HAVING AT ALL ════════════════════════════
//
// 260918_AP_26ARIS02 went to a buyer and a broker stating:
//
//     Quantity 15,642.000 MT      where her packing list says 7.095
//
// The money on it was right — $0.548/lb — because the POUNDS had been typed
// into a column headed "Quantity MT" and the per-pound rate into one headed
// "Rate US$/MT", and the product of two wrong figures was the correct dollar
// amount. Nothing on the document disagreed with itself in dollars, so
// nothing looked wrong.
//
// That is a TYPING mistake, and typing is precisely what this file removes.
// The invoice's Quantity column is MT and its Rate column is US$/MT; the
// sale stores weight in pounds and a price that may be per pound or per MT.
// Converting between those is arithmetic, and arithmetic does not get tired
// at eleven at night. Everything below comes from sales.compute() and
// bills.compute() — the same derived figures the ledger screens show — and
// no figure is carried across without being converted into the unit the
// column it lands in is labelled with.
//
// helpers/invoiceWeights.js still checks the result. Belt and braces on the
// one document that goes to customs.

const bills = require('./bills');
const sales = require('./sales');
const { keyOf } = require('./margin');

const round2 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 100) / 100 : null);
const round3 = (n) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 1000) / 1000 : null);

const str = (v) => String(v === null || v === undefined ? '' : v).trim();

// ── THE MATCHING BILL ───────────────────────────────────────────────────────
// Booking AND container, never the container alone: MSKU1111111 sails again
// next year with different metal in it, so a container number is not unique
// over time. helpers/margin.js joins the two ledgers on exactly this pair and
// this reuses its key rather than writing a second definition of "the same
// container" that would drift.
//
// Returns null rather than guessing. A sale with no matching bill is a real
// situation — the purchase side may not be entered yet — and it does not stop
// an invoice being raised; it only means there are no weighbridge figures and
// no photos, which the caller is told about rather than left to discover.
function billFor(sale) {
    const wanted = keyOf(sale && sale.booking_no, sale && sale.container_no);
    if (wanted === '|') return null;
    const hit = bills.listWithTotals()
        .find((b) => keyOf(b.booking_no, b.container_no) === wanted);
    return hit || null;
}

// ── THE RATE, IN THE UNIT THE COLUMN SAYS ───────────────────────────────────
// The invoice's Rate column is headed "Rate US$/MT" (helpers/invoicePdf.js
// writes that header). Her sale price is per POUND whenever it is under $10 —
// that inference lives in sales.compute() as bills.PER_LB_CEILING and is
// hers to override with price_unit.
//
// $0.548/lb is $1,208.09/MT. Printing 0.548 under a column headed US$/MT is
// the Aris invoice, so this multiplies rather than copies.
function ratePerMt(sale) {
    const c = sales.compute(sale || {});
    const price = Number(sale && sale.invoice_price);
    if (!isFinite(price) || price === 0) return null;
    return c.price_unit === 'lb' ? round2(price * bills.LB_PER_MT) : round2(price);
}

// ── IS THIS SALE READY TO BE INVOICED ───────────────────────────────────────
// "if all important details of bills is entered". Deliberately NOT the same
// list as bills.missingFor: that answers "is this purchase finished", and a
// purchase can be finished while the thing you would print is not.
//
// Each of these is a field the printed document has a box for and cannot
// invent. Anything else — seal number, vessel, port pair — prints blank
// rather than blocking, because a blank line on an invoice is a thing she can
// see and fix, and a refusal she has to argue with is not.
const REQUIRED = [
    ['invoice_no', 'invoice number'],
    ['customer', 'customer'],
    ['container_no', 'container no'],
];
function readiness(sale) {
    const s = sale || {};
    const missing = REQUIRED.filter(([k]) => !str(s[k])).map(([, label]) => label);

    const c = sales.compute(s);
    // Quantity and Rate are the two columns with arithmetic behind them. An
    // invoice missing either is not a document, it is a blank form.
    if (c.weight_mt === null || c.weight_mt === 0) missing.push('weight');
    if (ratePerMt(s) === null && c.amount === null) missing.push('price');
    if (!str(s.item)) missing.push('item description');

    return { ok: missing.length === 0, missing };
}

// ── THE PACKING FIGURES ─────────────────────────────────────────────────────
// Strings, because that is the shape collectInvoicePayload on the Documents
// screen produces and helpers/invoicePdf.js is written against it. Empty
// string for a figure that was never weighed — NOT zero. A zero tare silently
// inflates the net weight and therefore the amount, which is the rule
// helpers/bills.js already follows and the reason it reports missing_tares
// rather than assuming.
//
// ── A GRADE WITH ITS OWN WEIGHBRIDGE TICKET USES IT ─────────────────────────
// bills.cleanItems keeps each line's own gross and tares when it was weighed
// separately (`weighed: true`), which is the case a multi-grade packing list
// exists for. Falling back to the CONTAINER's figures for such a line would
// print the whole container's gross against one grade of it.
function packingFrom(source, weightMt) {
    const s = (v) => (v === null || v === undefined || v === '' ? '' : String(v));
    if (!source) {
        return { gross_weight_lbs: '', truck_lbs: '', container_tare_lbs: '', chassis_lbs: '',
                 boxes_weight_lbs: '', net_weight_lbs: '',
                 net_weight_mt: weightMt === null || weightMt === undefined ? '' : Number(weightMt).toFixed(3) };
    }
    // An item line carries `weighed`; a bill row does not.
    const isItem = Object.prototype.hasOwnProperty.call(source, 'weighed');
    const gross = isItem ? source.gross : bills.compute(source).gross_used;
    const netLb = isItem ? source.weight : bills.compute(source).net_lb;
    return {
        gross_weight_lbs: s(gross),
        truck_lbs: s(source.truck),
        container_tare_lbs: s(source.container),
        chassis_lbs: s(source.chassis),
        boxes_weight_lbs: s(source.boxes),
        net_weight_lbs: s(netLb),
        // The SALE's invoiced tonnage, not the bill's purchased one. They are
        // usually the same number and are not the same fact: she can sell a
        // container at the weight the buyer's scale agreed rather than hers,
        // and the invoice has to say what she is charging for.
        net_weight_mt: weightMt === null || weightMt === undefined ? '' : Number(weightMt).toFixed(3),
    };
}

// ── A LINE'S RATE, IN US$/MT ────────────────────────────────────────────────
// Same conversion as ratePerMt, for a grade that carries its own price.
// bills.cleanItems has already decided the unit by magnitude (and honours an
// explicit price_unit), so this only has to convert, never to guess.
function itemRatePerMt(item, fallback) {
    const price = Number(item && item.price);
    if (!isFinite(price) || price === 0) return fallback;
    return item.price_unit === 'lb' ? round2(price * bills.LB_PER_MT) : round2(price);
}

// ── THE LOADING PHOTOS ──────────────────────────────────────────────────────
// Pasted onto the BILL, one link per line — her 2026-09-10 request, "In
// bill,i want photos field where url can be pasted". bills.cleanPhotos has
// already thrown away anything that is not an http(s) URL, so what comes back
// here is safe to put in an email body.
//
// Links, not attachments: her answer when asked on 2026-09-19. They cannot
// bounce a message for size, which phone photos of a loading bay very much
// can.
function photosFor(bill) {
    return bills.cleanPhotos((bill || {}).photos);
}

// ── THE BODY /api/invoice/generate EXPECTS ──────────────────────────────────
// Field for field what dashboard/documents.html's collectInvoicePayload()
// produces, because that route is not being changed to suit this one. Its
// shape is the contract; this file's job is to satisfy it from stored data
// instead of from boxes she typed into.
//
// ── ONE LINE PER GRADE ──────────────────────────────────────────────────────
// A container can carry several grades (her 2026-09-10 question: "what if i
// have multiple items in sales under the same container"), and sales.compute
// already splits them into `items` with their own weights. When it has done
// so, each becomes its own invoice row; when it has not, the container is one
// row. Same rule the packing list follows.
function buildFrom(sale, opts = {}) {
    const s = sale || {};
    const c = sales.compute(s);
    const bill = opts.bill !== undefined ? opts.bill : billFor(s);
    const rate = ratePerMt(s);

    const warnings = [];
    if (!bill) {
        warnings.push('No matching bill for this booking and container, so the packing weights and loading photos are blank.');
    } else if ((bills.compute(bill).missing_tares || []).length) {
        warnings.push(`The bill has no weight recorded for: ${bills.compute(bill).missing_tares.join(', ')} — the net is computed without them.`);
    }
    if (c.weight_conflict) {
        warnings.push('The sale\'s own weight and the sum of its item weights disagree.');
    }

    // ── THE TWO SIDES OF THE SAME CONTAINER, SIDE BY SIDE ───────────────────
    // The packing list prints the BILL's net (gross minus tares, what the
    // weighbridge said when she bought it); the invoice charges the SALE's
    // weight. They are allowed to differ — she said so on 2026-09-10, the
    // invoiced weight "can differ after reweighing at destination" — so this
    // is a warning and never a refusal.
    //
    // It is here because NOTHING ELSE CATCHES IT. helpers/invoiceWeights.js
    // compares a row's stated quantity against that row's OWN gross and
    // tares, so a 10% gap between the two ledgers sits comfortably inside its
    // 2% pounds-in-MT test and nowhere near its 5x far-off one. A document
    // whose two halves quietly disagree about how much metal is in the box is
    // exactly the kind that gets argued about at a port.
    //
    // 1% because a weighbridge and a buyer's scale routinely differ by a few
    // hundred pounds on 20 tons, and a warning she sees every time is a
    // warning she stops reading.
    if (bill) {
        const billMt = bills.compute(bill).net_mt;
        if (billMt !== null && c.weight_mt !== null && billMt > 0
            && Math.abs(c.weight_mt - billMt) / billMt > 0.01) {
            warnings.push(`The invoice charges ${c.weight_mt.toFixed(3)} MT; the bill's weighbridge net is `
                + `${billMt.toFixed(3)} MT. The packing list will print the bill's figure.`);
        }
    }

    // Per-grade rows when the sale carries them, one row otherwise.
    const graded = Array.isArray(c.items) && c.items.length > 0 ? c.items : null;
    const lineItems = graded
        ? graded.map((it) => {
            const mt = it.weight_mt !== null && it.weight_mt !== undefined ? round3(it.weight_mt) : null;
            const lineRate = itemRatePerMt(it, rate);
            return {
                // bills.cleanItems calls it `description`; the invoice body
                // calls it `item_desc`. Falls back to the sale's own item so
                // a line that was entered as a weight with no grade named
                // still prints something a customs officer can read.
                item_desc: str(it.description) || str(s.item),
                container_no: str(s.container_no),
                seal_no: str((bill || {}).seal_no),
                weight: mt,
                rate: lineRate,
                amount: it.amount !== null && it.amount !== undefined
                    ? round2(it.amount)
                    : round2((mt || 0) * (lineRate || 0)),
                // Its own ticket if it was weighed on its own; the
                // container's figures only when this grade IS the container.
                packing: packingFrom(it.weighed ? it : (graded.length === 1 ? bill : null), mt),
            };
        })
        : [{
            item_desc: str(s.item),
            container_no: str(s.container_no),
            seal_no: str((bill || {}).seal_no),
            weight: c.weight_mt,
            rate,
            // ── HER FIGURE WINS, EXACTLY AS IT DOES ON THE LEDGER ───────
            // sales.compute returns the amount she typed when she typed one
            // and the arithmetic otherwise. Recomputing here would put a
            // number on the customer's invoice that her own Sales tab
            // disagrees with by a cent, and reconciling that later is worse
            // than tedious.
            amount: c.amount !== null ? round2(c.amount) : round2((c.weight_mt || 0) * (rate || 0)),
            packing: packingFrom(bill, c.weight_mt),
        }];

    const subtotal = round2(lineItems.reduce((t, it) => t + (Number(it.amount) || 0), 0));

    // ── CHARGES REBILLED TO THE CUSTOMER BECOME NOTE LINES ──────────────────
    // sales.compute splits charges by direction: 'in' is money she recovers
    // FROM the customer, 'out' is her own cost. Only the 'in' ones belong on
    // the customer's invoice — putting an 'out' charge on it would bill them
    // for her commission.
    //
    // A charge is { what, amount, why, direction } — `what` is the name she
    // gave it and `why` is the note cleanCharges REQUIRES, for the reason it
    // states: "the line that cannot be explained is the one that gets written
    // off". The customer's invoice prints `what`; `why` is hers.
    const notes = (c.charges || [])
        .filter((ch) => ch.direction === 'in' && Number(ch.amount))
        .map((ch) => ({ label: str(ch.what) || 'Charges', amount: round2(Number(ch.amount)) }));
    const notesTotal = round2(notes.reduce((t, n) => t + n.amount, 0));

    const body = {
        inv_no: str(s.invoice_no),
        inv_date: str(s.date),
        reference: str(s.reference),
        terms: str(s.terms),
        container_no: str(s.container_no),
        booking_no: str(s.booking_no),
        seal_no: str((bill || {}).seal_no),
        place_of_receipt: '',
        port_loading: '',
        port_discharge: '',
        vessel: '',
        country_of_origin: '',
        consignee: str(s.customer),
        // Filled by the route from the address book when there is one — this
        // file does not reach for contacts, so it stays testable without one.
        consignee_address: [],
        proforma_date: str(s.proforma_date),
        notes,
        subtotal,
        final_amount: round2(subtotal + notesTotal),
        line_items: lineItems,
    };

    return { body, bill, photos: photosFor(bill), warnings, readiness: readiness(s) };
}

module.exports = { billFor, ratePerMt, readiness, packingFrom, photosFor, buildFrom, REQUIRED };
