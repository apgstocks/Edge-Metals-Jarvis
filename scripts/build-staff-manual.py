#!/usr/bin/env python3
# ── scripts/build-staff-manual.py — the yard staff manual, as a PDF ──────────
#
# Apsara, 2026-09-20: "Create a user manual on working of jarvis so tht i can
# give it to customer with screenshot and proper explanation wherever needed",
# reader: her own staff; screenshots: driven through Chrome against the live
# app; format: PDF.
#
# ── THE SCOPE IS WHAT A STAFF LOGIN CAN ACTUALLY REACH ──────────────────────
# Four screens: Loads, Inventory, Petty Cash, Trucker Bills. That is not a
# choice about what is interesting — it is what api.js's
# STAFF_ALLOWED_PATH_PREFIXES permits. Documenting Bills or Documents would be
# documenting a 403.
#
#   python3 scripts/build-staff-manual.py            # uses the newest shots
#   python3 scripts/build-staff-manual.py --out X.pdf
#
# Screenshots come from the Chrome session and are matched BY FILENAME below,
# so re-running after fresh captures needs the FIGS map updated and nothing
# else. A missing image is drawn as a labelled placeholder rather than
# silently skipped — a manual with a hole in it must look like one.

import sys, os, glob
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
                                Spacer, Image, KeepTogether, PageBreak, Table, TableStyle)
from PIL import Image as PILImage

# Paths are resolved RELATIVE to this file, not hard-coded: the same script
# runs on her Mac and in the sandbox, where the repo sits at two different
# absolute paths.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'Jarvis_Staff_Manual.pdf')
if '--out' in sys.argv:
    OUT = sys.argv[sys.argv.index('--out') + 1]

# Where the Chrome session drops its screenshots. Overridable, because that
# folder is a session path and will differ next time.
SHOTS = os.environ.get('JARVIS_SHOTS', '/sessions/nifty-youthful-lovelace/mnt/outputs')
FIGS = {
    'menu':     'screenshot-1789884487384-c3ccd166.jpg',
    'loads':    'screenshot-1789884261340-bba6dd58.jpg',
    'petty':    'screenshot-1789884500169-1c58b9a2.jpg',
    'trucker':  'screenshot-1789884473979-802c5959.jpg',
    'inventory':'screenshot-1789884717884-724b4ff5.jpg',
}

INK      = colors.HexColor('#1C1B19')
MUTED    = colors.HexColor('#5A5A55')
RULE     = colors.HexColor('#D8D5D0')
ACCENT   = colors.HexColor('#B4703A')
WARNBG   = colors.HexColor('#FBF3E7')
WARNLINE = colors.HexColor('#C98A2E')

def S(name, **kw):
    base = dict(fontName='Helvetica', fontSize=10.2, leading=15.4, textColor=INK,
                spaceAfter=7, alignment=TA_LEFT)
    base.update(kw)
    return ParagraphStyle(name, **base)

BODY   = S('body')
LEAD   = S('lead',   fontSize=11.6, leading=17.4, spaceAfter=11)
H1     = S('h1',     fontName='Helvetica-Bold', fontSize=21, leading=25, spaceBefore=4, spaceAfter=10)
H2     = S('h2',     fontName='Helvetica-Bold', fontSize=13.4, leading=17, spaceBefore=15, spaceAfter=6)
H3     = S('h3',     fontName='Helvetica-Bold', fontSize=11,   leading=14.5, spaceBefore=11, spaceAfter=4)
CAP    = S('cap',    fontSize=8.6, leading=11.6, textColor=MUTED, spaceBefore=4, spaceAfter=13)
BUL    = S('bul',    leftIndent=13, bulletIndent=3, spaceAfter=4)
EYE    = S('eye',    fontName='Helvetica-Bold', fontSize=8, leading=11, textColor=ACCENT, spaceAfter=3)
NOTE   = S('note',   fontSize=9.6, leading=14.2, textColor=INK)

story = []

def p(t, st=BODY):  story.append(Paragraph(t, st))
def h1(t):          story.append(Paragraph(t, H1))
def h2(t):          story.append(Paragraph(t, H2))
def h3(t):          story.append(Paragraph(t, H3))
def eyebrow(t):
    # .upper() BEFORE the markup, never after: uppercasing an HTML entity
    # turns &nbsp; into &NBSP;, which reportlab cannot resolve and prints
    # verbatim on the cover.
    story.append(Paragraph(t.upper(), EYE))
def gap(h=6):       story.append(Spacer(1, h))
def bullets(items):
    for i in items:
        story.append(Paragraph(i, BUL, bulletText='•'))
    gap(5)

def rule():
    t = Table([['']], colWidths=[165*mm], rowHeights=[0.7])
    t.setStyle(TableStyle([('BACKGROUND', (0,0), (-1,-1), RULE)]))
    story.append(Spacer(1, 6)); story.append(t); story.append(Spacer(1, 10))

def callout(title, text):
    """A boxed note. Used only where getting it wrong costs money or time."""
    inner = [[Paragraph(f'<b>{title}</b>', NOTE)], [Paragraph(text, NOTE)]]
    t = Table(inner, colWidths=[159*mm])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), WARNBG),
        ('LINEBEFORE', (0,0), (0,-1), 2.2, WARNLINE),
        ('LEFTPADDING', (0,0), (-1,-1), 9), ('RIGHTPADDING', (0,0), (-1,-1), 9),
        ('TOPPADDING', (0,0), (0,0), 8),    ('BOTTOMPADDING', (0,-1), (-1,-1), 8),
        ('TOPPADDING', (0,1), (-1,-1), 1),
    ]))
    story.append(Spacer(1, 5)); story.append(t); story.append(Spacer(1, 12))

def figure(key, caption, width=163*mm):
    """
    A screenshot with its caption, kept on one page. A figure split across a
    page break is a figure nobody matches to its words.
    """
    # isfile, not exists: a key with no filename yet joins to the DIRECTORY,
    # which exists — and then PIL raises IsADirectoryError halfway through the
    # build instead of drawing the placeholder this branch is for.
    name = FIGS.get(key) or ''
    path = os.path.join(SHOTS, name) if name else ''
    if not path or not os.path.isfile(path):
        # Visible hole, not a silent one.
        ph = Table([[Paragraph(f'<b>[ screenshot missing: {key} ]</b>', CAP)]],
                   colWidths=[width], rowHeights=[26*mm])
        ph.setStyle(TableStyle([('BOX', (0,0), (-1,-1), 0.8, WARNLINE),
                                ('ALIGN', (0,0), (-1,-1), 'CENTER'),
                                ('VALIGN', (0,0), (-1,-1), 'MIDDLE')]))
        story.append(KeepTogether([ph, Paragraph(caption, CAP)]))
        return
    iw, ih = PILImage.open(path).size
    img = Image(path, width=width, height=width * ih / iw)
    img.hAlign = 'LEFT'
    box = Table([[img]], colWidths=[width])
    box.setStyle(TableStyle([('BOX', (0,0), (-1,-1), 0.6, RULE),
                             ('LEFTPADDING', (0,0), (-1,-1), 0),
                             ('RIGHTPADDING', (0,0), (-1,-1), 0),
                             ('TOPPADDING', (0,0), (-1,-1), 0),
                             ('BOTTOMPADDING', (0,0), (-1,-1), 0)]))
    story.append(KeepTogether([box, Paragraph(caption, CAP)]))

# ════════════════════════════════════════════════════════════════════════════
# COVER
# ════════════════════════════════════════════════════════════════════════════
gap(52)
eyebrow('Edge Yard  ·  operations')
story.append(Paragraph('Jarvis', S('cover', fontName='Helvetica-Bold', fontSize=44,
                                   leading=48, spaceAfter=6)))
story.append(Paragraph('Yard staff manual', S('sub', fontSize=17, leading=22,
                                              textColor=MUTED, spaceAfter=22)))
rule()
p('This is the guide to the four screens you use every day: recording a load, '
  'checking what is on hand, the cash box, and what the yard owes its hauliers. '
  'It is written for the people doing the work, not for the office.', LEAD)
p('Everything in here you can do yourself. Anything not in here is either not '
  'yours to change or does not exist — and there is a short list at the back of '
  'what to do when the screen tells you something is wrong.', LEAD)
gap(16)
p('<b>September 2026</b> · Edge Yard', CAP)
story.append(PageBreak())

# ════════════════════════════════════════════════════════════════════════════
h1('1. Signing in, and what you will see')
p('Jarvis runs in a web browser. Open <b>jarvis.edgemetals.com</b> and sign in '
  'with the password you were given. If the page asks again after you have '
  'typed it, the password is wrong — it does not lock you out, so try again.')
p('Your sign-in is a <b>staff</b> login. That matters: it decides which screens '
  'you can open, and it is deliberate rather than a lack of trust. The yard runs '
  'on what you record; the pricing, margins and customer invoices are a separate '
  'job with separate consequences.')

h2('The menu')
p('Tap the three-line button at the top left to open the menu, and tap it again '
  'to close it. The menu slides over the page rather than pushing it aside, so '
  'nothing moves under your finger while you are reading.')
figure('menu',
       'Figure 1 — the menu. Your four screens are the top of the EDGE YARD '
       'group: Loads, Inventory, Petty Cash, Trucker Bills.')

callout('The four screens that are yours',
        '<b>Loads</b>, <b>Inventory</b>, <b>Petty Cash</b> and <b>Trucker Bills</b>. '
        'Other names may appear in your menu — Board, Bookings, Bills, Invoice, '
        'Documents, Truckers, Suppliers, Bot, Tasks. Those belong to the office '
        'side of the business and will refuse to open for a staff login, with a '
        'message saying access is limited to Loads. That is not a fault, and '
        'nothing you did caused it. Ignore them.')

story.append(PageBreak())

# ════════════════════════════════════════════════════════════════════════════
h1('2. Loads — the main job')
p('A <b>load</b> is one delivery: someone brings metal in, it is weighed, and '
  'they are paid. Everything else in the yard is counted from these records, so '
  'a load entered properly is the whole job done.')
figure('loads',
       'Figure 2 — the Loads screen. The four figures at the top are today\'s '
       'running totals; below them the loads are grouped by day, newest first.')

h2('Reading the top of the screen')
bullets([
  '<b>loads</b> — how many are recorded in total.',
  '<b>net weight</b> — the metal, after the truck and any containers are taken off.',
  '<b>bought</b> — money paid out to sellers.',
  '<b>sold</b> — money taken in from buyers.',
])
p('<b>ALL / PURCHASES / SALES</b> under those figures filters the list. Most of '
  'what you enter is a purchase — metal coming in. A sale is metal going back '
  'out to a buyer.')

h2('Recording a load')
p('Use <b>+ CREATE INVOICE</b> for metal coming <i>in</i>, and <b>+ SALE</b> for '
  'metal going <i>out</i>. The two forms look the same; only the direction of the '
  'money differs, so check the heading at the top of the form before you start '
  'typing.')

h3('The weights')
p('Each item needs three numbers, and Jarvis works out the third for you:')
bullets([
  '<b>Gross</b> — everything on the scale: the metal, the truck, the bins.',
  '<b>Tare</b> — the empty weight, taken off the gross.',
  '<b>Net</b> — what you are actually paying for. <b>Filled in for you.</b>',
])
p('You cannot type into Net, and that is on purpose: the amount is worked out '
  'from it, and a net weight typed by hand is the one number nobody can check '
  'later.')

h3('Price and amount')
p('Type the price per pound and the <b>Amount</b> fills itself in. If you already '
  'know the agreed total, type it into Amount instead and leave the price blank — '
  'either way round works.')
p('<b>+ ADD ITEM</b> adds another line when one truck brings two different '
  'grades. Each line gets its own weights and its own price, and the TOTAL row '
  'adds them up.')

callout('It saves as you type',
        'The form says <i>"Autosaves as soon as you enter an item"</i> and it means '
        'it. If the phone dies or the page closes halfway through, what you had '
        'entered is already recorded — reopen it and carry on. You do not need to '
        'start again, and you should not re-enter a load because you are unsure, '
        'because that creates a second one.')

story.append(PageBreak())

h2('After the load is recorded')
p('Each load appears as a card with the seller\'s name, the date, its reference '
  '(EDGE_77 and so on), the weights, and what was paid. The green '
  '<b>PAID</b> mark shows the money went out and when.')
h3('The buttons on a card')
bullets([
  '<b>View PDF</b> — the ticket for that load, as the seller sees it.',
  '<b>Print (POS receipt)</b> — the small till-roll receipt for the yard printer.',
  '<b>Regenerate PDF</b> — rebuild the ticket after an edit. Use it if you '
  'corrected a weight and the PDF still shows the old one.',
  '<b>Send to seller (WhatsApp)</b> — sends them their ticket.',
  '<b>Edit</b> — reopen the load and correct it.',
])
p('<b>PDF READY</b> in the corner means the ticket has been made. If it is '
  'missing after you finish a load, press Regenerate PDF.')

callout('Correct it, do not re-enter it',
        'If a weight or a price is wrong, press <b>Edit</b> on that load and fix '
        'the number. Entering the load a second time does not replace the first — '
        'it adds a second one, and the yard then shows metal it does not have and '
        'money it did not pay. If you cannot see how to correct something, leave '
        'it and tell the office.')

story.append(PageBreak())

# ════════════════════════════════════════════════════════════════════════════
h1('3. Inventory — what is on hand')
p('Inventory is not something you fill in. It is counted, live, from every load '
  'on record: what came in, minus what has gone out. Delete a load and its metal '
  'leaves the inventory with it.')
figure('inventory',
       'Figure 3 — Inventory, grouped by item type. The tabs above the table '
       'switch between BY ITEM TYPE, PER DAY and PER SELLER.')
h2('Reading it')
bullets([
  '<b>Items</b> — how many separate loads included that grade.',
  '<b>Gross / Tare / Net in</b> — the weights, added up across those loads.',
  '<b>Shipped</b> — how much has gone back out.',
  '<b>On hand</b> — what should be sitting in the yard right now.',
  '<b>Amount</b> — what that metal cost.',
])
p('<b>FROM</b> and <b>TO</b> at the top limit it to a date range. Leave them '
  'empty for everything.')

callout('A red on-hand figure with a warning triangle',
        'It means Jarvis has been told more metal went out than ever came in — '
        'so either a load was never recorded, or one was recorded under the wrong '
        'grade. It is not a rounding error and it will not correct itself. Tell '
        'the office the item type and the figure; do not try to balance it by '
        'adding a load.')

story.append(PageBreak())

# ════════════════════════════════════════════════════════════════════════════
h1('4. Petty Cash — the cash box')
p('This is the physical cash in the yard. The figure at the top is what should '
  'be in the box right now, and it is the number to check against when you count '
  'it.')
figure('petty',
       'Figure 4 — Petty Cash. Money in is green and positive; money out is red '
       'and negative.')
h2('The two kinds of line')
bullets([
  '<b>Cash added</b> — money put into the box. Recorded with <b>+ ADD CASH</b>.',
  '<b>Paid — EDGE_76</b> — money that left the box to pay a load. These appear '
  'on their own when you pay a seller in cash; you do not enter them here.',
])
p('<b>DELETE</b> appears only beside cash you added, and only to undo a mistake '
  'made entering it. A payment against a load cannot be deleted here — that is '
  'corrected on the load itself.')

callout('Count the box against this figure, not against memory',
        'If the box and the screen disagree, say so the same day and say by how '
        'much. A difference found on the day is a mistake somebody can still '
        'remember; the same difference found next month is an argument.')

story.append(PageBreak())

# ════════════════════════════════════════════════════════════════════════════
h1('5. Trucker Bills — what the yard owes hauliers')
p('When a haulier invoices the yard for moving a load, it is recorded here, and '
  'what has been paid against it is tracked alongside.')
figure('trucker',
       'Figure 5 — Trucker Bills with nothing recorded yet. The three figures '
       'stay at zero until the first bill is added.')
h2('Adding a bill')
p('<b>+ ADD BILL</b> takes the haulage company, the date, their ticket or '
  'invoice number, and the amount. The three figures at the top then show '
  '<b>billed</b>, <b>paid</b> and <b>outstanding</b>.')
p('<b>Outstanding</b> is the one that matters: it is what the yard still owes. '
  'If a driver says he has not been paid, this screen is the answer — and if '
  'it shows paid and he disagrees, that is for the office, not an argument at '
  'the gate.')

story.append(PageBreak())

# ════════════════════════════════════════════════════════════════════════════
h1('6. When something looks wrong')
p('Most of what follows is not a fault. Knowing which is which saves a phone '
  'call.')

h3('"Staff access is limited to Loads"')
p('You opened one of the office screens. Nothing is broken and you have done '
  'nothing wrong. Go back to the menu and pick one of your four.')

h3('The page is slow to open')
p('The bigger screens fetch everything at once. Give it a few seconds before '
  'pressing again — pressing twice does not make it faster, and on a form it can '
  'record the same thing twice.')

h3('A load will not save')
p('Check you have a seller name and at least one item with a weight. If it still '
  'refuses, write down what you entered before you close the page, so it can be '
  'entered once and correctly.')

h3('The PDF shows old numbers')
p('Press <b>Regenerate PDF</b> on that load. The ticket is made once and kept; '
  'editing the load does not rebuild it automatically.')

h3('Something is wrong and none of the above fits')
p('Say what screen you were on, what you pressed, and what it said — word for '
  'word if there was a message. "It is not working" cannot be acted on; '
  '"Loads, pressed Regenerate PDF, said file not found" can be fixed in minutes.')

rule()
h2('What you cannot do, and why')
p('A staff login cannot open supplier pricing, customer invoices, margins or the '
  'document generator. This is not about trust. Those screens decide what a '
  'customer is charged and what a supplier is owed, and a mistaken keystroke '
  'there leaves the yard rather than staying in it. Your four screens are where '
  'the yard\'s real record lives — if they are right, everything downstream is '
  'right.')

# ════════════════════════════════════════════════════════════════════════════
# PAGE FURNITURE
# ════════════════════════════════════════════════════════════════════════════
def decorate(canvas, doc):
    canvas.saveState()
    if doc.page > 1:
        canvas.setFont('Helvetica', 7.6)
        canvas.setFillColor(MUTED)
        canvas.drawString(23*mm, 12*mm, 'Jarvis — Yard staff manual')
        canvas.drawRightString(A4[0] - 23*mm, 12*mm, str(doc.page))
        canvas.setStrokeColor(RULE); canvas.setLineWidth(0.5)
        canvas.line(23*mm, 15.5*mm, A4[0] - 23*mm, 15.5*mm)
    canvas.restoreState()

doc = BaseDocTemplate(OUT, pagesize=A4,
                      leftMargin=23*mm, rightMargin=23*mm,
                      topMargin=20*mm, bottomMargin=22*mm,
                      title='Jarvis — Yard staff manual', author='Edge Yard')
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id='f')
doc.addPageTemplates([PageTemplate(id='main', frames=[frame], onPage=decorate)])
doc.build(story)

missing = [k for k, v in FIGS.items() if not (v and os.path.isfile(os.path.join(SHOTS, v)))]
print(f'wrote {OUT}')
print(f'{os.path.getsize(OUT):,} bytes')
if missing:
    print('screenshots still to capture: ' + ', '.join(missing))
