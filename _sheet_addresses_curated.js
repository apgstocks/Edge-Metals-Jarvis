// Hand-curated from the "Addresses_2026" / "Addresses" / "Address" tabs of
// https://docs.google.com/spreadsheets/d/1QsCeuqeRKODuouzO2PfKbxG9qJpN8yAbIurSzhI--6s
// (2026-08-05). NOT auto-parsed — those tabs are a free-form, multi-column
// scratchpad with no consistent layout, real bank wire/SWIFT/routing/account
// numbers mixed into the same cells as addresses, and near-duplicate blocks
// scattered across the three tabs (later tabs are edited copies of earlier
// ones). Given the address-book merge logic already had one real bug found
// via live data this session (helpers/addressBook.js's mergeEntries — see
// its own comment), a blind heuristic column-parser over THIS much messier
// source was judged too risky; every entry below was read and transcribed
// by hand instead.
//
// Deliberately EXCLUDED:
//  - Anything that's Edge Metals' OWN bank wire/routing/SWIFT/account info
//    (several rows mix "BENEFICIARY ADDRESS"/"SWIFT CODE"/"Routing Number"
//    into the same cell as a real company address — only the address text
//    is kept where that happened, e.g. "Pan Metal Korea (Hwaseong)" below).
//  - "EDGE TRADING INC" and "Highland Hills Automotive" bank/self-entity
//    rows, "COMMODITY CONNECT CORPARATE" (no real street address, just a
//    name fragment), "Patricia Aquino/Paraguay" (email only, no address),
//    "Annie Lee/Shinhan Bank America" and "Sun Hwa Kim/Industrial Bank of
//    Korea" (both wire-transfer intermediary bank contacts, not addresses).
//  - Anything that's a duplicate of an entry already synced from the Doc:
//    Hugo/Highland Hills (8825 New Laredo Hwy), A-Tech (Korea address),
//    Junk Car Jose (1815 Connorvale Rd), Soline Metal (2301 Dupont Dr),
//    Haekwang Metal / Pan Metal-HK (208-7 Saengcheol-ri), G&C Recycling
//    (11949 Suburban Rd), Dae Kwang Industries / Joey-Daekwang (98-3 Jangam
//    4-gil) — all same address already in data/address_book.json from the
//    Google Doc sync.
//
// "Pan Metal Korea (Hwaseong)" is deliberately NOT aliased "Pan Metal" —
// the Doc already has a DIFFERENT real company (Haekwang Metal) under
// "Pan Metal/HK". Sharing a generic alias between two real, different
// companies is fine (see the Joey/Taewon vs Joey/Daekwang precedent —
// resolveAddress() surfaces that as ambiguous rather than guessing), but
// there's no reason to force a collision here when a clearer label works.
// "Yeon Seong Co Ltd" IS deliberately given the shared alias "Joey" — it's
// a genuine third company brokered by the same "Joey" contact as Taewon and
// Daekwang in the Doc, same real-world pattern.

module.exports = [
  { aliases: ['TONGYA ALUMINUM INDUSTRY(USA) CO., LTD.'], raw: '17890 CATLETON STREET, SUITE 265 CITY OF INDUSTRY, CA 91748 U.S.A.\nTEL : +1-626-581-4980 / FAX : +1-626-581-4979' },
  { aliases: ['OUTLAST'], raw: '8303 Hansen Road\nHouston, TX 77075' },
  { aliases: ['Spectro'], raw: '13220 Doyle Path East\nRosemount, MN 55068' },
  { aliases: ['A&K DASO LLC'], raw: '3810 Wilshire Blvd Suite 512\nLA, CA 90010\nTel: 714-615-5990' },
  { aliases: ['NUR METALS'], raw: '22315 McCleskey Road\nNew Caney, TX 77357\n714 718 2150' },
  { aliases: ['ALTECHNO METAL CO.LTD'], raw: '28-304, BUGOKGONGDAN 4-GIL,\nDANGJIN-SI, CHUNGNAM, KOREA 343-827\nTEL: 82 41 357 9892-5' },
  { aliases: ['Aluzen Co., Ltd.'], raw: '123-98, Seokpo-ro, Jang-an-myeon,\nHwaseong-si, Gyeonggi-do, Korea\nTel : 031-384-2384\nFax : 031-359-9006' },
  { aliases: ['COREA ALUMINUM CO.,LTD.'], raw: "39-13, Jeokseongsandan 1-ro, Jeokseong-myeon, Paju-si,\nGyeonggi-do, Korea\nT: 82-31-958-4502  F: 82-31-958-4505" },
  { aliases: ['DAE JIN LIGHT METAL CO., LTD'], raw: '1077-3 NAESAM-RI, JUCHON-MYEN,\nGIMHAE-CITY, GYUNG NAM, KOREA' },
  { aliases: ['Midland Metal Recycling Inc', 'Flippe'], raw: '7750 47th Street\nLyons, IL 60534\n1 7736326363' },
  { aliases: ['Inesh yard'], raw: '760 North Mission Road\nLos Angeles, CA 90033\n1(323)617-1425' },
  { aliases: ['2nd yard Inesh', 'Inesh 2nd yard'], raw: '126 S Mission Rd,\nLos Angeles, CA 90033' },
  { aliases: ['Calderon'], raw: '2113 East 90th Street\nLos Angeles, CA 90002' },
  { aliases: ['Eccomelt'], raw: '6605 Rankin Road\nHumble, TX 77396\n1(888)356945' },
  { aliases: ['Dong-A Metal Co., Ltd.'], raw: '1269-1, Songhyun-ri, Jinrei-myon, Kimhae City, Kyongnam, Korea\nTel : 055-346-3631, Fax : 055-346-3696' },
  { aliases: ['Chuan Kai Aluminum Co.,LTD'], raw: 'No. 74 Sec. 2, Zhongshan Rd., Hunei Dist., Kaohsiung city, Taiwan\nTel: +886-7-699-0878\nContact: Edison Chen' },
  { aliases: ['Hanyung Metal Co., LTD'], raw: '#11 CHEOYONG SANEUP 1GIL,\nONSAN EUP, ULJU GUN,\nULSAN CITY, SOUTH KOREA' },
  { aliases: ['HYUNKWANG METAL CO., LTD.'], raw: 'Gomo-ro 134beon-gil, Jillye-myeon, Gimhae-si, Gyeongsangnam-do,\nRepublic of Korea\nTEL : 82 55 322 1581, FAX : 82 55 322 1583' },
  { aliases: ['HIHO METAL CO., LTD'], raw: '8TH FLOOR, DONGNAM BUILDING,\n588-19, SINSSA-DONG, GANGNAM-GU,\nSEOUL, KOREA' },
  { aliases: ['HKM Co. Ltd'], raw: '20, Mukbang-ro 120beon-gil,\nSangdong-myeon, Gimhae-si,\nGYEONGSANGNAM-DO, Korea\nTel:+8255 323 9858\nFax: +8255 323 9861' },
  { aliases: ['HOKYUNG CO. LTD'], raw: '1096-11 NAJEON-RI, SAENGNIM-MYEON,\nKIMHAE-CITY, KYUNGNAM,\nKOREA.\nTEL : 055-329-6195~8\nFAX : 055-329-6199' },
  { aliases: ['Indicaa USA Inc.'], raw: '6420, Suite 530-06,\nRichmond Ave.,\nHouston, Texas 77057' },
  { aliases: ['KAINAN METALS INDUSTRIES CO.,LTD.'], raw: '43,MIN TZU RD.\nKANG CHIEN VILL HSIN SZU HSIANG,\nTAINAN HSIEN,TAIWAN.\nTEL: 06-5994751 FAX: 06-5995707' },
  { aliases: ['KWANG MYUNG METAL CO., LTD.'], raw: '123, HAKSANG-1GIL, GASAN-MYEON,\nCHILGOK-GUN, GYEONGSANGBUK-DO, KOREA\nTEL : 82-54-971-2161' },
  { aliases: ['Pan Metal Korea (Hwaseong)'], raw: '720-7, Chorok-ro, Yanggam-myeon,\nHwaseong-si, Gyeonggi-do, Korea\nTel : 031-384-2384\nFax : 031-384-2385' },
  { aliases: ['Pan Korea Co., Ltd.'], raw: "2210-1, O'Biztower, 126, Beolmal-ro,\nDongan-gu, Anyang-si,\nGyeonggi-do, Korea\nPhone : 82-31-384-2384\nFax : 82-31-384-2385" },
  { aliases: ['SHIN WEN CHING METAL ENT. COMPANY LTD'], raw: 'NO. 55, MING CHU ST., SHOU SHUIHSIANG\nCHANGHUA, TAIWAN.' },
  { aliases: ['SA METAL CO., LTD'], raw: '22, MAJUNG 2-RO, SEO-GU,\nINCHEON,KOREA' },
  { aliases: ['SUNG AM METAL CO., LTD'], raw: '15, Bodeum 1-ro, Seo-gu, Incheon, Korea\nT 82-32-562-7304\nF 82-32-562-7305\n(current address — updated 10/04/2018, supersedes an older Gimpo-si address on file)' },
  { aliases: ["TAEHWA INT'L TRANSPORT INC."], raw: "6Fl, Taechang Bldg., 77, Dangsan-ro, Yeongdeungpo-gu, Seoul, 07264 Korea\nTel No: +82-2-2006-7500 (Direct No.7662) Fax No: +82-2-2672-7000" },
  { aliases: ['WOOSHIN METAL CO., LTD'], raw: '17, Cheoyongsaneop 2 gil, Onsan-eup,\nUlju-gun, Ulsan, Korea\nTEL: 82-52-238-3133\nFAX:82-52-238-3118' },
  { aliases: ['YU LAI METAL CO.,LTD'], raw: '36 JING CHIN ROAD, TONG HAI,\nFANG LIAO PING TONG TAIWAN,R.O.C\nTel: +886-88671036\nFax: +886-88671038' },
  { aliases: ['SEA JU ING CO. LTD'], raw: '1079 - 7, NAESAMRI JUCHONMYEON,\nGIMHAE-CITY, GYUNGNAM, KOREA' },
  { aliases: ['Sanlee Imports Inc.'], raw: '1550 Technology Drive\nUnit 4103\nSan Jose, CA 95110' },
  { aliases: ['SAMWOO ALLOY IND.'], raw: '201, 6Ba, Sihwa industrial complex, Sunggok-dong, Danwon-gu,\nAnsan-City, Korea' },
  { aliases: ['Dong Nam Co., LTD'], raw: '371-2, NAMYANG DONG, JINHAE CITY,\nKYUNGNAM, KOREA\nTEL: 82-55-552-3817 FAX: 82-55-552-4792' },
  { aliases: ['YEON SEONG CO. LTD', 'Joey'], raw: '198 WALCHON-GONGDANRO\nGUNBUK-MYEON HAMAN-GUN\nGYEONGSANGNAM-DO,KOREA\nTEL : 82-55-800-7477\nFAX : 82-55-585-2912' },
  { aliases: ['Mario yard OKLAHOMA'], raw: '905 SW 21st St,\nOklahoma City, OK 73108' },
  { aliases: ['Mazariegoes', 'Rudy'], raw: '1050 Brookside Drive\nRichmond, CA 94801' },
  { aliases: ['DAWON ALLOY CO.LTD.'], raw: '123-90, Injusandan-ro, Inju-myeon,\nAsan-si, Chungcheongnam-do,\nRepublic of Korea\nT: 82-41-531-9611\nF: 82-41-531-9655' },
  { aliases: ['DOO IN CO.LTD', 'DOOIN CO., LTD.'], raw: '1091-14, NAJUN-RI, SAENGNIM-MYEON\nGIMHAE-SI,GYEONGNAM, KOREA' },
  { aliases: ['DAEMYUNG IND.CO.,LTD'], raw: 'NO.93, NAJEON-RO,SAENGNIM-MYEUN\nGIMHAE-CITY,GYEONGSANGNAM-DO\nSOUTH KOREA' },
];
