#!/usr/bin/env python3
# ── scripts/build-metals-manual.py — the Edge Metals manual, as a PDF ────────
#
# Apsara, 2026-09-20, after the yard manual: "Similarly create for Edge Metals
# Staff".
#
# ── THERE IS NO "EDGE METALS STAFF" ROLE, AND THAT IS WHY THIS EXISTS ────────
# The app has two roles. `staff` is refused by the server on every screen in
# this document — api.js's STAFF_ALLOWED_PATH_PREFIXES lists eleven prefixes
# and not one of them is /api/bookings, /api/bills, /api/sales or
# /api/documents. So whoever does Metals work today holds an ADMIN login, and
# this is written for that person: the one who books the containers, records
# what was paid, raises the invoice and sends the paperwork.
#
# It is deliberately NOT written as though the reader were restricted, because
# they are not. What it does instead is say plainly which actions leave the
# building — an invoice emailed to a buyer cannot be recalled — and which are
# only ever a record.
#
#   python3 scripts/build-metals-manual.py
#   python3 scripts/build-metals-manual.py --out X.pdf
#
# Shares nothing with build-staff-manual.py on purpose: two documents, two
# audiences, and a shared template would make every change to one a risk to
# the other. What they share is the house style, copied and free to diverge.

import sys, os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
                                Spacer, Image, KeepTogether, PageBreak, Table, TableStyle)
from PIL import Image as PILImage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'Jarvis_EdgeMetals_Manual.pdf')
if '--out' in sys.argv:
    OUT = sys.argv[sys.argv.index('--out') + 1]

SHOTS = os.environ.get('JARVIS_SHOTS', '/sessions/nifty-youthful-lovelace/mnt/outputs')
FIGS = {
    'board':     'screenshot-1789885031717-c88964b7.jpg',
    'bookings':  'screenshot-1789884963194-0af51741.jpg',
    'bills':     'screenshot-1789884977852-3f11cde3.jpg',
    'invoices':  'screenshot-1789884993578-cdd67b8f.jpg',
    'documents': 'screenshot-1789885058108-c4607b60.jpg',
    'proforma':  'screenshot-1789885042482-48295438.jpg',
}

INK      = colors.HexColor('#1C1B19')
MUTED    = colors.HexColor('#5A5A55')
RULE     = colors.HexColor('#D8D5D0')
ACCENT   = colors.HexColor('#185FA5')
WARNBG   = colors.HexColor('#FBF3E7')
WARNLINE = colors.HexColor('#C98A2E')
STOPBG   = colors.HexColor('#FBEDEC')
STOPLINE = colors.HexColor('#A32D2D')

def S(name, **kw):
    base = dict(fontName='Helvetica', fontSize=10.2, leading=15.4, textColor=INK,
                spaceAfter=7, alignment=TA_LEFT)
    base.update(kw)
    return ParagraphStyle(name, **base)

BODY = S('body')
LEAD = S('lead', fontSize=11.6, leading=17.4, spaceAfter=11)
H1   = S('h1', fontName='Helvetica-Bold', fontSize=21, leading=25, spaceBefore=4, spaceAfter=10)
H2   = S('h2', fontName='Helvetica-Bold', fontSize=13.4, leading=17, spaceBefore=15, spaceAfter=6)
H3   = S('h3', fontName='Helvetica-Bold', fontSize=11, leading=14.5, spaceBefore=11, spaceAfter=4)
CAP  = S('cap', fontSize=8.6, leading=11.6, textColor=MUTED, spaceBefore=4, spaceAfter=13)
BUL  = S('bul', leftIndent=13, bulletIndent=3, spaceAfter=4)
EYE  = S('eye', fontName='Helvetica-Bold', fontSize=8, leading=11, textColor=ACCENT, spaceAfter=3)
NOTE = S('note', fontSize=9.6, leading=14.2, textColor=INK)

story = []
def p(t, st=BODY):  story.append(Paragraph(t, st))
def h1(t):          story.append(Paragraph(t, H1))
def h2(t):          story.append(Paragraph(t, H2))
def h3(t):          story.append(Paragraph(t, H3))
def eyebrow(t):     story.append(Paragraph(t.upper(), EYE))
def gap(h=6):       story.append(Spacer(1, h))
def bullets(items):
    for i in items:
        story.append(Paragraph(i, BUL, bulletText='•'))
    gap(5)

def rule():
    t = Table([['']], colWidths=[165*mm], rowHeights=[0.7])
    t.setStyle(TableStyle([('BACKGROUND', (0,0), (-1,-1), RULE)]))
    story.append(Spacer(1, 6)); story.append(t); story.append(Spacer(1, 10))

def box(title, text, stop=False):
    """
    Two weights of note. `stop` is reserved for the handful of actions that
    LEAVE THE BUILDING — an email to a buyer, a document a broker will file.
    If everything is red, nothing is.
    """
    inner = [[Paragraph(f'<b>{title}</b>', NOTE)], [Paragraph(text, NOTE)]]
    t = Table(inner, colWidths=[159*mm])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), STOPBG if stop else WARNBG),
        ('LINEBEFORE', (0,0), (0,-1), 2.2, STOPLINE if stop else WARNLINE),
        ('LEFTPADDING', (0,0), (-1,-1), 9), ('RIGHTPADDING', (0,0), (-1,-1), 9),
        ('TOPPADDING', (0,0), (0,0), 8), ('BOTTOMPADDING', (0,-1), (-1,-1), 8),
        ('TOPPADDING', (0,1), (-1,-1), 1),
    ]))
    story.append(Spacer(1, 5)); story.append(t); story.append(Spacer(1, 12))

def figure(key, caption, width=163*mm):
    name = FIGS.get(key) or ''
    path = os.path.join(SHOTS, name) if name else ''
    if not path or not os.path.isfile(path):
        ph = Table([[Paragraph(f'<b>[ screenshot missing: {key} ]</b>', CAP)]],
                   colWidths=[width], rowHeights=[26*mm])
        ph.setStyle(TableStyle([('BOX', (0,0), (-1,-1), 0.8, WARNLINE),
                                ('ALIGN', (0,0), (-1,-1), 'CENTER'),
                                ('VALIGN', (0,0), (-1,-1), 'MIDDLE')]))
        story.append(KeepTogether([ph, Paragraph(caption, CAP)]))
        return
    iw, ih = PILImage.open(path).size
    img = Image(path, width=width, height=width * ih / iw); img.hAlign = 'LEFT'
    b = Table([[img]], colWidths=[width])
    b.setStyle(TableStyle([('BOX', (0,0), (-1,-1), 0.6, RULE),
                           ('LEFTPADDING', (0,0), (-1,-1), 0), ('RIGHTPADDING', (0,0), (-1,-1), 0),
                           ('TOPPADDING', (0,0), (-1,-1), 0), ('BOTTOMPADDING', (0,0), (-1,-1), 0)]))
    story.append(KeepTogether([b, Paragraph(caption, CAP)]))

# ════════════════════════════════════════════════════════════════════════════
gap(52)
eyebrow('Edge Metals  ·  shipping and paperwork')
story.append(Paragraph('Jarvis', S('cover', fontName='Helvetica-Bold', fontSize=44,
                                   leading=48, spaceAfter=6)))
story.append(Paragraph('Edge Metals manual', S('sub', fontSize=17, leading=22,
                                               textColor=MUTED, spaceAfter=22)))
rule()
p('Edge Metals books containers, buys the metal that goes in them, sells it on, '
  'and produces the paperwork that moves it. This manual covers that work end to '
  'end: the booking, the supplier bill, the customer invoice, and the documents '
  'a buyer and a broker actually receive.', LEAD)
p('It is not the yard manual. Edge Yard and Edge Metals are separate companies '
  'and separate money — a rule for one is not a rule for the other, and that '
  'separation is most of what this software is for.', LEAD)
gap(16)
p('<b>September 2026</b> · Edge Metals Inc', CAP)
story.append(PageBreak())

# ════════════════════════════════════════════════════════════════════════════
h1('1. How the work fits together')
p('One container passes through four records, in this order. Each one is a '
  'different question, and getting them confused is the commonest way the '
  'numbers go wrong.')
bullets([
  '<b>Booking</b> — the shipping line has given us space. Ports, dates, vessel.',
  '<b>Bill</b> — what we PAID a supplier for the metal in that container.',
  '<b>Invoice</b> — what we BILL a customer for it.',
  '<b>Documents</b> — the commercial invoice, packing list and BOL that travel '
  'with the shipment.',
])
p('A booking with no bill is metal we have not bought yet. A bill with no '
  'invoice is metal we own and have not sold. The <b>Margin</b> view puts the '
  'two sides of the same container together, which only works if both were '
  'entered against the same booking and container number.')

box('Booking number and container number, always both',
    'A container number is not unique over time — MSKU1111111 sails again next '
    'year with different metal in it. The booking is what tells the two apart. '
    'Enter both on every bill and every invoice, spelled identically, or the '
    'container simply will not appear in Margin and nobody will be told why.')

h2('Signing in')
p('Open <b>jarvis.edgemetals.com</b>. Everything in this manual needs an admin '
  'login — there is no separate Edge Metals sign-in, and a yard staff login is '
  'refused on every screen here.')
story.append(PageBreak())

# ════════════════════════════════════════════════════════════════════════════
h1('2. Board — what needs attention today')
p('The Board is the first screen after sign-in. It is not a list of everything; '
  'it is a list of what is at risk.')
figure('board',
       'Figure 1 — the Board. The four counts split every active booking by how '
       'much trouble it is in; NEEDS ATTENTION below names the specific ones.')
h2('Reading it')
bullets([
  '<b>HIGH RISK</b> — a cutoff or ERD is close and something is still missing.',
  '<b>MEDIUM RISK</b> — worth watching this week.',
  '<b>ON TRACK</b> — nothing outstanding.',
  '<b>COMPLETE</b> — shipped and done.',
])
p('Each card under NEEDS ATTENTION shows the booking number, what is missing — '
  '"Awaiting supplier assignment" is the usual one — and a red tag with the '
  'deadline that is approaching: <b>ERD</b> (earliest receiving date) or '
  '<b>CUTOFF</b>.')
p('The tags count in days. A booking showing <b>ERD · 2d</b> has two days before '
  'the port will accept the container. Clicking a card opens that booking.')
story.append(PageBreak())

# ════════════════════════════════════════════════════════════════════════════
h1('3. Bookings — the shipping side')
p('Every container the shipping line has confirmed. Grouped by port of loading, '
  'then by destination, because that is how a week\'s work is actually planned.')
figure('bookings',
       'Figure 2 — the Booking ledger, grouped by port of loading. Each row is '
       'one booking with its dates and container count.')
h2('The five dates')
bullets([
  '<b>ERD</b> — earliest receiving date. The port will not take the container before this.',
  '<b>CUTOFF</b> — the last moment it can be delivered to the port. Miss it and the container rolls to the next vessel.',
  '<b>ETD</b> — when the vessel is due to sail.',
  '<b>ETA</b> — when it is due to arrive.',
  '<b>CONTAINERS</b> — how many are on this booking.',
])
p('<b>+ ADD BOOKING</b> records a new one. <b>EDIT</b> corrects one; <b>DEL</b> '
  'removes it. The triangle at the start of a row expands it to show the '
  'individual containers and their stage.')

box('The dates come from the carrier, not from us',
    'When a carrier emails a revised cutoff, the booking must be updated to '
    'match — the Board works out what is at risk from these dates and nothing '
    'else. A stale cutoff means a container that looks safe on the screen and '
    'rolls in reality.')
story.append(PageBreak())

# ════════════════════════════════════════════════════════════════════════════
h1('4. Bills — what we paid the supplier')
p('One row per container bought. This is the cost side: the weighbridge '
  'figures, the supplier\'s price, the haulage, and what is still owed.')
figure('bills',
       'Figure 3 — Purchase bills. The strip across the top totals the whole '
       'filtered set; the filters below narrow it.')
h2('The totals strip')
bullets([
  '<b>NET WEIGHT (LBS / MT)</b> — the metal, after every tare is deducted.',
  '<b>SUPPLIER INVOICE AMOUNT</b> — what the suppliers have billed.',
  '<b>PAYABLE</b> — that amount less the haulage we paid on their behalf.',
  '<b>BALANCE</b> — what is still outstanding after payments.',
])
p('Those figures describe <b>the rows currently on screen</b>. Narrow by '
  'supplier or by date and they narrow with it — which is the point, and also '
  'why a total should never be quoted without saying what was filtered.')

h2('How a bill fills up')
p('A bill is rarely complete in one sitting, and it is not meant to be. The '
  'weighbridge ticket, the supplier\'s invoice and the trucker\'s number arrive '
  'on different days, so a half-filled bill is a normal state and the row says '
  'what it is still waiting for.')
h3('The weights')
p('<b>Gross</b> minus the tares — truck, container, chassis, boxes — gives '
  '<b>Net</b>. A tare left blank is reported rather than treated as zero: a '
  'missing tare would quietly inflate the net weight, and the amount is '
  'calculated from it.')
h3('The buttons')
bullets([
  '<b>PAY</b> — record a payment to a supplier.',
  '<b>CLEAN NAMES</b> — merge spellings of the same supplier ("CALDERON", "calderon", "Calderon") into one.',
  '<b>IMPORT</b> — load a shipments workbook.',
  '<b>+ ADD BILL</b> — a new bill by hand.',
])
story.append(PageBreak())

# ════════════════════════════════════════════════════════════════════════════
h1('5. Invoice register — what the customer owes')
p('The sell side. One row per container invoiced, with the customer, the price, '
  'the terms and what has been received.')
figure('invoices',
       'Figure 4 — the Invoice register. The sub-tabs across the top switch '
       'between Outgoing, Incoming, Freight, Commission and Margin.')
h2('The five sub-tabs')
bullets([
  '<b>Outgoing</b> — invoices raised to customers. The main list.',
  '<b>Incoming</b> — money received against them.',
  '<b>Freight</b> — freight charges, and which side carries them.',
  '<b>Commission</b> — what an agent is owed, per metric ton of the invoiced weight.',
  '<b>Margin</b> — cost and revenue for the same container, side by side.',
])

h2('Weight and price')
p('Weight is entered in <b>pounds</b> unless stated otherwise. Price is read as '
  '<b>per pound under $10</b> and <b>per metric ton at $10 and above</b> — so '
  '0.548 is per lb and 880 is per MT, and the amount follows automatically. '
  'Type the total into <b>Invoice amount</b> instead when a flat figure was '
  'agreed, and that figure wins.')

box('The banner at the top of the list',
    'A line such as <i>"TLLU2110739 appears 3 times under NAM8234010"</i> is '
    'the register telling you one container is claimed more than once — usually '
    'a typo, occasionally a real split across two invoices. It is worth opening '
    'either way, because Margin counts both sides of that container and a '
    'duplicate is counted twice.')
story.append(PageBreak())

# ════════════════════════════════════════════════════════════════════════════
h1('6. Documents — what the buyer and the broker receive')
p('Everything that leaves the company is generated here: the commercial '
  'invoice, the packing list, the bill of lading and the proforma. These are '
  'the pages that go to a customer and to customs, so they are the ones worth '
  'slowing down over.')
figure('documents',
       'Figure 5 — the Documents screen, Invoice tab. Three ways in: by buyer, '
       'by container number, or by invoice number.')
h2('Finding the shipment')
bullets([
  '<b>FIND CONTAINERS</b> — type a buyer and every container on record for them comes up.',
  '<b>FIND BY CONTAINER #</b> — one container, or several comma-separated to merge them onto one invoice.',
  '<b>FIND BY INV NO.</b> — reopen an invoice already raised.',
])
p('Merging several containers onto one invoice is what the comma-separated box '
  'is for. Each keeps its own seal number and its own line on the printed '
  'document.')

h2('Invoice, packing list, or both')
p('When generating, three shapes are offered and they exclude each other:')
bullets([
  '<b>Normal</b> — one PDF, the invoice with its packing list behind it.',
  '<b>Separate invoice and packing list</b> — two PDFs, filed as a pair.',
  '<b>Invoice only</b> — no packing list at all, in the file or in the email.',
])

box('Quantity is in METRIC TONS and the rate is per METRIC TON',
    'The printed columns are headed "Quantity MT" and "Rate US$/MT". Typing a '
    'weight in pounds into that first column produces a document whose money is '
    'correct and whose tonnage is nonsense — an invoice once left here stating '
    '<b>15,642 MT</b> where the packing list said <b>7.095</b>, and nothing on '
    'the page disagreed with itself in dollars. Jarvis now refuses to generate '
    'when a row\'s quantity does not match its own weights; if it stops you, it '
    'has found something real.', stop=True)

h2('Proforma')
figure('proforma',
       'Figure 6 — the Proforma tab. Three steps, starting with the consignee; '
       'saved proformas are listed below and can be reopened or deleted.')
p('A proforma is a quote, not a bill. Type a customer you have quoted before '
  'and the trade terms, port and item rates fill themselves in from what was '
  'agreed last time — check them rather than trusting them, because prices move '
  'and the memory does not know that.')
p('<b>SKIP — EDIT FULL FORM DIRECTLY</b> jumps past the three steps when you '
  'already know exactly what you are raising.')
story.append(PageBreak())

# ════════════════════════════════════════════════════════════════════════════
h1('7. Sending it')
p('Documents are generated first and sent second, deliberately. Nothing is '
  'emailed as a side effect of making it.')
p('From a sale, <b>Generate</b> walks three stops: choose the shape, look at '
  'the finished PDF, then read the draft email with the real address on it '
  'before pressing Send. You can stop at any of them.')
p('Jarvis can also send an already-generated set: <i>"send the documents for '
  'HMMU7060866"</i>. It finds the invoice and packing list on file, works out '
  'the customer from the invoice itself, and shows the address for a yes or no '
  'before anything goes.')

box('An email to a buyer cannot be recalled',
    'Read the address, not the name. The recipient is worked out through two '
    'lookups you cannot see — container to consignee, consignee to contact — '
    'and a wrong contact is invisible until the address is in front of you. '
    'A commercial invoice carries our prices; it going to the wrong company is '
    'not a small mistake.', stop=True)

rule()
h1('8. When something looks wrong')

h3('A container is missing from Margin')
p('It has a bill or an invoice but not both, or the booking and container '
  'numbers do not match exactly between the two. Check the spelling on each '
  'side.')

h3('"This sale still needs…"')
p('Generate refuses until the invoice number, customer, container number, '
  'weight, price and item description are all present. It lists the missing '
  'ones; fill them on the row and try again.')

h3('It refused to generate over the weights')
p('A row\'s stated quantity disagrees with its own gross and tare. That is the '
  'check described on page 6 and it is almost always right. Look at the row '
  'before overriding it.')

h3('A supplier appears twice with different spellings')
p('Use <b>CLEAN NAMES</b> on the Bills screen. It proposes one spelling and '
  'shows what it would change before changing anything.')

h3('Anything else')
p('Say which screen, what you pressed, and what it said — word for word if '
  'there was a message on the page. The exact wording is usually enough to find '
  'it immediately.')

# ════════════════════════════════════════════════════════════════════════════
def decorate(canvas, doc):
    canvas.saveState()
    if doc.page > 1:
        canvas.setFont('Helvetica', 7.6); canvas.setFillColor(MUTED)
        canvas.drawString(23*mm, 12*mm, 'Jarvis — Edge Metals manual')
        canvas.drawRightString(A4[0] - 23*mm, 12*mm, str(doc.page))
        canvas.setStrokeColor(RULE); canvas.setLineWidth(0.5)
        canvas.line(23*mm, 15.5*mm, A4[0] - 23*mm, 15.5*mm)
    canvas.restoreState()

doc = BaseDocTemplate(OUT, pagesize=A4, leftMargin=23*mm, rightMargin=23*mm,
                      topMargin=20*mm, bottomMargin=22*mm,
                      title='Jarvis — Edge Metals manual', author='Edge Metals Inc')
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id='f')
doc.addPageTemplates([PageTemplate(id='main', frames=[frame], onPage=decorate)])
doc.build(story)

missing = [k for k, v in FIGS.items() if not (v and os.path.isfile(os.path.join(SHOTS, v)))]
print(f'wrote {OUT}')
print(f'{os.path.getsize(OUT):,} bytes')
if missing:
    print('screenshots still to capture: ' + ', '.join(missing))
