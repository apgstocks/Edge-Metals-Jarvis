// Batch 2 — hand-curated from Apsara's full raw paste of the Shipments 2026
// Sheet's "Address" tab (2026-08-05, pasted directly into chat as tab-
// separated text — much wider/longer than the A1:P250 API range fetched for
// batch 1, which missed everything past column P and several rows below the
// visible range at the time). Same exclusion rules as batch 1 (see
// _sheet_addresses_curated.js's header): no bank/wire/SWIFT/routing/account
// data, no name-only fragments without a real street address, no duplicates
// of anything already in data/address_book.json.
//
// Real conflicts found this pass — per Apsara's explicit instruction
// ("if you find any discrepancy, just don't upload it"), these are NOT
// included below at all — noted here only as a record of what was excluded
// and why:
//   - "Dawon Alloy" appeared with a SECOND, different address (Hwasan
//     1-gil, Onsan-eup, Ulju-gun, Ulsan) — conflicts with the
//     "DAWON ALLOY CO.LTD." already stored (Injusandan-ro, Asan-si,
//     Chungcheongnam-do). EXCLUDED.
//   - "MGK INTERNATIONAL DWC LLC" appeared with a DIFFERENT PO Box (390667)
//     than the Doc-stored "MGK DWC LLC" (712900). EXCLUDED.
//   - Taewon: this paste shows the phone changed to 82-55-582-6181; the
//     stored Doc-sourced entry still has 82-55-583-6181 — not touched here
//     either way (the Doc is that entry's source of truth; fix it there if
//     the number really changed, then re-run sync-address-book.js).
//
// "Green Metal Recyclers Pte. Ltd." IS included — not a conflict about the
// same entity, just a real company with its own address that the Doc's
// "[MAPTRASCO/GREEN METAL/ABSHIEK]" alias group never actually stored.

module.exports = [
  { aliases: ['Advanced Atlantic Corp'], raw: '5158 Cliffwood Dr\nMontclair, CA-91764\nPH NO: 510-913-4526\nmeowater@gmail.com' },
  { aliases: ['Global Square(M)SDN BHD'], raw: 'Syed Abbas Sira Judeen, Operational Director, H/P: 0192294074\n41, Jalan 6/2, Taman Industri Selesa Jaya, Balakong, Selangor, Malaysia (Port Klang-west)\nTel : 03-8961 2919, Fax : 03-8961 3919' },
  { aliases: ['SENTHIL GLOBAL ENTERPRISE'], raw: 'REGISTRATION NO. : 201503326077 (SA0361085-M)\nSUITE 19-15B, LEVEL 19, CENTRO 8, JALAN BATU TIGA LAMA\n41300 KLANG, SELANGOR, MALAYSIA' },
  { aliases: ['DK METAL WORLD LIMITED', 'RS Resource Trading'], raw: 'FLAT I, 31/F LA ROSSA B COASTAL SKYLINE\n12 WATERFRONT ROAD\nTUNG CHUNG N.T. HONG KONG\nEMAIL - sales@rsresourcestrading.com' },
  { aliases: ['Shinyoung Nonferrous Metals Co., Ltd.', 'Joey'], raw: '9-26, Wajigongdan 1-gil, Goyeon-ri,\nUngchon-myeon, Ulju-gun, Ulsan, Korea\nTEL : 82-52-249-3670\nFAX : 82-52-249-3673' },
  { aliases: ['CM Trading Co.,Ltd.', 'Joey'], raw: '86, Deokpyeong-ro, Yongnam-myeon\nSeongju-gun, Gyeongsangbuk-do, Republic of Korea\nTel:+82-54-932-9593' },
  { aliases: ['CM GLOBAL CO., LTD', 'Joey'], raw: '1001, DONGWON-BIZ PLATFORM, 329, SEONGSEO-RO,\nDALSEO-GU, DAEGU, KOREA\nEmail: goodcmglobal@gmail.com' },
  { aliases: ['Sasaran Utama SDN BHD'], raw: 'N0.6 Jalan Korporat 1B/KU9, Kawasan Perindustrain Meru 42200,\nKlang, Malaysia\nTel : 011-271966224' },
  { aliases: ['RND INTERNATIONAL'], raw: '222 E. REDONDO BEACH BLVD\nGARDENA, CA, 90248 USA\nTEL: 1-310-808-0905' },
  { aliases: ['Sigma Recycling Inc'], raw: '5675 Jimmy Carter Blvd #598\nNorcross, GA-30071\nGaurav Choraria <Gaurav.Choraria@asc.geminitrade.com>' },
  { aliases: ['Texas Lines Transport LLC', 'Texas Lines'], raw: '2395 Mystic Shore Dr\nCedar Hill, TX 75104' },
  { aliases: ['Progressive Scrap Metals, Inc.', 'Progressive Metals'], raw: '1931 Mateo St\nLos Angeles, CA 90021' },
  { aliases: ["Freddy's auto recycling", 'Chicago-Freddy'], raw: '4148 W Division St. Chicago, IL 60651\nGio: 331 645 2350' },
  { aliases: ['HNSN'], raw: 'ATTN: DEEPAK KANOJIA\nA-206, OM DIVYA APARTMENT,\nNEXT TO SONA TALKIES / CINEMAX THEATRE,\nTRIKAMDAS ROAD, KANDIVALI (W), MUMBAI - 400067\nTEL: +91 88799 19460\n(OBL has to be sent to this address)' },
  { aliases: ['FINE TRADE LINK', 'Mohmedraza Varteji'], raw: 'PLOT NO. 69/D, BLOCK NO 59 PAIKEE,\nMAMSA, MOUJE MAMSA, TAL. GHOGHA,\nBHAVNAGAR, GUJARAT, INDIA 364110\nEMAIL: FINETRADELINK@YAHOO.COM' },
  { aliases: ['Green Metal Recyclers Pte. Ltd.'], raw: '2 Gambas Crescent, #09-20 Nordcom Two,\nSingapore 757044\nH/P: +65 9363 0956\nWebsite: www.gmrsg.com\n(broker tag: ABSHIEK — Doc\'s "MAPTRASCO/GREEN METAL/ABSHIEK" alias group only ever stored MAPTRASCO\'s own address; this is a real, different address for Green Metal Recyclers itself)' },
  { aliases: ['Yushi Shipping INC'], raw: 'Office No. 9007, 9th Floor, 221 River Street,\nHoboken, New Jersey 07030, USA\nAccount Email: usa.acc@yushishipping.com' },
  { aliases: ['KRISHNA METALS'], raw: 'PLOT 19 & 20, GONDAL HIGHWAY, NR KANGASIYANI CHOWKDI,\nLODIKA, DHOLARA, RAJKOT, 360024, INDIA\nPhone: +919987005885\nEmail: sales@krishnametals.co.in' },
  { aliases: ['Punjab steel syndicate'], raw: 'Plot No.06, 12 & 13, Survey No 84 Industrial\nplot B/H Rishi Kiran Farm House Village\nMeghpur Borichi Tal - Anjar Kutch, India' },
  { aliases: ['Ascorp Singapore Pte Ltd', 'Nik'], raw: '10, Anson Road, 30-12, International Plaza,\nSingapore-079903\nTel : 65 6222 0557' },
  { aliases: ['Franco Trucking Inc.'], raw: '1842 East 213th Street\nCarson, CA 90745\n(310) 866-0653\nfrancisco@francotruckinginc.com' },
  { aliases: ['AL QARYAN INTERNATIONAL DMCC'], raw: 'Plot No: JLT-PH 1-12, Platinum Tower,\nJumeirah Lake Towers, Dubai, UAE\nVAT Registration No: 100454021500003' },
  { aliases: ['DRM Iron & Metal LLC'], raw: '6444 E. Spring St\nLong Beach, CA 90815\nJose.srmironandmetal@gmail.com\ndavidm.drmironandmetal@gmail.com' },
  { aliases: ['REMETAL INTERNATIONAL, INC'], raw: '400 SPECTRUM CENTER DR, STE 1900\nIRVINE, CA 92618, USA\n(contact: Henry from Staz)' },
  { aliases: ['FAR EAST METALS, INC'], raw: '531 E, CARSON STREET, SUITE D\nCARSON, CA 90745\n(contact: Henry from Staz)' },
  { aliases: ['Featherlite Logistics LLC', 'Houston Trucking Company'], raw: '10711 Belshill St\nRichmond, TX-77407' },
  // "Pan Metal Korea (Hwaseong)" (phone/fax seen in this paste) folded
  // directly into batch 1's entry instead of duplicated here — having the
  // same alias set appear twice across the combined list caused a harmless
  // but confusing double-update (revert-then-refix) every run.
];
